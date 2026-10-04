import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/explorerDock.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
 plugins: [{ name: 'dock-test', setup(api) {
  api.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
  api.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: `
   export class ItemView {
    constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.scope = {}; this.contentEl = new globalThis.__dockElement(); }
    async setState() {} registerDomEvent() {}
   }
   export class Notice { constructor(message) { throw new Error(message); } }
  `, loader: 'js' }));
 } }] });
const { ExplorerDock, SourceExplorerView, EXPLORER_VIEW_TYPE } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
class Element {
 children = []; classes = new Set(); parentElement = null;
 get firstChild() { return this.children[0] ?? null; }
 addClass(cls) { this.classes.add(cls); } removeClass(cls) { this.classes.delete(cls); }
 hasClass(cls) { return this.classes.has(cls); } toggleClass(cls, enabled) { enabled ? this.addClass(cls) : this.removeClass(cls); }
 appendChild(child) { this.insertBefore(child, null); }
 insertBefore(child, before) {
  if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
  const index = before ? this.children.indexOf(before) : this.children.length;
  this.children.splice(index, 0, child); child.parentElement = this;
 }
 empty() { for (const child of this.children) child.parentElement = null; this.children = []; }
 createEl() { const child = new Element(); this.appendChild(child); return child; }
}
globalThis.__dockElement = Element;
function setup() {
 let enabled = false;
 const reveals = [], replacements = [];
 const left = {}, right = {}, main = {}, editorLeaf = { getRoot: () => main };
 const original = { type: 'file-explorer', active: false, state: { sortOrder: 'byModifiedTime' } };
 const app = { workspace: {
  leftSplit: left, rightSplit: right, active: null,
  getLeavesOfType(type) { return leaves.filter(leaf => leaf.state.type === type); },
  getLeftLeaf() { throw new Error('Must reuse native Files leaf'); },
  async revealLeaf(leaf) { reveals.push(leaf); this.active = leaf.view; },
  getActiveViewOfType(Type) { return this.active instanceof Type ? this.active : null; },
 } };
 function leaf(root, state) { return {
  app, state, view: {}, getRoot: () => root, getViewState() { return this.state; },
  async setViewState(next) {
   if (this.wait) await this.wait;
   await this.view.onClose?.(); this.state = next; replacements.push(next.type);
   this.view = next.type === EXPLORER_VIEW_TYPE ? new SourceExplorerView(this, () => {}) : {};
   await this.view.onOpen?.(); await this.view.setState?.(next.state ?? {}, {});
  },
 }; }
 const native = leaf(left, original), other = leaf(right, { type: 'file-explorer', state: { sortOrder: 'alphabetical' } });
 const leaves = [native, other];
 const home = new Element(), sidebar = new Element(), editor = new Element();
 home.addClass('so-cursor-theme'); home.appendChild(sidebar); home.appendChild(editor);
 editorLeaf.app = app;
 const view = new SourceExplorerView(editorLeaf, () => {}); editorLeaf.view = view; app.workspace.active = view;
 const owner = { view, home, sidebar, isClosed: () => false };
 const dock = new ExplorerDock(app, () => enabled);
 return { dock, owner, native, other, original, reveals, replacements, app, editorLeaf, noteLeaf: { view: {}, getRoot: () => main }, setEnabled(value) { enabled = value; } };
}
test('optional docking reuses only left Files and preserves tree/editor state on round trip', async () => {
 const h = setup();
 const selection = { file: 'Current.php' }; h.owner.sidebar.selection = selection;
 await h.dock.attach(h.owner);
 assert.equal(h.owner.sidebar.parentElement, h.owner.home);
 assert.deepEqual(h.replacements, []);
 h.setEnabled(true); await h.dock.update();
 assert.equal(h.native.state.type, EXPLORER_VIEW_TYPE);
 assert.equal(h.other.state.type, 'file-explorer');
 assert.equal(h.owner.sidebar.parentElement, h.native.view.contentEl);
 assert.equal(h.native.view.scope, h.owner.view.scope);
 assert.equal(h.dock.isActive(h.owner.view), true);
 assert.equal(h.owner.home.children.length, 1);
 const reveals = h.reveals.length;
 await h.dock.update(); // Saving folder or font settings must not steal editor focus.
 assert.equal(h.reveals.length, reveals);
 h.setEnabled(false); await h.dock.update();
 assert.deepEqual(h.native.state, h.original);
 assert.equal(h.owner.home.firstChild, h.owner.sidebar);
 assert.equal(h.owner.sidebar.selection, selection);
 assert.equal(h.owner.sidebar.hasClass('so-sidebar-docked'), false);
});
test('closing the source editor restores native Files even while replacement is enabled', async () => {
 const h = setup(); h.setEnabled(true); await h.dock.attach(h.owner);
 await h.dock.detach(h.owner.view);
 assert.deepEqual(h.native.state, h.original);
 assert.equal(h.owner.sidebar.parentElement, h.owner.home);
});
test('disabling while the sidebar opens cannot mount a stale replacement', async () => {
 const h = setup(); h.setEnabled(true);
 let resume; h.native.wait = new Promise(resolve => { resume = resolve; });
 const opening = h.dock.attach(h.owner);
 await Promise.resolve(); h.setEnabled(false);
 const reverting = h.dock.update(); resume();
 await Promise.all([opening, reverting]);
 assert.deepEqual(h.native.state, h.original);
 assert.equal(h.owner.sidebar.parentElement, h.owner.home);
});
test('unload starts restoring the native Files view before unregistering sidebar types', async () => {
 const h = setup(); h.setEnabled(true); await h.dock.attach(h.owner);
 await h.dock.dispose();
 assert.deepEqual(h.native.state, h.original);
 assert.equal(h.owner.sidebar.parentElement, h.owner.home);
});

