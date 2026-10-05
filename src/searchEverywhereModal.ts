import { App, Component, Modal, setIcon } from 'obsidian';
import { FindInFilesPreview } from './findInFilesPreview';
import { addVerticalSplitter } from './verticalSplitter';
import type { SourceObserverSettings } from './settings';
import type { SearchOptions } from './searchEngine';
import {
	searchEverywhere, SEARCH_TABS, SEARCH_TAB_LABELS,
	type EverywhereBatch, type EverywhereContext, type EverywhereResult, type SearchTab,
} from './searchEverywhere';
import { batchSummary, renderEverywhereResults } from './searchEverywhereResults';

export interface EverywhereState {
	query: string;
	options: Omit<SearchOptions, 'query'>;
	scope: string;
	includeWorktrees: boolean;
}

/** A single keyboard-driven entry point for source navigation and text search. */
export class SearchEverywhereModal extends Modal {
	private lifecycle = new Component();
	private queryInput!: HTMLInputElement;
	private resultsEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private optionsEl!: HTMLElement;
	private scopeInput!: HTMLSelectElement;
	private availableRoots: string[];
	private tabs = new Map<SearchTab, HTMLButtonElement>();
	private batches = new Map<string, EverywhereBatch>();
	private results: EverywhereResult[] = [];
	private selected = 0;
	private generation = 0;
	private controller: AbortController | null = null;
	private timer: number | null = null;
	private closed = true;
	private options: Omit<SearchOptions, 'query'> = {};
	private limit = 200;
	private preview!: FindInFilesPreview;
	private previewId?: string;
	private filtersButton!: HTMLButtonElement;
	private previewEl!: HTMLElement;

	constructor(app: App, private context: EverywhereContext, private tab: SearchTab,
		private select: (result: EverywhereResult) => void, private didClose: (state: EverywhereState) => void,
		private settings: SourceObserverSettings, private initial?: EverywhereState) {
		super(app);
		this.availableRoots = [...new Set(context.roots ?? [context.root])];
		this.options = { ...initial?.options };
		if (initial) this.context.includeWorktrees = initial.includeWorktrees;
		this.modalEl.addClass('so-everywhere-modal');
		this.setTitle('Search everywhere');
		this.scope.register([], 'ArrowDown', () => { if (this.inOptions()) return; this.moveSelection(1); return false; });
		this.scope.register([], 'ArrowUp', () => { if (this.inOptions()) return; this.moveSelection(-1); return false; });
		this.scope.register([], 'Enter', () => { if (this.inOptions()) return; this.choose(); return false; });
		this.scope.register([], 'Tab', () => {
			if (this.inOptions()) return;
			this.cycleTab(1); return false;
		});
		this.scope.register(['Shift'], 'Tab', () => {
			if (this.inOptions()) return;
			this.cycleTab(-1); return false;
		});
		this.scope.register([], 'F6', () => {
			this.toggleFilters();
			return false;
		});
		this.scope.register(['Ctrl'], 'ArrowDown', () => { this.selectIndex(this.results.length - 1); return false; });
		this.scope.register(['Ctrl'], 'ArrowUp', () => { this.selectIndex(0); return false; });
		this.scope.register(['Alt'], 'ArrowDown', () => { this.jumpPane(true); return false; });
		this.scope.register(['Alt'], 'ArrowUp', () => { this.jumpPane(false); return false; });
	}

	open() {
		super.open();
		// Obsidian focuses the first tabbable button after onOpen returns.
		this.focus();
		this.queryInput.select();
	}

	private inOptions() {
		const focused = this.contentEl.ownerDocument?.activeElement;
		return this.optionsEl?.contains(focused) || this.previewEl?.contains(focused)
			|| focused?.getAttribute?.('role') === 'separator' || (focused?.tagName === 'BUTTON' && this.resultsEl?.contains(focused));
	}

