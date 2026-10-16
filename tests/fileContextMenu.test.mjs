import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, rename, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';

const calls = [], notices = [], menus = [];
globalThis.__fileMenu = { calls, notices, menus, mac: true };
globalThis.window = { require(name) {
 assert.equal(name, 'electron');
 return { clipboard: { writeText: value => calls.push(['copy', value]) }, shell: {
  showItemInFolder: value => calls.push(['reveal', value]),
  async openExternal(value) { calls.push(['external', value]); },
  async trashItem(value) { calls.push(['trash', value]); if (globalThis.__fileMenu.trashError) throw globalThis.__fileMenu.trashError;
   await rename(value, path.join(trash, path.basename(value))); }
 } };
} };
const bundle = await build({ entryPoints: ['src/fileContextMenu.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
 plugins: [{ name: 'native-actions', setup(api) {
  api.onResolve({ filter: /^(obsidian|child_process)$/ }, args => ({ path: args.path, namespace: 'shim' }));
  api.onLoad({ filter: /.*/, namespace: 'shim' }, args => ({ loader: 'js', contents: args.path === 'child_process'
   ? `export function execFile(command, args, done) { globalThis.__fileMenu.calls.push(['exec', command, args]); done(globalThis.__fileMenu.execError ?? null, { stdout: command === '/usr/bin/osascript' ? globalThis.__fileMenu.browser : '', stderr: '' }); }`
   : `export const Platform = { get isMacOS() { return globalThis.__fileMenu.mac; } };
      export class Notice { constructor(text) { globalThis.__fileMenu.notices.push(text); } }
      export class Menu {
       items = [];
       constructor() { globalThis.__fileMenu.menus.push(this); }
       addSeparator() { this.separator = true; }
       addItem(fn) { const item = { setTitle(title) { this.title = title; return this; }, setIcon() { return this; }, setDisabled(disabled) { this.disabled = disabled; return this; }, onClick(click) { this.click = click; return this; } }; fn(item); this.items.push(item); }
       showAtMouseEvent(event) { this.mouse = event; }
       showAtPosition(position) { this.position = position; }
      }` }));
 } }] });
const { runFileAction, showFileContextMenu, createEntry } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const root = await mkdtemp(path.join(os.tmpdir(), 'so-file-actions-'));
const trash = path.join(root, '.test-trash');
await mkdir(trash);
const directory = path.join(root, 'space \'quote" $dollar; $(echo unsafe)');
const file = path.join(directory, 'a.ts');
await mkdir(directory);
await writeFile(file, 'export {};');
test.after(() => rm(root, { recursive: true, force: true }));
test.beforeEach(() => { calls.length = notices.length = menus.length = 0; globalThis.__fileMenu.mac = true; globalThis.__fileMenu.execError = null; globalThis.__fileMenu.trashError = null; globalThis.__fileMenu.browser = '/Applications/Google Chrome.app\n'; });

test('copy and reveal preserve the exact absolute path, including shell metacharacters', async () => {
 await runFileAction('copy', file);
 await runFileAction('reveal', file);
 await runFileAction('reveal', directory);
 assert.deepEqual(calls, [['copy', file], ['reveal', file], ['reveal', directory]]);
});

test('Terminal receives the folder or file parent as one argument; directory symlinks work', async () => {
 const link = path.join(root, 'directory-link');
 await symlink(directory, link);
 await runFileAction('terminal', file);
 await runFileAction('terminal', directory);
 await runFileAction('terminal', link);
 assert.deepEqual(calls, [directory, directory, link].map(value => ['exec', '/usr/bin/open', ['-a', 'Terminal', value]]));
});

test('missing paths never launch Finder or Terminal; stale paths can still be copied', async () => {
 const missing = path.join(root, 'deleted');
 await assert.rejects(runFileAction('reveal', missing));
 await assert.rejects(runFileAction('terminal', missing));
 assert.deepEqual(calls, []);
 await runFileAction('copy', missing);
 assert.deepEqual(calls, [['copy', missing]]);
});

test('native menu uses the clicked path and reports both copy success and launch errors', async () => {
 const selection = { path: file, isDirectory: false }, event = { clientX: 120, clientY: 80 };
 showFileContextMenu(selection, event, {}, root);
 const menu = menus.at(-1);
 assert.deepEqual(menu.items.map(item => item.title), ['Copy path', 'Copy relative path', 'Reveal in Finder', 'Open in terminal', 'Delete']);
 assert.equal(menu.mouse, event);
 await menu.items[0].click();
 assert.deepEqual(calls, [['copy', file]]);
 assert.deepEqual(notices, ['Path copied.']);
 globalThis.__fileMenu.execError = new Error('Terminal unavailable');
 await menu.items[3].click();
 assert.equal(notices.at(-1), 'Could not open Terminal for this path.');
 selection.path = path.join(root, 'missing');
 await menu.items[2].click();
 assert.match(notices.at(-1), /Could not reveal/);
});

test('caller items such as tab closing come first, separated from the file actions', () => {
 showFileContextMenu({ path: file, isDirectory: false }, { clientX: 0, clientY: 0 }, {}, root,
  { addLeadingItems: menu => menu.addItem(item => item.setTitle('Close others')) });
 const menu = menus.at(-1);
 assert.deepEqual(menu.items.map(item => item.title), ['Close others', 'Copy path', 'Copy relative path', 'Reveal in Finder', 'Open in terminal', 'Delete']);
 assert.equal(menu.separator, true);
});

test('keyboard menu anchors to the row and Terminal is disabled outside macOS', async () => {
 globalThis.__fileMenu.mac = false;
 showFileContextMenu({ path: file, isDirectory: false }, { key: 'ContextMenu' }, { getBoundingClientRect: () => ({ left: 20, bottom: 40 }) }, root);
 const menu = menus.at(-1);
 assert.deepEqual(menu.position, { x: 36, y: 40 });
 assert.equal(menu.items[2].title, 'Reveal in file explorer');
 assert.equal(menu.items[3].disabled, true);
 await assert.rejects(runFileAction('terminal', file), /macOS/);
 assert.deepEqual(calls, []);
});

test('HTML files open in the default browser, not the app bound to .html', async () => {
 const page = path.join(directory, 'Report $(echo unsafe).HTML');
 await writeFile(page, '<p>report</p>');
 showFileContextMenu({ path: page, isDirectory: false }, { clientX: 0 }, {}, root);
 const item = menus.at(-1).items.find(entry => entry.title === 'Open in browser');
 await item.click();
 assert.deepEqual(calls.map(call => call.slice(0, 2)), [['exec', '/usr/bin/osascript'], ['exec', '/usr/bin/open']]);
 assert.deepEqual(calls[1][2], ['-a', '/Applications/Google Chrome.app', page]);
 assert.deepEqual(notices, []);
 for (const selection of [{ path: file, isDirectory: false }, { path: path.join(root, 'site.html'), isDirectory: true }]) {
  showFileContextMenu(selection, { clientX: 0 }, {}, root);
  assert.equal(menus.at(-1).items.some(entry => entry.title === 'Open in browser'), false);
 }
});

test('without a default browser, or outside macOS, HTML opens as a file URL; missing files open nothing', async () => {
 const page = path.join(root, 'page.htm');
 await writeFile(page, '<p>page</p>');
 globalThis.__fileMenu.browser = '';
 await runFileAction('browser', page);
 globalThis.__fileMenu.mac = false;
 await runFileAction('browser', page);
 const url = new URL(`file://${page}`).href;
 assert.deepEqual(calls, [['exec', '/usr/bin/osascript', calls[0][2]], ['external', url], ['external', url]]);
 calls.length = 0;
 await assert.rejects(runFileAction('browser', path.join(root, 'gone.html')));
 assert.deepEqual(calls, []);
 showFileContextMenu({ path: path.join(root, 'gone.html'), isDirectory: false }, { clientX: 0 }, {}, root);
 await menus.at(-1).items.find(entry => entry.title === 'Open in browser').click();
 assert.deepEqual(notices, ['Could not open this file in the browser.']);
});

test('relative copying uses the menu project root, including folders and the root itself', async () => {
 const selection = { path: file, isDirectory: false }, event = { clientX: 0, clientY: 0 };
 showFileContextMenu(selection, event, {}, root);
 const projectMenu = menus.at(-1);
 showFileContextMenu(selection, event, {}, directory);
 const nestedMenu = menus.at(-1);
 await projectMenu.items[1].click();
 await nestedMenu.items[1].click();
 await runFileAction('copy-relative', directory, root);
 await runFileAction('copy-relative', root, root);
 assert.deepEqual(calls, [['copy', path.relative(root, file)], ['copy', 'a.ts'], ['copy', path.basename(directory)], ['copy', '.']]);
 await assert.rejects(runFileAction('copy-relative', file), /project root/);
});

test('Delete moves a file to trash before refreshing the view; the open folder itself has no Delete', async () => {
 showFileContextMenu({ path: root, isDirectory: true }, { clientX: 0 }, {}, root);
 assert.equal(menus.at(-1).items.some(item => item.title === 'Delete'), false);
 const target = path.join(directory, 'delete me.ts');
 await writeFile(target, 'recoverable content');
 let refreshed = false;
 showFileContextMenu({ path: target, isDirectory: false }, { clientX: 0 }, {}, root, { onDeleted: async (deleted, project) => {
  assert.equal(deleted, target); assert.equal(project, root);
  await assert.rejects(lstat(target), { code: 'ENOENT' });
  refreshed = true;
 } });
 const menu = menus.at(-1);
 assert.equal(menu.separator, true);
 await menu.items.at(-1).click();
 assert.equal(refreshed, true);
 assert.deepEqual(calls, [['trash', target]]);
 assert.equal(await readFile(path.join(trash, 'delete me.ts'), 'utf8'), 'recoverable content');
 assert.deepEqual(notices, ['File moved to trash.']);
});

test('folder Delete asks first, then trashes the folder with its contents and refreshes the view', async () => {
 const folder = path.join(root, 'folder to delete');
 await mkdir(path.join(folder, 'nested'), { recursive: true });
 await writeFile(path.join(folder, 'nested', 'kept.ts'), 'recoverable');
 const asked = [], deleted = [];
 let answer = false;
 showFileContextMenu({ path: folder, isDirectory: true }, { clientX: 0 }, {}, root, {
  confirmFolderDelete: async target => { asked.push(target); return answer; },
  onDeleted: async (target, project) => { deleted.push([target, project]); },
 });
 const deleteItem = menus.at(-1).items.at(-1);
 assert.equal(deleteItem.title, 'Delete');
 await deleteItem.click();
 assert.deepEqual(asked, [folder]);
 assert.deepEqual(calls, []);
 assert.equal((await lstat(folder)).isDirectory(), true);
 answer = true;
 await deleteItem.click();
 assert.deepEqual(calls, [['trash', folder]]);
 assert.deepEqual(deleted, [[folder, root]]);
 assert.equal(await readFile(path.join(trash, 'folder to delete', 'nested', 'kept.ts'), 'utf8'), 'recoverable');
 assert.deepEqual(notices, ['Folder moved to trash.']);
 const replaced = path.join(root, 'replaced');
 await writeFile(replaced, 'file now');
 calls.length = 0;
 await assert.rejects(runFileAction('delete-folder', replaced, root), /Only folders/);
 await assert.rejects(runFileAction('delete-folder', root, root), /outside the project root/);
 assert.deepEqual(calls, []);
});

test('Delete rejects directories, missing paths, outside paths and symlinked outside parents', async () => {
 const outside = await mkdtemp(path.join(os.tmpdir(), 'so-outside-'));
 try {
  const externalFile = path.join(outside, 'external.ts');
  await writeFile(externalFile, 'keep');
  const parentLink = path.join(root, 'outside-parent');
  await symlink(outside, parentLink);
  for (const target of [root, directory, path.join(root, 'missing'), externalFile, path.join(parentLink, 'external.ts')]) {
   await assert.rejects(runFileAction('delete', target, root));
  }
  await assert.rejects(runFileAction('delete', file), /project root/);
  assert.deepEqual(calls, []);
  assert.equal(await readFile(externalFile, 'utf8'), 'keep');
 } finally { await rm(outside, { recursive: true, force: true }); }
});

test('Delete trashes symlinks themselves, including broken links and links to directories', async () => {
 const links = [path.join(root, 'file-link'), path.join(root, 'folder-link'), path.join(root, 'broken-link')];
 for (const [index, target] of [file, directory, path.join(root, 'nonexistent')].entries()) {
  await symlink(target, links[index]);
  await runFileAction('delete', links[index], root);
  assert.equal((await lstat(path.join(trash, path.basename(links[index])))).isSymbolicLink(), true);
  await assert.rejects(lstat(links[index]), { code: 'ENOENT' });
 }
 assert.equal(await readFile(file, 'utf8'), 'export {};');
 assert.equal((await lstat(directory)).isDirectory(), true);
});

test('Delete on a link to a folder trashes only the link, without the folder prompt', async () => {
 const link = path.join(root, 'linked-folder');
 await symlink(directory, link);
 const asked = [], deleted = [];
 showFileContextMenu({ path: link, isDirectory: true, isSymlink: true }, { clientX: 0 }, {}, root, {
  confirmFolderDelete: async target => { asked.push(target); return true; },
  onDeleted: async target => { deleted.push(target); },
 });
 await menus.at(-1).items.at(-1).click();
 assert.deepEqual(asked, []);
 assert.deepEqual(calls, [['trash', link]]);
 assert.deepEqual(deleted, [link]);
 assert.deepEqual(notices, ['Link moved to trash.']);
 assert.equal((await lstat(path.join(trash, 'linked-folder'))).isSymbolicLink(), true);
 assert.equal(await readFile(file, 'utf8'), 'export {};');
});

test('stale file menus reject replacement directories; trash failures preserve the file and skip refresh', async () => {
 const target = path.join(root, 'stale.ts');
 await writeFile(target, 'keep');
 let refreshes = 0;
 showFileContextMenu({ path: target, isDirectory: false }, { clientX: 0 }, {}, root, { onDeleted: async () => { refreshes++; } });
 const deleteItem = menus.at(-1).items.at(-1);
 globalThis.__fileMenu.trashError = new Error('trash unavailable');
 await deleteItem.click();
 assert.equal(await readFile(target, 'utf8'), 'keep');
 assert.equal(refreshes, 0);
 assert.deepEqual(notices, ['Could not move this file to trash.']);
 await rm(target); await mkdir(target);
 calls.length = 0;
 await deleteItem.click();
 assert.deepEqual(calls, []);
 assert.equal(refreshes, 0);
 assert.equal((await lstat(target)).isDirectory(), true);
});

test('refresh failure reports that trashing succeeded', async () => {
 const target = path.join(root, 'refresh-error.ts');
 await writeFile(target, 'content');
 showFileContextMenu({ path: target, isDirectory: false }, { clientX: 0 }, {}, root, { onDeleted: async () => { throw new Error('view failed'); } });
 await menus.at(-1).items.at(-1).click();
 await assert.rejects(lstat(target), { code: 'ENOENT' });
 assert.deepEqual(notices, ['File moved to trash.', 'File moved to trash, but the view could not refresh.']);
});

function namePrompt(names) {
 const asked = [], errors = [];
 return { asked, errors, async promptNewName(kind, parentDir, submit) {
  asked.push([kind, parentDir]);
  for (const name of names.splice(0)) {
   const error = await submit(name);
   if (error === null) return true;
   errors.push(error);
  }
  return false;
 } };
}

test('New file and New folder come first, and only when the caller can ask for a name', () => {
 showFileContextMenu({ path: file, isDirectory: false }, { clientX: 0 }, {}, root);
 assert.equal(menus.at(-1).items.some(item => item.title.startsWith('New')), false);
 showFileContextMenu({ path: file, isDirectory: false }, { clientX: 0 }, {}, root, { promptNewName: namePrompt([]).promptNewName });
 assert.deepEqual(menus.at(-1).items.slice(0, 3).map(item => item.title), ['New file…', 'New folder…', 'Copy path']);
 assert.equal(menus.at(-1).separator, true);
});

test('a folder row creates inside it, a file row next to it, including nested folders', async () => {
 const created = [];
 const onCreated = async (createdPath, kind, project) => { created.push([createdPath, kind, project]); };
 const inFolder = namePrompt(['new file.ts']);
 showFileContextMenu({ path: directory, isDirectory: true }, { clientX: 0 }, {}, root, { promptNewName: inFolder.promptNewName, onCreated });
 await menus.at(-1).items[0].click();
 const nextToFile = namePrompt(['made/deeper/']);
 showFileContextMenu({ path: file, isDirectory: false }, { clientX: 0 }, {}, root, { promptNewName: nextToFile.promptNewName, onCreated });
 await menus.at(-1).items[1].click();
 assert.deepEqual([inFolder.asked, nextToFile.asked], [[['file', directory]], [['folder', directory]]]);
 const newFile = path.join(directory, 'new file.ts'), newFolder = path.join(directory, 'made', 'deeper');
 assert.deepEqual(created, [[newFile, 'file', root], [newFolder, 'folder', root]]);
 assert.equal(await readFile(newFile, 'utf8'), '');
 assert.equal((await lstat(newFolder)).isDirectory(), true);
 assert.deepEqual(notices, []);
});

test('refused names keep the dialog open with the reason; existing paths are never overwritten', async () => {
 const prompt = namePrompt(['  ', '../escape.ts', '/absolute.ts', 'a.ts', 'a.ts/inner.ts', 'fixed.ts']);
 let created = 0;
 showFileContextMenu({ path: file, isDirectory: false }, { clientX: 0 }, {}, root, { promptNewName: prompt.promptNewName, onCreated: async () => { created++; } });
 await menus.at(-1).items[0].click();
 assert.deepEqual(prompt.errors, ['Enter a name.', 'A name cannot contain "." or ".." folders.', 'Enter a name relative to this folder.',
  '"a.ts" already exists.', 'Cannot create folder "a.ts": a file is in the way.']);
 assert.equal(created, 1);
 assert.equal(await readFile(file, 'utf8'), 'export {};');
 await assert.rejects(lstat(path.join(root, 'escape.ts')), { code: 'ENOENT' });
 assert.equal(await readFile(path.join(directory, 'fixed.ts'), 'utf8'), '');
 await mkdir(path.join(root, 'existing folder'));
 await assert.rejects(createEntry('folder', root, 'existing folder', root), /already exists/);
});

test('a cancelled dialog creates nothing; a refresh failure reports that creation succeeded', async () => {
 let created = 0;
 showFileContextMenu({ path: root, isDirectory: true }, { clientX: 0 }, {}, root, { promptNewName: async () => false, onCreated: async () => { created++; } });
 await menus.at(-1).items[0].click();
 assert.equal(created, 0);
 showFileContextMenu({ path: root, isDirectory: true }, { clientX: 0 }, {}, root, { promptNewName: namePrompt(['refresh-error.md']).promptNewName,
  onCreated: async () => { throw new Error('view failed'); } });
 await menus.at(-1).items[0].click();
 assert.equal(await readFile(path.join(root, 'refresh-error.md'), 'utf8'), '');
 assert.deepEqual(notices, ['File created, but the view could not refresh.']);
});

test('creation stays inside the project root and follows a link to a folder into its target', async () => {
 const outside = await mkdtemp(path.join(os.tmpdir(), 'so-outside-'));
 try {
  await assert.rejects(createEntry('file', outside, 'external.ts', root), /outside the project root/);
  await assert.rejects(createEntry('file', root, 'x.ts', directory), /outside the project root/);
  await symlink(outside, path.join(root, 'outside-link'));
  assert.equal(await createEntry('file', path.join(root, 'outside-link'), 'via link.ts', root), path.join(root, 'outside-link', 'via link.ts'));
  assert.equal(await readFile(path.join(outside, 'via link.ts'), 'utf8'), '');
 } finally { await rm(outside, { recursive: true, force: true }); }
});