test('note tabs restore Files and returning to the source tab reuses the tree state', async () => {
 const h = setup(); h.setEnabled(true); await h.dock.attach(h.owner);
 const treeState = { file: 'Current.php', expanded: ['src'] }; h.owner.sidebar.selection = treeState;
 await h.dock.setActiveLeaf(h.native); // Clicking the docked tree keeps source context.
 assert.equal(h.native.state.type, EXPLORER_VIEW_TYPE);
 await h.dock.setActiveLeaf(h.other); // Search/bookmarks in side docks do not change main-tab context.
 assert.equal(h.native.state.type, EXPLORER_VIEW_TYPE);
 await h.dock.setActiveLeaf(h.noteLeaf);
 assert.deepEqual(h.native.state, h.original);
 assert.equal(h.owner.home.firstChild, h.owner.sidebar);
 const reveals = h.reveals.length;
 await h.dock.update(); // Settings saves in a note must not replace native Files.
 assert.equal(h.reveals.length, reveals);
 await h.dock.setActiveLeaf(h.editorLeaf);
 assert.equal(h.native.state.type, EXPLORER_VIEW_TYPE);
 assert.equal(h.owner.sidebar.selection, treeState);
});
test('opening a background source view does not replace Files until explicitly activated', async () => {
 const h = setup(); h.setEnabled(true); h.app.workspace.active = null;
 await h.dock.attach(h.owner);
 assert.deepEqual(h.replacements, []);
 await h.dock.activate(h.owner.view); // Ribbon/command opens the source workspace.
 assert.equal(h.native.state.type, EXPLORER_VIEW_TYPE);
});
test('a note switch during asynchronous docking cancels the pending replacement', async () => {
 const h = setup(); h.setEnabled(true);
 let resume; h.native.wait = new Promise(resolve => { resume = resolve; });
 const opening = h.dock.attach(h.owner);
 await Promise.resolve();
 const note = h.dock.setActiveLeaf(h.noteLeaf); resume();
 await Promise.all([opening, note]);
 assert.deepEqual(h.native.state, h.original);
 assert.equal(h.owner.sidebar.parentElement, h.owner.home);
});