	onOpen() {
		this.closed = false;
		this.lifecycle.load();
		this.modalEl.querySelector('.modal-close-button, .modal-header-button')?.remove();
		const head = this.contentEl.createDiv({ cls: 'so-everywhere-head' });
		const tabs = head.createDiv({ cls: 'so-everywhere-tabs', attr: { role: 'tablist', 'aria-label': 'Search category' } });
		for (const tab of ['all', 'classes', 'files', 'symbols', 'actions', 'text'] as const) {
			const button = tabs.createEl('button', { text: SEARCH_TAB_LABELS[tab], attr: { type: 'button', role: 'tab' } });
			this.tabs.set(tab, button);
			this.lifecycle.registerDomEvent(button, 'click', () => this.setTab(tab));
		}
		this.filtersButton = head.createEl('button', { cls: 'so-find-filter-toggle', attr: { type: 'button', 'aria-label': 'Search filters', 'aria-expanded': 'false' } });
		setIcon(this.filtersButton, 'list-filter');
		this.lifecycle.registerDomEvent(this.filtersButton, 'click', () => this.toggleFilters());
		const search = this.contentEl.createDiv({ cls: 'so-find-search so-everywhere-search' });
		setIcon(search.createSpan({ cls: 'so-find-search-icon', attr: { 'aria-hidden': 'true' } }), 'search');
		this.queryInput = search.createEl('input', { cls: 'so-everywhere-query', attr: {
			type: 'text', placeholder: 'Search everywhere…', 'aria-label': 'Search everywhere', spellcheck: 'false', autocomplete: 'off',
			role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'true', 'aria-controls': 'so-everywhere-results',
		} });
		this.queryInput.value = this.initial?.query ?? '';
		this.lifecycle.registerDomEvent(this.queryInput, 'input', () => this.schedule());
		this.optionsEl = this.contentEl.createDiv({ cls: 'so-everywhere-options' });
		this.optionsEl.hidden = true;
		const scope = this.optionsEl.createEl('label', { cls: 'so-everywhere-scope', text: 'Search in ' });
		this.scopeInput = scope.createEl('select', { attr: { 'aria-label': 'Search in' } });
		this.scopeInput.createEl('option', { text: 'All open folders', attr: { value: '' } });
		for (const root of this.availableRoots) this.scopeInput.createEl('option', { text: root, attr: { value: root } });
		this.scopeInput.value = this.availableRoots.includes(this.initial?.scope ?? '') ? this.initial!.scope : '';
		this.lifecycle.registerDomEvent(this.scopeInput, 'change', () => this.schedule());
		this.addToggle(this.optionsEl, 'Match case', !!this.options.caseSensitive, (value) => { this.options.caseSensitive = value; }, true);
		this.addToggle(this.optionsEl, 'Whole word', !!this.options.wholeWord, (value) => { this.options.wholeWord = value; }, true);
		this.addToggle(this.optionsEl, 'Regex', !!this.options.regex, (value) => { this.options.regex = value; }, true);
		this.addToggle(this.optionsEl, 'Include worktrees in files and text', this.context.includeWorktrees, (value) => { this.context.includeWorktrees = value; });
		const filters = this.optionsEl.createDiv({ cls: 'so-everywhere-filters' });
		for (const key of ['includeGlob', 'excludeGlob'] as const) {
			const label = key === 'includeGlob' ? 'Include files' : 'Exclude files';
			const input = filters.createEl('input', { attr: { type: 'text', placeholder: `${label}: **/*.php`, 'aria-label': label } });
			input.value = this.options[key] ?? '';
			this.lifecycle.registerDomEvent(input, 'input', () => { this.options[key] = input.value; this.schedule(); });
		}
		this.statusEl = this.contentEl.createDiv({ cls: 'so-everywhere-status', attr: { role: 'status', 'aria-live': 'polite' } });
		const body = this.contentEl.createDiv({ cls: 'so-search-body' });
		this.resultsEl = body.createDiv({ cls: 'so-everywhere-results', attr: { id: 'so-everywhere-results', role: 'listbox', 'aria-label': 'Search results' } });
		this.lifecycle.registerDomEvent(this.resultsEl, 'click', (event) => {
			const more = (event.target as HTMLElement).closest<HTMLElement>('[data-more]');
			if (more && this.resultsEl.contains(more)) { this.loadMore(); return; }
			const row = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
			if (!row || !this.resultsEl.contains(row)) return;
			this.selectIndex(Number(row.dataset.index), false);
		});
		this.lifecycle.registerDomEvent(this.resultsEl, 'dblclick', (event) => {
			const row = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
			if (row && this.resultsEl.contains(row)) { this.selectIndex(Number(row.dataset.index), false); this.choose(); }
		});
		addVerticalSplitter(this.lifecycle, body);
		const preview = this.previewEl = body.createDiv({ cls: 'so-find-preview' });
		this.preview = new FindInFilesPreview(preview.createDiv({ cls: 'so-find-preview-header' }), preview.createDiv({ cls: 'so-find-preview-code so-pane' }), this.settings, this.context.root);
		this.preview.clear();
		this.contentEl.createDiv({ cls: 'so-everywhere-hint', text: '↑↓ preview · Enter / double-click open · Tab category · F6 filters · Esc close' });
		this.setTab(this.tab);
	}

	setTab(tab: SearchTab) {
		this.tab = tab;
		for (const [key, button] of this.tabs) {
			button.setAttribute('aria-selected', String(key === tab));
			button.tabIndex = key === tab ? 0 : -1;
		}
		const content = tab === 'text' || tab === 'all';
		for (const toggle of Array.from(this.optionsEl.querySelectorAll<HTMLInputElement>('[data-text-option]'))) toggle.disabled = !content;
		this.queryInput.focus();
		this.schedule();
	}

	focus() { this.queryInput.focus(); }

	private toggleFilters() {
		this.optionsEl.hidden = !this.optionsEl.hidden;
		this.filtersButton.setAttribute('aria-expanded', String(!this.optionsEl.hidden));
		if (this.optionsEl.hidden) this.focus();
		else this.scopeInput.focus();
	}

	private cycleTab(direction: number) {
		const tabs = [...this.tabs.keys()];
		const index = (tabs.indexOf(this.tab) + direction + tabs.length) % tabs.length;
		this.setTab(tabs[index]!);
	}

