import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const temp = await mkdtemp(path.join(process.cwd(), 'tests', '.find-modal-'));
const bundle = path.join(temp, 'modal.mjs');
await build({ entryPoints: ['src/findInFilesModal.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle,
	plugins: [{ name: 'find-harness', setup(api) {
		api.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
		api.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: `
			export class Component {
				cleanups = []; load() {} register(fn) { this.cleanups.push(fn); }
				registerDomEvent(el, key, fn) { el.listeners.set(key, fn); this.cleanups.push(() => el.listeners.delete(key)); }
				unload() { this.cleanups.forEach(fn => fn()); this.cleanups = []; }
			}
			export class Modal {
				constructor() { this.modalEl = new globalThis.__findHarness.Element(); this.titleEl = this.modalEl.createDiv(); this.contentEl = this.modalEl.createDiv();
					this.hotkeys = new Map(); this.scope = { register: (_, key, fn) => this.hotkeys.set(key, fn) }; }
				setTitle() {} open() { this.onOpen(); } close() { this.onClose(); }
			}
			export class App {}
			export function setIcon() {}
		`, loader: 'js' }));
		api.onResolve({ filter: /^\.\/findInFilesScope$/ }, () => ({ path: 'scope', namespace: 'scope' }));
		api.onLoad({ filter: /.*/, namespace: 'scope' }, () => ({ contents: `
			export function initialFindState(context, saved) { return { query: '', area: 'project', module: context.root,
				namedScope: 'project', options: {}, ...saved }; }
			export function findModules(context) { return Promise.resolve([context.root]); }
			export function moduleForPath(modules) { return modules[0]; }
			export function searchFindInFiles(...args) { return globalThis.__findHarness.search(...args); }
		`, loader: 'js' }));
		api.onResolve({ filter: /^\.\/findInFilesPreview$/ }, () => ({ path: 'preview', namespace: 'preview' }));
		api.onLoad({ filter: /.*/, namespace: 'preview' }, () => ({ contents: `
			export class FindInFilesPreview {
				shown = []; clear() { this.shown = []; } show(...args) { this.shown.push(args); }
				dispose() { this.disposed = true; }
			}
		`, loader: 'js' }));
	} }],
});
const { FindInFilesModal } = await import(pathToFileURL(bundle).href);
test.after(() => rm(temp, { recursive: true, force: true }));

class Element {
	children = []; attrs = {}; dataset = {}; listeners = new Map(); value = ''; text = ''; id = '';
	get ownerDocument() { return globalThis.__findHarness.document; }
	addClass() {} select() {} scrollIntoView() {}
	setAttribute(key, value) { this.attrs[key] = value; if (key === 'id') this.id = value; }
	removeAttribute(key) { delete this.attrs[key]; }
	createEl(tag, options = {}) {
		const child = new Element(); child.parent = this; child.tag = tag; child.text = options.text ?? '';
		Object.entries(options.attr ?? {}).forEach(([key, value]) => child.setAttribute(key, value));
		this.children.push(child); return child;
	}
	createDiv(options) { return this.createEl('div', options); }
	createSpan(options) { return this.createEl('span', options); }
	appendText(text) { this.createEl('text', { text }); }
	empty() { this.children = []; this.text = ''; }
	setText(text) { this.empty(); this.text = text; }
	focus() { globalThis.__findHarness.focused = this; }
	contains(child) { return child === this || this.children.some(el => el.contains(child)); }
	querySelectorAll() { return this.children.flatMap(el => [...(el.dataset.index !== undefined ? [el] : []), ...el.querySelectorAll()]); }
	querySelector() { return null; }
	closest() { return this.dataset.index !== undefined ? this : this.parent?.closest(); }
}
const match = file => ({ filePath: `/project/${file}.php`, line: 9, column: 7, text: 'needle' });
const page = matches => ({ matches, totalMatches: matches.length, totalFiles: matches.length });
function setup() {
	const harness = { Element, focused: null, search: async () => page([]) };
	harness.document = { listeners: new Map(), defaultView: { listeners: new Map() }, get activeElement() { return harness.focused; } };
	globalThis.__findHarness = harness;
	globalThis.window = { setTimeout: () => 1, clearTimeout() {} };
	const opened = [], states = [];
	const modal = new FindInFilesModal({}, { root: '/project', openFiles: [], currentFile: null }, {},
		value => opened.push(value), state => states.push(state));
	modal.open(); modal.state.query = 'needle'; modal.query.value = 'needle';
	return { modal, harness, opened, states };
}

