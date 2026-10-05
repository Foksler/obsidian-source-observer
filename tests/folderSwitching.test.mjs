import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const tempDir = await mkdtemp(path.join(process.cwd(), 'tests', '.folder-switching-'));
const bundlePath = path.join(tempDir, 'view.mjs');
await build({
	stdin: {
		contents: `export { SourceObserverView } from './src/view.ts';`,
		resolveDir: process.cwd(),
		sourcefile: 'folder-switching-test-entry.ts',
	},
	bundle: true,
	packages: 'external',
	platform: 'node',
	format: 'esm',
	outfile: bundlePath,
	plugins: [{
		name: 'folder-switch-test-shims',
		setup(buildApi) {
			buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-shim', namespace: 'folder-test' }));
			buildApi.onLoad({ filter: /.*/, namespace: 'folder-test' }, () => ({ contents: `
				export class ItemView {}
				export class WorkspaceLeaf {}
				export class Notice { constructor() {} }
				export class Scope { constructor() {} register() {} }
				export const Platform = { isMacOS: false };
				export class Component { load() {} unload() {} }
				export class Modal {}
				export function setIcon() {}
			`, loader: 'js' }));

			const stubs = {
				'./fileTree': 'export class FileTree {}',
				'./codePane': 'export class CodePane {}',
				'./searchPanel': 'export class SearchPanel {}',
				'./editorTabs': 'export class EditorTabs {}',
				'./folderTabs': 'export class FolderTabs {}',
				'./symbolPicker': 'export class SymbolPicker {}',
				'./filePicker': 'export class FilePicker {}',
				'./searchEverywhereModal': 'export class SearchEverywhereModal {}',
				'./lspNavigation': `
					export class LspNavigation {
						constructor(options, adapters) { this.options = options; this.adapters = adapters; this.disposed = false; }
						setWorkspaceRoot(root) { this.root = root; }
						dispose() { this.disposed = true; }
					}
					export function navigationAdapters(settings) { return ['php', 'go'].filter((id) => settings[id + 'Lsp']); }
				`,
				'./searchEngine': `
					export function getRegisteredWorktrees(root) { return globalThis.__folderSwitchHarness.worktrees(root); }
					export function invalidateFileIndex() {}
					export function warmFileIndex() { return Promise.resolve(); }
				`,
				'./gitDiff': `
					export async function getGitRoot(root) { return await globalThis.__folderSwitchHarness.isGitRepo(root) ? root : null; }
					export function getChangedFiles(root) { return globalThis.__folderSwitchHarness.getChangedFiles(root); }
					export function getFileDiff() { return Promise.resolve(''); }
					export function renderDiff() {}
				`,
			};
			buildApi.onResolve({ filter: /^\.\// }, (args) => stubs[args.path]
				? { path: args.path.slice(2), namespace: 'folder-test-stub' }
				: null);
			buildApi.onLoad({ filter: /.*/, namespace: 'folder-test-stub' }, (args) => ({
				contents: stubs[`./${args.path}`], loader: 'js',
			}));
		},
	}],
});
const { SourceObserverView } = await import(pathToFileURL(bundlePath).href);

test.after(async () => rm(tempDir, { recursive: true, force: true }));

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function fakeElement() {
	return {
		value: '',
		empty() {},
		setText() {}, setAttribute() {},
		toggleClass() {},
		createEl() { return fakeElement(); },
		createSpan() { return fakeElement(); },
	};
}

function setupView(activePath, paths = [activePath]) {
	const harness = {
		worktreeCalls: [],
		treeCalls: [],
		watchRoots: [],
		gitStarted: [],
		worktreeResult: new Map(),
		treeResult: new Map(),
		gitResult: new Map(),
		changedResult: new Map(),
		worktrees(root) { this.worktreeCalls.push(root); return this.worktreeResult.get(root)?.promise ?? Promise.resolve([]); },
		loadTree(root) { this.treeCalls.push(root); return this.treeResult.get(root)?.promise ?? Promise.resolve(); },
		isGitRepo(root) {
			this.gitStarted.push(root);
			return this.gitResult.get(root)?.promise ?? Promise.resolve(true);
		},
		getChangedFiles(root) { this.changesRoot = root; return this.changedResult.get(root)?.promise ?? Promise.resolve([]); },
	};
	globalThis.__folderSwitchHarness = harness;
	globalThis.window = {
		clearTimeout() {},
		clearInterval() {},
		setInterval() { return 1; },
	};

	const view = Object.create(SourceObserverView.prototype);
	const plugin = {
		settings: {
			openedFolderPaths: [...paths], lastOpenedPath: activePath,
			includeWorktrees: false, showHidden: false, gitPanelHidden: false,
			phpLsp: false, nodePath: '', intelephensePath: '', intelephenseLicence: '',
		},
		savedSettingsCount: 0,
		async saveSettings() { this.savedSettingsCount++; },
	};
	const codePane = {
		state: { name: activePath, currentPath: null, location: null },
		restored: [], opened: [],
		captureSession() { return structuredClone(this.state); },
		restoreSession(session) {
			this.restored.push(structuredClone(session));
			this.state = session ? structuredClone(session) : { name: 'fresh', currentPath: null, location: null };
		},
		async open(filePath) { this.opened.push(filePath); this.state.currentPath = filePath; },
		suspend() {}, rememberPosition() {}, async openAt() {}, getCurrentFile() { return this.state.currentPath; },
	};
	const editorTabs = {
		state: { tabs: [], active: null }, restored: [],
		captureState() { return structuredClone(this.state); },
		restoreState(state) {
			this.restored.push(structuredClone(state));
			this.state = state ? structuredClone(state) : { tabs: [], active: null };
		},
		getActive() { return this.state.active ? structuredClone(this.state.active) : null; },
		show(tab) {
			if (!this.state.tabs.some((entry) => entry.kind === tab.kind && entry.filePath === tab.filePath)) this.state.tabs.push(structuredClone(tab));
			this.state.active = structuredClone(tab);
		},
	};
	const searchPanel = {
		state: { query: '', options: {} }, roots: [],
		captureState() { return structuredClone(this.state); },
		restoreState(state) { this.state = state ? structuredClone(state) : { query: '', options: {} }; },
		setRoot(root) { this.roots.push(root); }, setIncludeWorktrees() {}, setShowHidden() {}, focus() {}, dispose() {},
	};
	const fileTree = {
		async loadPath(root) { return harness.loadTree(root); },
		async search() {}, async refresh() {}, setIncludeWorktrees() {}, setShowHidden() {}, dispose() {},
	};
	Object.assign(view, {
		plugin,
		app: { vault: { configDir: '.obsidian' } },
		closed: false,
		repoPath: activePath,
		folderPaths: [...paths],
		folderSessions: new Map(),
		folderRequestId: 0,
		gitRequestId: 0,
		diffRequestId: 0,
		codePane,
		editorTabs,
		searchPanel,
		fileTree,
		folderTabs: { setFolders() {}, dispose() {} },
		pathLabel: fakeElement(),
		changesContainer: fakeElement(),
		changesCounts: fakeElement(),
		gitSection: fakeElement(),
		gitToggle: fakeElement(),
		gitSplitter: fakeElement(),
		treeSearchInput: fakeElement(),
		changesSearchInput: fakeElement(),
		changesQuery: '',
		allChanges: [],
		watchers: [],
		filePicker: null,
		indexedWorktrees: [],
		pollTimer: 1,
		refreshTimer: null,
		treeSearchTimer: null,
		fileIndexTimer: null,
		languageNavigation: null,
		lspKey: '',
		stopWatching() {},
		startWatching() { harness.watchRoots.push(this.repoPath); },
		syncNavigation() {},
		registerInterval(id) { return id; },
	});
	return { view, harness, codePane, editorTabs, searchPanel };
}

test('filesystem creation events refresh the active tree even in a non-Git folder', async (t) => {
	const root = await mkdtemp(path.join(tempDir, 'watch-'));
	const { view } = setupView(root);
	globalThis.window.setTimeout = setTimeout;
	globalThis.window.clearTimeout = clearTimeout;
	view.stopWatching = () => SourceObserverView.prototype.stopWatching.call(view);
	view.isRepo = false;
	const refreshed = deferred();
	view.fileTree.refresh = async () => refreshed.resolve(view.repoPath);
	t.after(() => view.stopWatching());
	SourceObserverView.prototype.startWatching.call(view);
	assert.ok(view.watchers.length > 0);
	// macOS subscribes to FSEvents asynchronously, especially while other test files build bundles.
	if (process.platform === 'darwin') await new Promise(resolve => setTimeout(resolve, 100));
	await mkdir(path.join(root, 'created-after-opening'));
	let timeout;
	try {
		assert.equal(await Promise.race([refreshed.promise, new Promise((_, reject) => {
			timeout = setTimeout(() => reject(new Error('Tree did not refresh after directory creation')), 3000);
		})]), root);
	} finally { clearTimeout(timeout); }
});

test('backup polling refreshes the tree when filesystem events are missed', async () => {
	const { view } = setupView('/tmp/so-poll-a', ['/tmp/so-poll-a', '/tmp/so-poll-b']);
	view.pollTimer = null;
	let poll;
	globalThis.window.setInterval = callback => { poll = callback; return 1; };
	await view.activateFolder('/tmp/so-poll-b');
	let refreshes = 0;
	view.fileTree.refresh = async () => { refreshes++; };
	poll();
	assert.equal(refreshes, 1);
});

test('choosing text in another folder switches sessions before opening the exact occurrence', async () => {
	const a = '/tmp/source-observer-folder-a', b = '/tmp/source-observer-folder-b';
	const { view, codePane } = setupView(a, [a, b]);
	codePane.state = { name: 'A', currentPath: `${a}/A.php`, location: { line: 19, column: 8 } };
	const visits = [];
	codePane.openAt = async (filePath, line, column) => { visits.push({ root: view.repoPath, filePath, line, column }); };
	codePane.focus = () => { visits.push('focused'); };
	await view.openSearchResult({ rootPath: b, filePath: `${b}/B.php`, line: 37, column: 11 });
	assert.deepEqual(visits, [{ root: b, filePath: `${b}/B.php`, line: 37, column: 11 }, 'focused']);
	assert.equal(view.folderSessions.get(a).editor.location.line, 19);
});

test('a cancelled folder activation cannot open its stale result after the user switches elsewhere', async () => {
	const a = '/tmp/source-observer-folder-a', b = '/tmp/source-observer-folder-b';
	const { view, harness, codePane } = setupView(a, [a, b]);
	const pending = deferred();
	harness.worktreeResult.set(b, pending);
	const visits = [];
	codePane.openAt = async () => { visits.push('opened'); };
	codePane.focus = () => { visits.push('focused'); };
	const opening = view.openSearchResult({ rootPath: b, filePath: `${b}/B.php`, line: 37, column: 11 });
	await view.activateFolder(a);
	pending.resolve([]);
	await opening;
	assert.deepEqual(visits, []);
	assert.equal(view.repoPath, a);
});

test('a late result open cannot steal focus after switching folder sessions', async () => {
	const a = '/tmp/source-observer-folder-a', b = '/tmp/source-observer-folder-b';
	const { view, codePane } = setupView(a, [a, b]);
	const pending = deferred();
	let focused = 0;
	codePane.openAt = () => pending.promise;
	codePane.focus = () => focused++;
	const opening = view.openSearchResult({ rootPath: a, filePath: `${a}/A.php`, line: 37, column: 11 });
	await view.activateFolder(b);
	pending.resolve();
	await opening;
	assert.equal(focused, 0);
});

test('folder switches preserve and restore independent tabs, editor cursor and search state', async () => {
	const a = '/tmp/source-observer-folder-a';
	const b = '/tmp/source-observer-folder-b';
	const { view, codePane, editorTabs, searchPanel } = setupView(a, [a, b]);
	codePane.state = { name: 'A', currentPath: `${a}/src/A.php`, location: { line: 19, column: 8, scrollTop: 413 } };
	editorTabs.state = {
		tabs: [{ filePath: `${a}/src/A.php`, kind: 'code' }, { filePath: `${a}/src/A.php`, kind: 'diff' }],
		active: { filePath: `${a}/src/A.php`, kind: 'code' },
	};
	searchPanel.state = { query: 'needle-A', options: { caseSensitive: true } };
	view.treeSearchInput.value = 'tree-A';
	view.changesQuery = 'changes-A';

	await view.activateFolder(b);
	assert.equal(view.repoPath, b);
	assert.equal(view.folderSessions.get(a).editor.location.line, 19);
	assert.equal(view.folderSessions.get(a).tabs.active.kind, 'code');
	assert.equal(view.folderSessions.get(a).search.query, 'needle-A');
	assert.equal(view.folderSessions.get(a).treeQuery, 'tree-A');
	assert.equal(view.folderSessions.get(a).changesQuery, 'changes-A');

	codePane.state = { name: 'B', currentPath: `${b}/lib/B.php`, location: { line: 4, column: 2, scrollTop: 91 } };
	editorTabs.state = { tabs: [{ filePath: `${b}/lib/B.php`, kind: 'code' }], active: { filePath: `${b}/lib/B.php`, kind: 'code' } };
	searchPanel.state = { query: 'needle-B', options: { wholeWord: true } };
	view.treeSearchInput.value = 'tree-B';
	view.changesQuery = 'changes-B';

	await view.activateFolder(a);
	assert.deepEqual(codePane.state, { name: 'A', currentPath: `${a}/src/A.php`, location: { line: 19, column: 8, scrollTop: 413 } });
	assert.equal(editorTabs.getActive().filePath, `${a}/src/A.php`);
	assert.equal(searchPanel.state.query, 'needle-A');
	assert.equal(searchPanel.roots.at(-1), a);
	assert.equal(view.treeSearchInput.value, 'tree-A');
	assert.equal(view.changesQuery, 'changes-A');
	assert.deepEqual(view.plugin.settings.openedFolderPaths, [a, b]);
	assert.equal(view.plugin.settings.lastOpenedPath, a);
});

test('late folder-tree callback after rapid A to B to A cannot replace the active A state or start B watching', async () => {
	const a = '/tmp/source-observer-rapid-a';
	const b = '/tmp/source-observer-rapid-b';
	const { view, harness, codePane } = setupView(a, [a, b]);
	const lateTree = deferred();
	const lateWorktrees = deferred();
	harness.treeResult.set(b, lateTree);
	harness.worktreeResult.set(b, lateWorktrees);

	const switchToB = view.activateFolder(b);
	assert.equal(view.repoPath, b);
	const switchToA = view.activateFolder(a);
	await switchToA;
	lateWorktrees.resolve(['/tmp/worktrees/b']);
	lateTree.resolve();
	await switchToB;

	assert.equal(view.repoPath, a);
	assert.notEqual(codePane.state.name, 'B');
	assert.equal(harness.watchRoots.includes(b), false);
	assert.equal(harness.watchRoots.at(-1), a);
	assert.equal(view.indexedWorktrees.length, 0);
});

test('late Git refresh from a deactivated folder cannot replace active changes or start its watcher', async () => {
	const a = '/tmp/source-observer-git-a';
	const b = '/tmp/source-observer-git-b';
	const { view, harness } = setupView(a, [a, b]);
	const lateGit = deferred();
	const lateChanges = deferred();
	harness.gitResult.set(b, lateGit);
	harness.changedResult.set(b, lateChanges);

	const switchToB = view.activateFolder(b);
	while (!harness.gitStarted.includes(b)) await new Promise((resolve) => setImmediate(resolve));
	const switchToA = view.activateFolder(a);
	await switchToA;
	const changesFromA = view.allChanges;
	lateGit.resolve(true);
	await new Promise((resolve) => setImmediate(resolve));
	lateChanges.resolve([{ file: 'stale-from-b.php', code: 'M' }]);
	await switchToB;

	assert.equal(view.repoPath, a);
	assert.deepEqual(view.allChanges, changesFromA);
	assert.equal(view.allChanges.some(({ file }) => file === 'stale-from-b.php'), false);
	assert.equal(harness.watchRoots.includes(b), false);
	assert.equal(harness.watchRoots.at(-1), a);
});

test('closing the final folder clears persisted folder selection', async () => {
	const a = '/tmp/source-observer-close-last';
	const { view, codePane } = setupView(a, [a]);
	await view.closeFolder(a);
	assert.deepEqual(view.folderPaths, []);
	assert.equal(view.repoPath, '');
	assert.deepEqual(view.plugin.settings.openedFolderPaths, []);
	assert.equal(view.plugin.settings.lastOpenedPath, '');
	assert.ok(view.plugin.savedSettingsCount > 0);
	assert.equal(codePane.state.currentPath, null);
});

test('Locate uses the active diff tab, clears the tree filter and expands the Files section', async () => {
 const root = '/tmp/source-observer-locate';
 const { view, editorTabs, codePane } = setupView(root);
 const file = `${root}/src/Changed.php`;
 codePane.state.currentPath = `${root}/Other.php`;
 editorTabs.state.active = { filePath: file, kind: 'diff' };
 view.treeSearchInput.value = 'unrelated';
 const changes = [], visits = [];
 view.treeSearchInput.closest = () => ({ querySelector: selector => ({
  removeClass: cls => changes.push([selector, cls]),
  setAttribute: (key, value) => changes.push([selector, key, value]),
  setText: value => changes.push([selector, value]),
 }) });
 view.fileTree.reveal = async value => { visits.push(value); return true; };
 await view.locateCurrentFile();
 assert.deepEqual(visits, [file]);
 assert.equal(view.treeSearchInput.value, '');
 assert.deepEqual(changes, [
  ['.so-section-body', 'so-section-body-hidden'],
  ['.so-section-toggle', 'aria-expanded', 'true'],
  ['.so-section-chevron', '▾'],
 ]);
 assert.deepEqual(codePane.opened, []);
});

test('Changes and its divider are hidden outside Git and resolve the selected nested repository', async () => {
 const parent = '/tmp/workspace', nested = '/tmp/workspace/project';
 const { view, harness } = setupView(parent);
 harness.gitResult.set(parent, { promise: Promise.resolve(false) });
 await view.refreshChanges();
 assert.equal(view.gitSection.hidden, true);
 assert.equal(view.gitSplitter.hidden, true);
 view.gitContext = { path: nested, isDirectory: true };
 await view.refreshChanges();
 assert.equal(view.gitSection.hidden, false);
 assert.equal(view.gitSplitter.hidden, false);
 assert.equal(harness.changesRoot, nested);
 view.gitContext = { path: parent, isDirectory: true };
 await view.refreshChanges();
 assert.equal(view.gitSection.hidden, true);
 assert.equal(view.gitSplitter.hidden, true);
});
test('late nested Git status cannot show Changes for a newer non-Git selection', async () => {
 const parent = '/tmp/workspace', nested = '/tmp/workspace/project';
 const { view, harness } = setupView(parent);
 const late = deferred(); harness.gitResult.set(nested, late);
 view.gitContext = { path: nested, isDirectory: true };
 const pending = view.refreshChanges();
 harness.gitResult.set(parent, { promise: Promise.resolve(false) });
 view.gitContext = { path: parent, isDirectory: true };
 await view.refreshChanges(); late.resolve(true); await pending;
 assert.equal(view.gitSection.hidden, true);
 assert.equal(view.gitRoot, '');
});

test('changing enabled languages replaces navigation and clears search-only clients', () => {
	const { view, codePane } = setupView('/project');
	const attached = [];
	codePane.setLsp = (lsp) => attached.push(lsp);
	view.searchLsps = new Map();
	view.plugin.settings.phpLsp = true;
	view.plugin.settings.goLsp = false;
	const sync = () => SourceObserverView.prototype.syncNavigation.call(view);
	sync();
	const php = view.languageNavigation;
	assert.deepEqual(php.adapters, ['php']);
	assert.equal(php.root, '/project');
	const searchClient = { disposed: false, dispose() { this.disposed = true; } };
	view.searchLsps.set('/other', searchClient);
	view.plugin.settings.goLsp = true;
	sync();
	assert.equal(php.disposed, true);
	assert.equal(searchClient.disposed, true);
	assert.equal(view.searchLsps.size, 0);
	assert.deepEqual(view.languageNavigation.adapters, ['php', 'go']);
	assert.equal(attached.at(-1), view.languageNavigation);
	const mixed = view.languageNavigation;
	view.plugin.settings.phpLsp = false;
	view.plugin.settings.goLsp = false;
	sync();
	assert.equal(mixed.disposed, true);
	assert.equal(view.languageNavigation, null);
	assert.equal(attached.at(-1), null);
});