	private addToggle(parent: HTMLElement, label: string, checked: boolean, change: (value: boolean) => void, textOnly = false) {
		const wrapper = parent.createEl('label', { cls: 'so-search-option' });
		const input = wrapper.createEl('input', { attr: { type: 'checkbox' } });
		input.checked = checked;
		if (textOnly) input.dataset.textOption = 'true';
		wrapper.createSpan({ text: label });
		this.lifecycle.registerDomEvent(input, 'change', () => { change(input.checked); this.schedule(); });
	}

	private cancel() {
		++this.generation;
		if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
		this.controller?.abort();
		this.controller = null;
	}

	private schedule(more = false) {
		this.cancel();
		if (!more) {
			this.limit = 200;
			this.batches.clear();
			this.results = [];
			this.selected = 0;
			this.resultsEl.empty();
			this.previewId = undefined;
			this.preview.clear();
			this.queryInput.removeAttribute('aria-activedescendant');
		}
		this.resultsEl.setAttribute('aria-busy', 'false');
		const query = this.queryInput.value;
		if (this.tab === 'text' && !query) { this.statusEl.setText('Enter text to search.'); return; }
		if ((this.tab === 'classes' || this.tab === 'symbols') && !this.context.symbols) {
			this.statusEl.setText('Enable language navigation in settings to search symbols.'); return;
		}
		this.statusEl.setText(!query.trim() && this.tab === 'all' ? 'Loading recent files…' : 'Searching…');
		this.resultsEl.setAttribute('aria-busy', 'true');
		const generation = this.generation;
		this.timer = window.setTimeout(() => { void this.search(generation); }, query ? 80 : 0);
	}

	private async search(generation: number) {
		this.timer = null;
		if (this.closed || generation !== this.generation) return;
		const controller = new AbortController();
		this.controller = controller;
		const context = { ...this.context, roots: this.scopeInput.value ? [this.scopeInput.value] : this.availableRoots };
		const query = this.queryInput.value;
		const tab = this.tab;
		await searchEverywhere(context, tab, query, { ...this.options, limit: this.limit }, controller.signal, (batch) => {
			if (this.closed || generation !== this.generation) return;
			this.batches.set(batch.category, batch);
			this.renderResults();
			this.updateStatus(true);
		});
		if (this.closed || generation !== this.generation) return;
		this.resultsEl.setAttribute('aria-busy', 'false');
		if (!this.results.length) this.resultsEl.setText('No results.');
		this.updateStatus(false);
	}

	private updateStatus(pending: boolean) {
		const summary = [...this.batches.values()].map(batchSummary).join(' · ') || '0 results';
		const errors = [...this.batches.values()].some((batch) => batch.error);
		this.statusEl.setText(`${summary}${pending ? ' · Searching…' : ''}${errors ? ' · Some searches failed; see details below.' : ''}`);
	}

	private loadMore() {
		if (this.timer !== null || ![...this.batches.values()].some((batch) => batch.truncated)) return;
		this.limit += 1000;
		this.schedule(true);
		this.focus();
	}

	private jumpPane(text: boolean) {
		const index = this.results.findIndex((result) => (result.category === 'text') === text);
		if (index >= 0) this.selectIndex(index);
	}

	private renderResults() {
		const selectedId = this.results[this.selected]?.id;
		this.results = SEARCH_TABS.flatMap((tab) => this.batches.get(tab)?.results ?? []);
		this.selected = Math.max(0, this.results.findIndex((result) => result.id === selectedId));
		renderEverywhereResults(this.resultsEl, this.batches, this.results, this.selected,
			this.queryInput.value, this.options, setIcon);
		this.selectIndex(this.selected, false);
	}

	private moveSelection(direction: number) {
		if (this.results.length) this.selectIndex((this.selected + direction + this.results.length) % this.results.length);
	}

	private selectIndex(index: number, scroll = true) {
		if (!this.results.length) return;
		this.selected = index;
		const rows = Array.from(this.resultsEl.querySelectorAll<HTMLElement>('[role="option"]'));
		rows.forEach((row, current) => row.setAttribute('aria-selected', String(index === current)));
		const row = rows[index];
		if (row) {
			this.queryInput.setAttribute('aria-activedescendant', row.id);
			if (scroll) row.scrollIntoView({ block: 'nearest' });
		}
		const result = this.results[index];
		if (!result || this.previewId === result.id) return;
		this.previewId = result.id;
		if (!result.filePath) { this.preview.clear(); return; }
		void this.preview.show({ filePath: result.filePath, line: result.line ?? 1, column: result.column ?? 1, text: result.name },
			this.queryInput.value, result.category === 'text' ? this.options : {}, result.rootPath ?? this.context.root);
	}

	private choose() {
		const result = this.results[this.selected];
		if (!result) return;
		this.close();
		this.select(result);
	}

	onClose() {
		this.closed = true;
		this.cancel();
		this.preview.dispose();
		const state: EverywhereState = { query: this.queryInput.value, options: { ...this.options }, scope: this.scopeInput.value,
			includeWorktrees: this.context.includeWorktrees };
		this.lifecycle.unload();
		this.contentEl.empty();
		this.didClose(state);
	}
}