test('arrows preview without opening the main file; Enter opens once and cleans up', async () => {
	const { modal, harness, opened, states } = setup();
	harness.search = async () => page([match('A'), match('B')]);
	await modal.search(modal.generation);
	modal.hotkeys.get('ArrowDown')();
	assert.equal(modal.preview.shown.at(-1)[0].filePath, '/project/B.php');
	assert.equal(opened.length, 0);
	assert.equal(modal.query.attrs['aria-activedescendant'], 'so-find-result-1');
	modal.hotkeys.get('Enter')();
	assert.equal(opened[0].filePath, '/project/B.php');
	assert.equal(states.length, 1); assert.ok(modal.preview.disposed);
	assert.equal(modal.rows.listeners.size, 0);
});

test('a click selects nested result text; double-click opens that row', async () => {
	const { modal, harness, opened } = setup();
	harness.search = async () => page([match('A'), match('B')]);
	await modal.search(modal.generation);
	const target = modal.rows.children[1].children[0];
	modal.rows.listeners.get('click')({ target });
	assert.equal(opened.length, 0);
	assert.equal(modal.preview.shown.at(-1)[0].filePath, '/project/B.php');
	modal.rows.listeners.get('dblclick')({ target });
	assert.equal(opened[0].filePath, '/project/B.php');
});

test('query changes cancel old searches, clear selectable results and reject late results', async () => {
	const { modal, harness, opened } = setup();
	let resolveOld, oldSignal, oldState;
	harness.search = (_, state, signal) => { oldState = state; oldSignal = signal; return new Promise(resolve => { resolveOld = resolve; }); };
	const old = modal.search(modal.generation);
	modal.state.query = 'new'; modal.schedule();
	assert.equal(oldSignal.aborted, true);
	assert.equal(oldState.query, 'needle');
	modal.hotkeys.get('Enter')(); assert.equal(opened.length, 0);
	resolveOld(page([match('Late')])); await old;
	assert.equal(modal.matches.length, 0);
	modal.state.query = ''; modal.schedule();
	assert.equal(modal.rows.attrs['aria-busy'], 'false');
	modal.close();
});

test('closing while searching aborts and prevents late results from replacing disposed preview', async () => {
	const { modal, harness } = setup();
	let resolveSearch, signal;
	harness.search = (_, __, abort) => { signal = abort; return new Promise(resolve => { resolveSearch = resolve; }); };
	const pending = modal.search(modal.generation); modal.close();
	assert.equal(signal.aborted, true);
	resolveSearch(page([match('Late')])); await pending;
	assert.equal(modal.matches.length, 0); assert.ok(modal.preview.disposed);
});

test('named scopes disable path filters; Custom scope enables them and filter focus keeps native keys', () => {
	const { modal, opened } = setup();
	modal.setArea('scope');
	assert.ok(modal.pathFilters.every(input => input.disabled));
	modal.state.namedScope = 'custom'; modal.syncPathFilters();
	assert.ok(modal.pathFilters.every(input => !input.disabled));
	modal.pathFilters[0].focus();
	assert.equal(modal.hotkeys.get('Enter')(), undefined);
	assert.equal(opened.length, 0); modal.close();
});

test('Load more retains selection and only appears when additional results exist', async () => {
	const { modal, harness } = setup();
	harness.search = async () => ({ ...page([match('A'), match('B')]), totalMatches: 3 });
	await modal.search(modal.generation); modal.select(1);
	assert.equal(modal.more.hidden, false);
	harness.search = async () => page([match('A'), match('B'), match('C')]);
	modal.schedule(true); await modal.search(modal.generation);
	assert.equal(modal.selected, 1); assert.equal(modal.more.hidden, true);
	assert.equal(modal.preview.shown.at(-1)[0].filePath, '/project/B.php'); modal.close();
});

test('regex help preserves search results and restores focus; closing the search disposes help', async () => {
	const { modal, harness, states } = setup();
	harness.search = async () => page([match('A'), match('B')]);
	await modal.search(modal.generation);
	modal.hotkeys.get('ArrowDown')();
	const help = modal.filters.children[1].children.find(el => el.attrs['aria-label'] === 'Show expressions help');
	help.listeners.get('click')();
	assert.ok(modal.regexHelp);
	assert.equal(modal.state.query, 'needle');
	assert.equal(modal.selected, 1);
	assert.equal(modal.matches.length, 2);
	assert.equal(states.length, 0);
	modal.regexHelp.close();
	assert.equal(modal.regexHelp, null);
	assert.equal(harness.focused, modal.query);
	help.listeners.get('click')();
	const nested = modal.regexHelp;
	modal.close();
	assert.equal(modal.regexHelp, null);
	assert.equal(nested.contentEl.children.length, 0);
	assert.equal(states.length, 1);
});
