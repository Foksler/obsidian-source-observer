import { App, Component, Modal, setIcon } from 'obsidian';
import * as path from 'path';
import { findModules, initialFindState, moduleForPath, searchFindInFiles,
	type FindArea, type FindInFilesContext, type FindInFilesState, type NamedFindScope } from './findInFilesScope';
import { FindInFilesPreview } from './findInFilesPreview';
import { renderFindLocation, renderFindSnippet } from './findInFilesResults';
import { RegexHelpModal } from './regexHelpModal';
import { addVerticalSplitter } from './verticalSplitter';
import type { SearchMatch } from './searchEngine';
import type { SourceObserverSettings } from './settings';

export class FindInFilesModal extends Modal {
	private lifecycle = new Component();
	private state: FindInFilesState;
	private query!: HTMLInputElement;
	private count!: HTMLElement;
	private rows!: HTMLElement;
	private filters!: HTMLElement;
	private areaFields = new Map<FindArea, HTMLElement>();
	private areaButtons = new Map<FindArea, HTMLButtonElement>();
	private moduleSelect!: HTMLSelectElement;
	private pathFilters: HTMLInputElement[] = [];
	private advanced!: HTMLElement;
	private advancedButton!: HTMLButtonElement;
	private advancedOpen = false;
	private clearQuery!: HTMLButtonElement;
	private regexHelp: RegexHelpModal | null = null;
	private modulesReady = false;
	private preview!: FindInFilesPreview;
	private matches: SearchMatch[] = [];
	private selected = 0;
	private generation = 0;
	private controller: AbortController | null = null;
	private timer: number | null = null;
	private closed = true;
	private limit = 200;
	private total = 0;
	private more!: HTMLButtonElement;
	constructor(app: App, private context: FindInFilesContext, private settings: SourceObserverSettings,
		private chooseMatch: (match: SearchMatch) => void, private didClose: (state: FindInFilesState) => void, saved?: FindInFilesState) {
		super(app);
		this.state = initialFindState(context, saved);
		this.advancedOpen = !!(this.state.options.includeGlob || this.state.options.excludeGlob || this.state.options.includeWorktrees);
		this.modalEl.addClass('so-find-modal');
		this.setTitle('Find in files');
		for (const [key, delta] of [['ArrowDown', 1], ['ArrowUp', -1]] as const) {
			this.scope.register([], key, () => {
				if (!this.navigating()) return;
				if (this.matches.length) this.select((this.selected + delta + this.matches.length) % this.matches.length);
				return false;
			});
		}
		this.scope.register([], 'Enter', () => {
			if (!this.navigating()) return;
			this.choose(); return false;
		});
	}
	open() { super.open(); this.focus(); this.query.select(); }
	focus() { this.query.focus(); }
	private navigating() {
		const active = this.contentEl.ownerDocument.activeElement;
		return active === this.query || this.rows?.contains(active);
	}
	onOpen() {
		this.closed = false; this.lifecycle.load();
		this.modalEl.querySelector('.modal-close-button, .modal-header-button')?.remove();
		const head = this.contentEl.createDiv({ cls: 'so-find-head' });
		const heading = head.createDiv({ cls: 'so-find-heading' });
		heading.createEl('strong', { text: 'Find in files' });
		this.count = heading.createSpan({ attr: { role: 'status', 'aria-live': 'polite' } });
		const maskControls = head.createDiv({ cls: 'so-find-mask' });
		this.toggle(maskControls, 'File mask:', this.state.maskEnabled, (value) => { this.state.maskEnabled = value; mask.disabled = !value; });
		const mask = maskControls.createEl('input', { attr: { type: 'text', 'aria-label': 'File mask', placeholder: '*.php,*.ts',
			list: 'so-find-file-masks', spellcheck: 'false' } });
		mask.value = this.state.fileMask; mask.disabled = !this.state.maskEnabled;
		const masks = maskControls.createEl('datalist', { attr: { id: 'so-find-file-masks' } });
		for (const value of ['*.php', '*.ts,*.tsx', '*.js,*.jsx', '*.json', '*.xml']) masks.createEl('option', { attr: { value } });
		this.lifecycle.registerDomEvent(mask, 'input', () => { this.state.fileMask = mask.value; this.schedule(); });
		this.advancedButton = head.createEl('button', { cls: 'so-find-filter-toggle', attr: { type: 'button', 'aria-label': 'Search filters',
			'aria-expanded': 'false' } });
		setIcon(this.advancedButton, 'list-filter');
		this.lifecycle.registerDomEvent(this.advancedButton, 'click', () => { this.advancedOpen = !this.advancedOpen; this.syncPathFilters(); });
		this.filters = this.contentEl.createDiv({ cls: 'so-find-controls' });
		this.advanced = this.filters.createDiv({ cls: 'so-find-filter-options' });
		const search = this.filters.createDiv({ cls: 'so-find-search' });
		setIcon(search.createSpan({ cls: 'so-find-search-icon', attr: { 'aria-hidden': 'true' } }), 'search');
		this.query = search.createEl('input', { attr: { type: 'text', placeholder: 'Search text…', 'aria-label': 'Find in files', spellcheck: 'false', autocomplete: 'off',
			role: 'combobox', 'aria-controls': 'so-find-results', 'aria-expanded': 'true' } });
		this.query.value = this.state.query;
		this.lifecycle.registerDomEvent(this.query, 'input', () => { this.state.query = this.query.value; this.schedule(); });
		this.clearQuery = search.createEl('button', { cls: 'so-find-query-clear', attr: { type: 'button', 'aria-label': 'Clear search' } });
		setIcon(this.clearQuery, 'x');
		this.lifecycle.registerDomEvent(this.clearQuery, 'click', () => { this.state.query = ''; this.query.value = ''; this.schedule(); this.focus(); });
		for (const [key, label, hint] of [['caseSensitive', 'Cc', 'Match case'], ['wholeWord', 'W', 'Whole words'], ['regex', '.*', 'Regex']] as const) {
			const button = search.createEl('button', { text: label, attr: { type: 'button', 'aria-label': hint,
				'aria-pressed': String(!!this.state.options[key]) } });
			this.lifecycle.registerDomEvent(button, 'click', () => { this.state.options[key] = !this.state.options[key];
				button.setAttribute('aria-pressed', String(!!this.state.options[key])); this.schedule(); this.focus(); });
		}
		const help = search.createEl('button', { attr: { type: 'button', 'aria-label': 'Show expressions help' } });
		setIcon(help, 'circle-help');
		this.lifecycle.registerDomEvent(help, 'click', () => {
			this.regexHelp?.close();
			this.regexHelp = new RegexHelpModal(this.app, () => { this.regexHelp = null; if (!this.closed) this.focus(); });
			this.regexHelp.open();
		});
		const scope = this.filters.createDiv({ cls: 'so-find-scope' });
		const tabs = scope.createDiv({ cls: 'so-find-areas', attr: { role: 'tablist', 'aria-label': 'Search area' } });
		for (const [area, label] of [['project', 'In Project'], ['module', 'Module'], ['directory', 'Directory'], ['scope', 'Scope']] as const) {
			const button = tabs.createEl('button', { text: label, attr: { type: 'button', role: 'tab' } });
			this.areaButtons.set(area, button);
			this.lifecycle.registerDomEvent(button, 'click', () => this.setArea(area));
			this.areaFields.set(area, scope.createDiv({ cls: 'so-find-area-field' }));
		}
		this.areaFields.get('project')!.createSpan({ cls: 'so-find-root', text: this.context.root });
		this.moduleSelect = this.areaFields.get('module')!.createEl('select', { attr: { 'aria-label': 'Module' } });
		this.moduleSelect.createEl('option', { text: 'Loading modules…', attr: { value: this.context.root } });
		this.lifecycle.registerDomEvent(this.moduleSelect, 'change', () => { this.state.module = this.moduleSelect.value; this.schedule(); });
		const directoryField = this.areaFields.get('directory')!;
		const directory = directoryField.createEl('input', { attr: { type: 'text', 'aria-label': 'Directory', spellcheck: 'false' } });
		directory.value = this.state.directory;
		this.lifecycle.registerDomEvent(directory, 'input', () => { this.state.directory = directory.value; this.schedule(); });
		this.toggle(directoryField, 'Recursive', this.state.recursive, (value) => { this.state.recursive = value; });
		const scopes = this.areaFields.get('scope')!.createEl('select', { attr: { 'aria-label': 'Scope' } });
		for (const [value, label] of [['project', 'Project files'], ['open', 'Open files'], ['current', 'Current file'], ['custom', 'Custom scope']] as const)
			scopes.createEl('option', { text: label, attr: { value } });
		scopes.value = this.state.namedScope;
		this.lifecycle.registerDomEvent(scopes, 'change', () => { this.state.namedScope = scopes.value as NamedFindScope; this.syncPathFilters(); this.schedule(); });
		const options = this.advanced.createDiv({ cls: 'so-find-options' });
		this.toggle(options, 'Include worktrees', !!this.state.options.includeWorktrees, (value) => { this.state.options.includeWorktrees = value; });
		const patterns = this.advanced.createDiv({ cls: 'so-find-patterns' });
		for (const [key, label] of [['includeGlob', 'Include paths'], ['excludeGlob', 'Exclude paths']] as const) {
			const input = patterns.createEl('input', { attr: { type: 'text', 'aria-label': label, placeholder: `${label}: app/**` } });
			input.value = this.state.options[key] ?? '';
			this.pathFilters.push(input);
			this.lifecycle.registerDomEvent(input, 'input', () => { this.state.options[key] = input.value; this.schedule(); });
		}
		const body = this.contentEl.createDiv({ cls: 'so-search-body' });
		this.rows = body.createDiv({ cls: 'so-find-results', attr: { id: 'so-find-results', role: 'listbox', 'aria-label': 'Matches', tabindex: '0' } });
		this.lifecycle.registerDomEvent(this.rows, 'click', (event) => this.selectRow(event));
		this.lifecycle.registerDomEvent(this.rows, 'dblclick', (event) => { this.selectRow(event); this.choose(); });
		addVerticalSplitter(this.lifecycle, body);
		const preview = body.createDiv({ cls: 'so-find-preview' });
		this.preview = new FindInFilesPreview(preview.createDiv({ cls: 'so-find-preview-header' }), preview.createDiv({ cls: 'so-find-preview-code so-pane' }), this.settings, this.context.root);
		this.preview.clear();
		const footer = this.contentEl.createDiv({ cls: 'so-find-footer' });
		footer.createSpan({ text: '↑↓ preview · Enter / double-click open · Esc close' });
		this.more = footer.createEl('button', { text: 'Load more', attr: { type: 'button' } });
		this.more.hidden = true;
		this.lifecycle.registerDomEvent(this.more, 'click', () => { this.limit += 1000; this.schedule(true); });
		this.setArea(this.state.area);
		void this.loadModules();
	}
	private async loadModules() {
		const modules = await findModules(this.context);
		if (this.closed) return;
		this.moduleSelect.empty();
		for (const root of modules) this.moduleSelect.createEl('option', { text: path.relative(this.context.root, root) || path.basename(root), attr: { value: root } });
		this.state.module = modules.includes(this.state.module) ? this.state.module
			: moduleForPath(modules, this.context.selectedPath?.path ?? this.context.currentFile ?? this.context.root);
		this.moduleSelect.value = this.state.module;
		this.modulesReady = true;
		if (this.state.area === 'module') this.schedule();
	}
	private toggle(parent: HTMLElement, label: string, checked: boolean, change: (checked: boolean) => void) {
		const wrapper = parent.createEl('label');
		const input = wrapper.createEl('input', { attr: { type: 'checkbox' } }); input.checked = checked;
		wrapper.createSpan({ text: label });
		this.lifecycle.registerDomEvent(input, 'change', () => { change(input.checked); this.schedule(); });
	}
	private setArea(area: FindArea) {
		this.state.area = area;
		for (const [key, button] of this.areaButtons) button.setAttribute('aria-selected', String(key === area));
		for (const [key, field] of this.areaFields) field.hidden = key !== area;
		this.syncPathFilters();
		this.schedule();
	}
	private syncPathFilters() {
		const disabled = this.state.area === 'scope' && this.state.namedScope !== 'custom';
		for (const input of this.pathFilters) input.disabled = disabled;
		const expanded = this.advancedOpen || (this.state.area === 'scope' && this.state.namedScope === 'custom');
		this.advanced.hidden = !expanded;
		this.advancedButton.setAttribute('aria-expanded', String(expanded));
	}
	private cancel() {
		++this.generation;
		if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
		this.controller?.abort(); this.controller = null;
	}
	private schedule(more = false) {
		this.cancel();
		this.clearQuery.disabled = !this.state.query;
		if (!more) { this.limit = 200; this.matches = []; this.rows.empty(); this.preview.clear(); this.query.removeAttribute('aria-activedescendant'); }
		this.more.hidden = true;
		this.rows.setAttribute('aria-busy', 'false');
		if (!this.state.query) { this.count.setText('Enter text to search.'); return; }
		if (this.state.area === 'module' && !this.modulesReady) { this.count.setText('Loading modules…'); return; }
		this.count.setText('Searching…'); this.rows.setAttribute('aria-busy', 'true');
		const generation = this.generation;
		this.timer = window.setTimeout(() => { void this.search(generation); }, 80);
	}
	private async search(generation: number) {
		this.timer = null;
		if (this.closed || generation !== this.generation) return;
		const controller = new AbortController(); this.controller = controller;
		try {
			const state = { ...this.state, options: { ...this.state.options } };
			const page = await searchFindInFiles(this.context, state, controller.signal, this.limit);
			if (this.closed || generation !== this.generation) return;
			const previous = this.matches[this.selected];
			this.matches = page.matches; this.total = page.totalMatches;
			this.selected = Math.max(0, this.matches.findIndex((match) => match.filePath === previous?.filePath && match.line === previous.line && match.column === previous.column));
			this.count.setText(`${page.totalMatches} ${page.totalMatches === 1 ? 'match' : 'matches'} in ${page.totalFiles} ${page.totalFiles === 1 ? 'file' : 'files'}${page.totalMatches > page.matches.length ? ` (${page.matches.length} shown)` : ''}`);
			this.render();
		} catch (error) {
			if (this.closed || generation !== this.generation) return;
			this.count.setText(error instanceof Error ? error.message : String(error));
		} finally { if (!this.closed && generation === this.generation) this.rows.setAttribute('aria-busy', 'false'); }
	}
	private render() {
		this.rows.empty();
		for (const [index, match] of this.matches.entries()) {
			const row = this.rows.createDiv({ cls: 'so-find-row', attr: { id: `so-find-result-${index}`, role: 'option', 'aria-selected': String(index === this.selected) } });
			row.dataset.index = String(index);
			renderFindSnippet(row.createSpan({ cls: 'so-find-snippet' }), match, this.state.query, this.state.options);
			renderFindLocation(row.createSpan({ cls: 'so-find-location' }), this.context.root, match);
		}
		if (!this.matches.length) this.rows.setText('No matches.');
		this.more.hidden = this.total <= this.matches.length;
		this.select(this.selected, false);
	}
	private selectRow(event: MouseEvent) {
		const row = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
		if (row && this.rows.contains(row)) this.select(Number(row.dataset.index), false);
	}
	private select(index: number, scroll = true) {
		const match = this.matches[index]; if (!match) return;
		this.selected = index;
		for (const row of Array.from(this.rows.querySelectorAll<HTMLElement>('[data-index]'))) {
			const active = Number(row.dataset.index) === index; row.setAttribute('aria-selected', String(active));
			if (active) { this.query.setAttribute('aria-activedescendant', row.id); if (scroll) row.scrollIntoView({ block: 'nearest' }); }
		}
		void this.preview.show(match, this.state.query, this.state.options);
	}
	private choose() { const match = this.matches[this.selected]; if (match) { this.close(); this.chooseMatch(match); } }
	onClose() {
		this.closed = true; this.regexHelp?.close(); this.cancel(); this.preview.dispose(); this.lifecycle.unload(); this.contentEl.empty();
		this.didClose({ ...this.state, options: { ...this.state.options } });
	}
}
