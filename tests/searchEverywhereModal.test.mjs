import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const temp = await mkdtemp(path.join(process.cwd(), 'tests', '.search-modal-'));
const bundle = path.join(temp, 'modal.mjs');
await build({
	entryPoints: ['src/searchEverywhereModal.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle,
	plugins: [{ name: 'modal-harness', setup(api) {
		api.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
		api.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: `
			export class Component {
				cleanups = [];
				load() {}
				register(fn) { this.cleanups.push(fn); }
				registerDomEvent(el, key, handler) { el.listeners.set(key, handler); this.cleanups.push(() => el.listeners.delete(key)); }
				unload() { this.cleanups.forEach(fn => fn()); this.cleanups = []; }
			}
			export class Modal {
				constructor() {
					this.modalEl = new globalThis.__modalHarness.Element();
					this.contentEl = this.modalEl.createDiv();
					this.hotkeys = new Map();
					this.scope = { register: (modifiers, key, handler) => this.hotkeys.set([...modifiers, key].join('+'), handler) };
				}
				setTitle() {}
				open() { this.onOpen(); this.contentEl.children[0].children[0].focus(); }
				close() { this.onClose(); }
			}
			export class App {}
			export function setIcon() {}
		`, loader: 'js' }));
		api.onResolve({ filter: /^\.\/findInFilesPreview$/ }, () => ({ path: 'preview', namespace: 'preview' }));
		api.onLoad({ filter: /.*/, namespace: 'preview' }, () => ({ contents: `
			export class FindInFilesPreview { shown = []; clear() { this.shown = []; } show(...args) { this.shown.push(args); } dispose() { this.disposed = true; } }
		`, loader: 'js' }));
		api.onResolve({ filter: /^\.\/searchEverywhere$/ }, () => ({ path: 'provider', namespace: 'provider' }));
		api.onLoad({ filter: /.*/, namespace: 'provider' }, () => ({ contents: `
			export const SEARCH_TABS = ['all', 'files', 'classes', 'symbols', 'actions', 'text'];
			export const SEARCH_TAB_LABELS = Object.fromEntries(SEARCH_TABS.map(tab => [tab, tab]));
			export function searchEverywhere(...args) { return globalThis.__modalHarness.search(...args); }
		`, loader: 'js' }));
	} }],
});
const { SearchEverywhereModal } = await import(pathToFileURL(bundle).href);
test.after(() => rm(temp, { recursive: true, force: true }));

class Element {
	children = [];
	attrs = {};
	dataset = {};
	listeners = new Map();
	value = '';
	text = '';
	disabled = false;
	id = '';
	get ownerDocument() { return globalThis.__modalHarness.document; }
	querySelector() { return null; }
	addClass() {}
	toggleClass() {}
	select() {}
	appendText(text) { this.createEl('text', { text }); }
	setAttribute(key, value) { this.attrs[key] = value; if (key === 'id') this.id = value; }
	removeAttribute(key) { delete this.attrs[key]; }
	createEl(tag, options = {}) {
		const child = new Element(); child.parent = this; child.tag = tag;
		Object.entries(options.attr ?? {}).forEach(([key, value]) => child.setAttribute(key, value));
		child.text = options.text ?? ''; this.children.push(child); return child;
	}
	createDiv(options) { return this.createEl('div', options); }
	createSpan(options) { return this.createEl('span', options); }
	empty() { this.children = []; this.text = ''; }
	setText(value) { this.text = value; this.children = []; }
	focus() { globalThis.__modalHarness.focused = this; }
	scrollIntoView() {}
	querySelectorAll(selector) {
		const matches = selector === '[data-text-option]' ? (el) => el.dataset.textOption
			: selector === '[role="option"]' ? (el) => el.attrs.role === 'option' : () => false;
		return this.children.flatMap((el) => [...(matches(el) ? [el] : []), ...el.querySelectorAll(selector)]);
	}
	contains(child) { return child === this || this.children.some((el) => el.contains(child)); }
	closest(selector) {
		const key = selector === '[data-more]' ? 'more' : 'index';
		return this.dataset[key] !== undefined ? this : this.parent?.closest(selector);
	}
}

