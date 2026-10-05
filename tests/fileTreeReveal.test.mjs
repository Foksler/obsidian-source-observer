import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: "export { FileTree } from './src/fileTree.ts'; export { invalidateFileIndex } from './src/filePathIndex.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
 plugins: [{ name: 'tree-test', setup(api) {
  api.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
  api.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export function setIcon(element, name) { element.icon = name; }', loader: 'js' }));
  api.onResolve({ filter: /^\.\/searchEngine$/ }, () => ({ path: 'search', namespace: 'search' }));
  api.onLoad({ filter: /.*/, namespace: 'search' }, () => ({ contents: 'export async function getRegisteredWorktrees() { return []; }', loader: 'js' }));
 } }] });
const { FileTree, invalidateFileIndex } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
class Element {
 children = []; dataset = {}; attrs = {}; classes = new Set(); listeners = new Map(); scrollTop = 0;
 constructor(options = {}, document = { activeElement: null }) { this.ownerDocument = document; for (const cls of (options.cls ?? '').split(' ')) this.classes.add(cls); }
 setAttribute(key, value) { this.attrs[key] = value; }
 setCssProps() {} addClass(cls) { this.classes.add(cls); } removeClass(cls) { this.classes.delete(cls); }
 toggleClass(cls, on) { if (on) this.addClass(cls); else this.removeClass(cls); }
 empty() { this.children = []; } addEventListener(key, fn) { this.listeners.set(key, fn); }
 createDiv(options) { const child = new Element(options, this.ownerDocument); child.parent = this; this.children.push(child); return child; }
 createSpan(options) { return this.createDiv(options); }
 querySelectorAll(selector) { const cls = selector.slice(1); return this.children.flatMap(child => [...(child.classes.has(cls) ? [child] : []), ...child.querySelectorAll(selector)]); }
 contains(element) { return element === this || this.children.some(child => child.contains(element)); }
 focus() { this.ownerDocument.activeElement = this; this.listeners.get('focus')?.(); }
 scrollIntoView() { this.scrolled = true; }
}
async function setup(hidden = true) {
 const root = await mkdtemp(path.join(os.tmpdir(), 'so-reveal-'));
 await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
 const file = path.join(root, 'src', 'nested', 'Current.php');
 await writeFile(file, '<?php');
 const container = new Element(), opened = [];
 const tree = new FileTree(container, hidden, file => opened.push(file));
 await tree.loadPath(root);
 return { root, file, container, tree, opened, async cleanup() { tree.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test('Locate expands lazy ancestors, selects and scrolls the current file without reopening it', async () => {
 const fixture = await setup();
 try {
  const { tree, file, container, opened } = fixture;
  container.empty(); // A filtered list must be replaced with the directory tree.
  assert.equal(await tree.reveal(file), true);
  const rows = container.querySelectorAll('.so-tree-row');
  assert.deepEqual(rows.map(row => row.dataset.path), [fixture.root, path.dirname(path.dirname(file)), path.dirname(file), file]);
  assert.ok(rows.slice(0, -1).every(row => row.attrs['aria-expanded'] === 'true'));
  const selected = rows.at(-1);
  assert.equal(selected.attrs['aria-selected'], 'true');
  assert.equal(container.ownerDocument.activeElement, selected);
  assert.ok(selected.scrolled);
  assert.deepEqual(tree.getSelectedPath(), { path: file, isDirectory: false });
  assert.deepEqual(opened, []);
 } finally { await fixture.cleanup(); }
});

test('Locate respects root boundaries, hidden files and excluded worktrees', async () => {
 const fixture = await setup(false);
 try {
  const { tree, root } = fixture;
  await writeFile(path.join(root, '.hidden.php'), '<?php');
  await mkdir(path.join(root, 'worktrees'), { recursive: true });
  await writeFile(path.join(root, 'worktrees', 'Other.php'), '<?php');
  assert.equal(await tree.reveal(path.join(root, '..', 'outside.php')), false);
  assert.equal(await tree.reveal(path.join(root, '.hidden.php')), false);
  assert.equal(await tree.reveal(path.join(root, 'worktrees', 'Other.php')), false);
  assert.equal(tree.getSelectedPath(), null);
 } finally { await fixture.cleanup(); }
});

test('late Locate cannot select or replace the tree after switching folders', async () => {
 const fixture = await setup();
 try {
  const { tree, root, file, container } = fixture;
  const readDir = tree.readDir.bind(tree);
  let resume;
  tree.readDir = async (...args) => { if (args[0] === path.join(root, 'src')) await new Promise(resolve => { resume = resolve; }); return readDir(...args); };
  const locating = tree.reveal(file);
  await tree.loadPath(path.join(root, 'src', 'nested'));
  resume();
  assert.equal(await locating, false);
  assert.equal(tree.getSelectedPath(), null);
  assert.equal(container.querySelectorAll('.so-tree-row')[0].dataset.path, path.dirname(file));
 } finally { await fixture.cleanup(); }
});

test('folder disclosure follows expansion and collapse without opening a file', async () => {
 const fixture = await setup();
 try {
  const { tree, file, container, opened } = fixture;
  await tree.reveal(file);
  const rows = container.querySelectorAll('.so-tree-row');
  const directory = rows[1];
  const chevron = directory.querySelectorAll('.so-tree-chevron')[0];
  const icon = directory.querySelectorAll('.so-tree-icon')[0];
  assert.equal(chevron.icon, 'chevron-down');
  assert.equal(icon.dataset.icon, 'folder-src-open');
  directory.listeners.get('click')();
  assert.equal(directory.attrs['aria-expanded'], 'false');
  assert.equal(chevron.icon, 'chevron-right');
  assert.equal(icon.dataset.icon, 'folder-src');
  assert.ok(container.querySelectorAll('.so-tree-children')[1].classes.has('so-tree-children-hidden'));
  directory.listeners.get('click')();
  assert.equal(directory.attrs['aria-expanded'], 'true');
  assert.equal(chevron.icon, 'chevron-down');
  assert.equal(icon.dataset.icon, 'folder-src-open');
  assert.deepEqual(opened, []);
 } finally { await fixture.cleanup(); }
});

test('refresh shows new empty and nested folders without reopening the root or losing tree state', async () => {
 const fixture = await setup();
 try {
  const { tree, root, file, container, opened } = fixture;
  await tree.reveal(file);
  container.scrollTop = 173;
  await mkdir(path.join(root, 'new-empty'));
  await mkdir(path.join(root, 'src', 'nested', 'new-child'));
  await tree.refresh();
  const rows = container.querySelectorAll('.so-tree-row');
  assert.ok(rows.some(row => row.dataset.path === path.join(root, 'new-empty')));
  assert.ok(rows.some(row => row.dataset.path === path.join(root, 'src', 'nested', 'new-child')));
  assert.ok(rows.filter(row => [root, path.join(root, 'src'), path.dirname(file)].includes(row.dataset.path)).every(row => row.attrs['aria-expanded'] === 'true'));
  assert.deepEqual(tree.getSelectedPath(), { path: file, isDirectory: false });
  assert.equal(container.ownerDocument.activeElement.dataset.path, file);
  assert.equal(container.scrollTop, 173);
  assert.deepEqual(opened, []);
 } finally { await fixture.cleanup(); }
});

test('refresh handles renames and deletions and refreshes cached collapsed branches', async () => {
 const fixture = await setup();
 try {
  const { tree, root, file, container } = fixture;
  await tree.reveal(file);
  const src = container.querySelectorAll('.so-tree-row').find(row => row.dataset.path === path.join(root, 'src'));
  src.listeners.get('click')();
  const renamed = path.join(path.dirname(file), 'Renamed.php');
  await rename(file, renamed);
  await tree.refresh();
  assert.deepEqual(tree.getSelectedPath(), { path: root, isDirectory: true });
  const refreshed = container.querySelectorAll('.so-tree-row').find(row => row.dataset.path === path.join(root, 'src'));
  assert.equal(refreshed.attrs['aria-expanded'], 'false');
  refreshed.listeners.get('click')();
  let rows = container.querySelectorAll('.so-tree-row');
  assert.ok(rows.some(row => row.dataset.path === renamed));
  assert.ok(!rows.some(row => row.dataset.path === file));
  await rm(path.dirname(file), { recursive: true });
  await tree.refresh();
  rows = container.querySelectorAll('.so-tree-row');
  assert.ok(!rows.some(row => row.dataset.path === path.dirname(file)));
 } finally { await fixture.cleanup(); }
});

test('refresh keeps the active filename filter and includes newly created matching files', async () => {
 const fixture = await setup();
 try {
  const { tree, root, container } = fixture;
  await tree.search('Current');
  const added = path.join(root, 'CurrentNew.php');
  await writeFile(added, '<?php');
  invalidateFileIndex(root);
  await tree.refresh();
  assert.deepEqual(container.querySelectorAll('.so-tree-row').map(row => row.dataset.path).sort(), [fixture.file, added].sort());
 } finally { await fixture.cleanup(); }
});

test('unchanged refresh preserves existing rows and late refresh cannot replace another folder', async () => {
 const fixture = await setup();
 try {
  const { tree, root, container } = fixture;
  const original = container.querySelectorAll('.so-tree-row')[0];
  await tree.refresh();
  assert.equal(container.querySelectorAll('.so-tree-row')[0], original);
  const readDir = tree.readDir.bind(tree);
  let resume;
  tree.readDir = async (...args) => { if (args[0] === root) await new Promise(resolve => { resume = resolve; }); return readDir(...args); };
  const updating = tree.refresh();
  const next = path.join(root, 'src', 'nested');
  await tree.loadPath(next);
  resume();
  await updating;
  assert.equal(container.querySelectorAll('.so-tree-row')[0].dataset.path, next);
  assert.equal(tree.getSelectedPath(), null);
 } finally { await fixture.cleanup(); }
});

test('right click selects roots, folders and files without opening or expanding them', async () => {
 const fixture = await setup();
 try {
  const menus = [], selections = [];
  fixture.tree.onContextMenu = (...args) => menus.push(args);
  fixture.tree.onPathSelect = selection => selections.push(selection);
  const rows = fixture.container.querySelectorAll('.so-tree-row');
  for (const row of rows) {
   const expanded = row.attrs['aria-expanded'];
   let prevented = false, stopped = false;
   const event = { preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
   row.listeners.get('contextmenu')(event);
   assert.ok(prevented && stopped);
   assert.equal(row.attrs['aria-expanded'], expanded);
   assert.equal(row.attrs['aria-selected'], 'true');
   assert.equal(fixture.container.ownerDocument.activeElement, row);
   assert.deepEqual(menus.at(-1), [{ path: row.dataset.path, isDirectory: true }, event, row, fixture.root]);
  }
  await fixture.tree.reveal(fixture.file);
  const file = fixture.container.querySelectorAll('.so-tree-row').at(-1);
  file.listeners.get('contextmenu')({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(menus.at(-1)[0], { path: fixture.file, isDirectory: false });
  assert.deepEqual(fixture.opened, []);
  assert.ok(selections.length >= 2);
 } finally { await fixture.cleanup(); }
});

test('filtered results support mouse and keyboard context menus, with disposed rows inert', async () => {
 const fixture = await setup();
 try {
  const menus = [];
  fixture.tree.onContextMenu = selection => menus.push(selection);
  await fixture.tree.search('Current');
  const row = fixture.container.querySelectorAll('.so-tree-row')[0];
  const event = { preventDefault() {}, stopPropagation() {} };
  row.listeners.get('contextmenu')(event);
  row.listeners.get('keydown')({ ...event, key: 'F10', shiftKey: true });
  row.listeners.get('keydown')({ ...event, key: 'ContextMenu' });
  assert.deepEqual(menus, Array(3).fill({ path: fixture.file, isDirectory: false }));
  assert.deepEqual(fixture.opened, []);
  fixture.tree.dispose();
  row.listeners.get('contextmenu')(event);
  assert.equal(menus.length, 3);
 } finally { await fixture.cleanup(); }
});
