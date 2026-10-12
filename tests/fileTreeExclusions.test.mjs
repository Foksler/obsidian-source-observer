import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: "export { FileTree } from './src/fileTree.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
 plugins: [{ name: 'tree-test', setup(api) {
  api.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
  api.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export function setIcon(element, name) { element.icon = name; }', loader: 'js' }));
  api.onResolve({ filter: /^\.\/searchEngine$/ }, () => ({ path: 'search', namespace: 'search' }));
  api.onLoad({ filter: /.*/, namespace: 'search' }, () => ({ contents: 'export async function getRegisteredWorktrees() { return []; }', loader: 'js' }));
 } }] });
const { FileTree } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
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
 scrollIntoView() {}
}

test('excluded names and root-anchored folders stay out of the tree; changing them keeps folders expanded', async (t) => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'so-tree-exclusions-'));
 const container = new Element(), tree = new FileTree(container, true, () => {});
 t.after(async () => { tree.dispose(); await rm(root, { recursive: true, force: true }); });
 for (const name of ['.DS_Store', 'out/main.js', 'src/.DS_Store', 'src/app.ts', 'src/out/gen.ts']) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), '');
 }
 const rows = () => container.querySelectorAll('.so-tree-row').map(row => path.relative(root, row.dataset.path));
 await tree.setExcludedFiles(['.DS_Store', '/out']);
 await tree.loadPath(root);
 assert.equal(await tree.reveal(path.join(root, 'src', 'app.ts')), true);
 assert.deepEqual(rows(), ['', 'src', 'src/out', 'src/app.ts']);
 await tree.setExcludedFiles([]);
 assert.deepEqual(rows(), ['', 'out', 'src', 'src/out', 'src/.DS_Store', 'src/app.ts', '.DS_Store']);
 assert.equal(container.querySelectorAll('.so-tree-row').find(row => row.dataset.path === path.join(root, 'src')).attrs['aria-expanded'], 'true');
});
