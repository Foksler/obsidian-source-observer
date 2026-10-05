import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';

const calls = [], notices = [], menus = [];
globalThis.__fileMenu = { calls, notices, menus, mac: true };
globalThis.window = { require(name) {
 assert.equal(name, 'electron');
 return { clipboard: { writeText: value => calls.push(['copy', value]) }, shell: { showItemInFolder: value => calls.push(['reveal', value]) } };
} };
const bundle = await build({ entryPoints: ['src/fileContextMenu.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
 plugins: [{ name: 'native-actions', setup(api) {
  api.onResolve({ filter: /^(obsidian|child_process)$/ }, args => ({ path: args.path, namespace: 'shim' }));
  api.onLoad({ filter: /.*/, namespace: 'shim' }, args => ({ loader: 'js', contents: args.path === 'child_process'
   ? `export function execFile(command, args, done) { globalThis.__fileMenu.calls.push(['exec', command, args]); done(globalThis.__fileMenu.execError ?? null, '', ''); }`
   : `export const Platform = { get isMacOS() { return globalThis.__fileMenu.mac; } };
      export class Notice { constructor(text) { globalThis.__fileMenu.notices.push(text); } }
      export class Menu {
       items = [];
       constructor() { globalThis.__fileMenu.menus.push(this); }
       addItem(fn) { const item = { setTitle(title) { this.title = title; return this; }, setIcon() { return this; }, setDisabled(disabled) { this.disabled = disabled; return this; }, onClick(click) { this.click = click; return this; } }; fn(item); this.items.push(item); }
       showAtMouseEvent(event) { this.mouse = event; }
       showAtPosition(position) { this.position = position; }
      }` }));
 } }] });
const { runFileAction, showFileContextMenu } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const root = await mkdtemp(path.join(os.tmpdir(), 'so-file-actions-'));
const directory = path.join(root, 'space \'quote" $dollar; $(echo unsafe)');
const file = path.join(directory, 'a.ts');
await mkdir(directory);
await writeFile(file, 'export {};');
test.after(() => rm(root, { recursive: true, force: true }));
test.beforeEach(() => { calls.length = notices.length = menus.length = 0; globalThis.__fileMenu.mac = true; globalThis.__fileMenu.execError = null; });

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
 assert.deepEqual(menu.items.map(item => item.title), ['Copy path', 'Copy relative path', 'Reveal in Finder', 'Open in terminal']);
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