function setup(tab = 'all', symbols = undefined, initial = undefined, roots = ['/project']) {
	const harness = { Element, calls: [], focused: null, async search(...args) { this.calls.push(args); } };
	harness.document = { listeners: new Map(), defaultView: { listeners: new Map() }, get activeElement() { return harness.focused; } };
	globalThis.__modalHarness = harness;
	globalThis.window = { setTimeout() { return 1; }, clearTimeout() {} };
	const opened = [];
	const states = [];
	let closes = 0;
	const modal = new SearchEverywhereModal({}, { root: '/project', roots, includeWorktrees: false, showHidden: true, recentFiles: [], actions: [], symbols },
		tab, (result) => opened.push(result), (state) => { states.push(state); closes++; }, {}, initial);
	modal.open();
	return { modal, harness, opened, states, closes: () => closes };
}

function file(id, category = 'files') { return { id, category, name: id, detail: id, filePath: `/project/${id}` }; }

test('category keys follow the visible tab order, keep focus and disable text controls on Classes', () => {
	const { modal, harness } = setup();
	modal.hotkeys.get('Tab')();
	assert.equal(modal.tab, 'classes');
	assert.equal(harness.focused, modal.queryInput);
	assert.ok(modal.optionsEl.querySelectorAll('[data-text-option]').every((el) => el.disabled));
	modal.hotkeys.get('Shift+Tab')();
	assert.equal(modal.tab, 'all');
	assert.ok(modal.optionsEl.querySelectorAll('[data-text-option]').every((el) => !el.disabled));
	modal.close();
});

test('arrow selection and Enter open the selected result, close once and remove listeners', () => {
	const { modal, opened, closes } = setup();
	modal.batches.set('files', { category: 'files', results: [file('A.php'), file('B.php')] });
	modal.renderResults();
	modal.hotkeys.get('ArrowDown')();
	assert.equal(modal.queryInput.attrs['aria-activedescendant'], 'so-everywhere-result-1');
	modal.hotkeys.get('Enter')();
	assert.equal(opened[0].filePath, '/project/B.php');
	assert.equal(closes(), 1);
	assert.equal(modal.resultsEl.listeners.size, 0);
});

test('click previews nested result text; double-click opens the selected row', () => {
	const { modal, opened } = setup();
	modal.batches.set('files', { category: 'files', results: [file('A.php'), file('B.php')] });
	modal.renderResults();
	const nestedText = modal.resultsEl.querySelectorAll('[role="option"]')[1].children[0].children[1];
	modal.resultsEl.listeners.get('click')({ target: nestedText });
	assert.equal(opened.length, 0);
	assert.equal(modal.preview.shown.at(-1)[0].filePath, '/project/B.php');
	modal.resultsEl.listeners.get('dblclick')({ target: nestedText });
	assert.equal(opened[0].filePath, '/project/B.php');
});

test('query changes clear selectable stale results and reject batches from an earlier request', async () => {
	const { modal, harness, opened } = setup();
	let publishOld;
	let resolveOld;
	harness.search = (...args) => { publishOld = args[5]; return new Promise((resolve) => { resolveOld = resolve; }); };
	const old = modal.search(modal.generation);
	publishOld({ category: 'files', results: [file('Old.php')] });
	assert.equal(modal.results.length, 1);
	modal.queryInput.value = 'new';
	modal.schedule();
	modal.hotkeys.get('Enter')();
	assert.equal(opened.length, 0);
	publishOld({ category: 'files', results: [file('Late.php')] });
	resolveOld();
	await old;
	assert.equal(modal.results.length, 0);
	modal.close();
});

test('All keeps named and text results in one list; Text shows the same matches', () => {
	const { modal } = setup();
	modal.queryInput.value = 'needle';
	modal.batches.set('files', { category: 'files', results: Array.from({ length: 10 }, (_, i) => file(`F${i}.php`)) });
	modal.batches.set('text', { category: 'text', results: [file('needle', 'text')] });
	modal.renderResults();
	assert.equal(modal.results.length, 11);
	assert.equal(modal.resultsEl.children.length, 1);
	assert.equal(modal.resultsEl.querySelectorAll('[role="option"]').length, 11);
	modal.hotkeys.get('Alt+ArrowDown')();
	assert.equal(modal.results[modal.selected].category, 'text');
	modal.setTab('text');
	modal.batches.set('text', { category: 'text', results: [file('needle', 'text')] });
	modal.renderResults();
	assert.equal(modal.results[0].category, 'text');
	modal.close();
});

test('disabled language navigation gives a helpful state without starting a provider request', () => {
	const { modal, harness } = setup('classes');
	assert.match(modal.statusEl.text, /Enable language navigation/);
	assert.equal(modal.timer, null);
	assert.equal(harness.calls.length, 0);
	modal.close();
});

test('opening restores query, filters and scope and focuses the query after host autofocus', async () => {
	const initial = { query: 'Needle', options: { caseSensitive: true, includeGlob: '**/*.php' }, scope: '/other', includeWorktrees: true };
	const { modal, harness, states } = setup('all', undefined, initial, ['/project', '/other']);
	assert.equal(harness.focused, modal.queryInput);
	assert.equal(modal.queryInput.value, 'Needle');
	await modal.search(modal.generation);
	assert.deepEqual(harness.calls[0][0].roots, ['/other']);
	assert.equal(harness.calls[0][3].caseSensitive, true);
	assert.equal(harness.calls[0][0].includeWorktrees, true);
	modal.close();
	assert.deepEqual(states[0], initial);
});

test('all folders is explicit and changing scope cancels selectable results from the previous folder', async () => {
	const { modal, harness, opened } = setup('all', undefined, undefined, ['/project', '/other']);
	await modal.search(modal.generation);
	assert.deepEqual(harness.calls[0][0].roots, ['/project', '/other']);
	modal.batches.set('files', { category: 'files', results: [file('Old.php')] });
	modal.renderResults();
	modal.scopeInput.value = '/other';
	modal.scopeInput.listeners.get('change')();
	modal.hotkeys.get('Enter')();
	assert.equal(opened.length, 0);
	await modal.search(modal.generation);
	assert.deepEqual(harness.calls[1][0].roots, ['/other']);
	modal.close();
});

test('load more exposes the full total, retains selection and can run before a slow PHP provider completes', async () => {
	const { modal, harness } = setup();
	modal.queryInput.value = 'needle';
	modal.timer = null;
	modal.batches.set('text', { category: 'text', results: [file('needle-0', 'text'), file('needle-1', 'text')],
		total: 1300, fileCount: 10, truncated: true });
	modal.renderResults();
	modal.updateStatus(true);
	assert.match(modal.statusEl.text, /1300 text matches in 10 files \(2 shown\)/);
	modal.selectIndex(1);
	const more = modal.resultsEl.children[0].children.at(-1);
	modal.resultsEl.listeners.get('click')({ target: more });
	assert.equal(modal.limit, 1200);
	assert.equal(modal.results[modal.selected].id, 'needle-1');
	harness.search = async (...args) => {
		harness.calls.push(args);
		args[5]({ category: 'text', results: [file('needle-0', 'text'), file('needle-1', 'text'), file('needle-2', 'text')], total: 3, fileCount: 1 });
	};
	await modal.search(modal.generation);
	assert.equal(harness.calls[0][3].limit, 1200);
	assert.equal(modal.results[modal.selected].id, 'needle-1');
	assert.equal(modal.resultsEl.children[0].children.at(-1).tag, 'div');
	modal.close();
});

test('a later file batch retains the selected text occurrence and literal highlighting does not interpret markup', () => {
	const { modal } = setup();
	modal.queryInput.value = '<script>';
	modal.batches.set('text', { category: 'text', results: [{ ...file('x', 'text'), name: 'plain <script> text' }] });
	modal.renderResults();
	modal.batches.set('files', { category: 'files', results: [file('A.php')] });
	modal.renderResults();
	assert.equal(modal.results[modal.selected].id, 'x');
	const title = modal.resultsEl.querySelectorAll('[role="option"]')[1].children[0].children[1];
	assert.equal(title.children[1].tag, 'mark');
	assert.equal(title.children[1].text, '<script>');
	modal.close();
});


test('preview tracks keyboard selection and uses the result root; actions clear the previous source', () => {
 const { modal, opened } = setup();
 modal.batches.set('files', { category: 'files', results: [{ ...file('A.php'), rootPath: '/other' }] });
 modal.batches.set('actions', { category: 'actions', results: [{ id: 'action', category: 'actions', name: 'Run', detail: '' }] });
 modal.renderResults();
 assert.equal(modal.preview.shown.at(-1)[3], '/other');
 modal.hotkeys.get('ArrowDown')();
 assert.equal(modal.preview.shown.length, 0);
 assert.equal(opened.length, 0);
 modal.close();
 assert.ok(modal.preview.disposed);
});

test('filters are initially collapsed and F6 opens them and returns focus to query', () => {
 const { modal, harness } = setup();
 assert.equal(modal.optionsEl.hidden, true);
 modal.hotkeys.get('F6')();
 assert.equal(modal.optionsEl.hidden, false);
 assert.equal(harness.focused, modal.scopeInput);
 modal.hotkeys.get('F6')();
 assert.equal(modal.optionsEl.hidden, true);
 assert.equal(harness.focused, modal.queryInput);
 modal.close();
});
