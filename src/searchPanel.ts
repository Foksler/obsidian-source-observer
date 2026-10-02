import * as path from 'path';
import { listFilesDetailed, searchContent, warmFileIndex, type SearchOptions, type SearchResultSet } from './searchEngine';
import { searchPreview } from './searchPreview';

export type SearchSelection = (filePath: string, line?: number, column?: number) => void;

/** Reusable VS Code-like full-text and file quick-open panel. */
export class SearchPanel {
	private container: HTMLElement;
	private onSelect: SearchSelection;
	private onIncludeWorktrees?: (include: boolean) => void;
	private rootPath = '';
	private includeWorktrees = false;
	private showHidden = true;
	private disposed = false;
	private debounceTimer: number | null = null;
	private abortController: AbortController | null = null;
	private queryInput!: HTMLInputElement;
	private modeSelect!: HTMLSelectElement;
	private results!: HTMLElement;
	private summary!: HTMLElement;
	private caseSensitive = false;
	private wholeWord = false;
	private regex = false;
	private mode: 'content' | 'files' = 'content';
	private includeGlob = '';
	private excludeGlob = '';
	private generation = 0;
	private scheduledAt = 0;
	/** Local timing diagnostics; never persisted or sent anywhere. */
	lastSearchTiming: { query: string; mode: string; elapsedMs: number; paintMs?: number } | null = null;

	constructor(container: HTMLElement, onSelect: SearchSelection, onIncludeWorktrees?: (include: boolean) => void) {
		this.container = container;
		this.onSelect = onSelect;
		this.onIncludeWorktrees = onIncludeWorktrees;
		this.render();
	}

	setRoot(dir: string) {
		if (this.rootPath === dir) return;
		this.rootPath = dir;
		this.warmFiles();
		this.scheduleSearch();
	}

	setIncludeWorktrees(include: boolean) {
		if (this.includeWorktrees === include) return;
		this.includeWorktrees = include;
		this.warmFiles();
		const toggle = this.container.querySelector<HTMLInputElement>('.so-search-worktrees');
		if (toggle) toggle.checked = include;
		this.onIncludeWorktrees?.(include);
		this.scheduleSearch();
	}

	setShowHidden(showHidden: boolean) {
		if (this.showHidden === showHidden) return;
		this.showHidden = showHidden;
		this.scheduleSearch();
	}

	focus(mode?: 'content' | 'files') {
		if (mode) {
			this.mode = mode;
			this.modeSelect.value = mode;
			this.queryInput.placeholder = mode === 'content' ? 'Search in files' : 'Go to file';
			this.updateContentOptions();
		}
		this.queryInput.focus();
		this.queryInput.select();
		this.scheduleSearch();
	}

	dispose() {
		this.disposed = true;
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.abortController?.abort();
	}

	private warmFiles() {
		if (!this.rootPath || this.disposed) return;
		const root = this.rootPath;
		const include = this.includeWorktrees;
		void warmFileIndex(root, include).catch(() => {
			// A query reports errors; speculative warming does not notify users.
		});
	}

	private render() {
		this.container.empty();
		this.container.addClass('so-search-panel');
		const toolbar = this.container.createDiv({ cls: 'so-search-toolbar' });
		this.queryInput = toolbar.createEl('input', {
			cls: 'so-search-query',
			attr: { type: 'search', placeholder: 'Search in files', 'aria-label': 'Search in files' },
		});
		this.queryInput.addEventListener('input', () => this.scheduleSearch());
		this.modeSelect = toolbar.createEl('select', { cls: 'so-search-mode', attr: { 'aria-label': 'Search mode' } });
		this.modeSelect.createEl('option', { text: 'Content' }).value = 'content';
		this.modeSelect.createEl('option', { text: 'Files' }).value = 'files';
		this.modeSelect.addEventListener('change', () => {
			this.mode = this.modeSelect.value as 'content' | 'files';
			this.queryInput.placeholder = this.mode === 'content' ? 'Search in files' : 'Go to file';
			this.updateContentOptions();
			this.scheduleSearch();
		});

		const options = this.container.createDiv({ cls: 'so-search-options' });
		this.addToggle(options, 'Match case', 'case', (value) => { this.caseSensitive = value; });
		this.addToggle(options, 'Whole word', 'word', (value) => { this.wholeWord = value; });
		this.addToggle(options, 'Use regular expression', 'regex', (value) => { this.regex = value; });
		const worktreeLabel = options.createEl('label', { cls: 'so-search-option' });
		const worktree = worktreeLabel.createEl('input', { cls: 'so-search-worktrees', attr: { type: 'checkbox' } });
		worktree.checked = this.includeWorktrees;
		worktreeLabel.createSpan({ text: 'Include worktrees' });
		worktree.addEventListener('change', () => this.setIncludeWorktrees(worktree.checked));

		const globs = this.container.createDiv({ cls: 'so-search-globs' });
		const include = globs.createEl('input', { attr: { type: 'text', placeholder: 'Include files: **/*.ts', 'aria-label': 'Include globs' } });
		const exclude = globs.createEl('input', { attr: { type: 'text', placeholder: 'Exclude files: **/*.test.ts', 'aria-label': 'Exclude globs' } });
		include.addEventListener('input', () => { this.includeGlob = include.value; this.scheduleSearch(); });
		exclude.addEventListener('input', () => { this.excludeGlob = exclude.value; this.scheduleSearch(); });
		this.summary = this.container.createDiv({ cls: 'so-search-summary', attr: { role: 'status', 'aria-live': 'polite' } });
		this.results = this.container.createDiv({ cls: 'so-search-results', attr: { role: 'list' } });
		this.showMessage('Open a folder and enter a search.');
	}

	private addToggle(parent: HTMLElement, label: string, _key: string, onChange: (value: boolean) => void) {
		const wrapper = parent.createEl('label', { cls: 'so-search-option' });
		const input = wrapper.createEl('input', { attr: { type: 'checkbox' } });
		input.dataset.contentOption = 'true';
		wrapper.createSpan({ text: label });
		input.addEventListener('change', () => { onChange(input.checked); this.scheduleSearch(); });
	}

	private updateContentOptions() {
		for (const input of Array.from(this.container.querySelectorAll<HTMLInputElement>('[data-content-option]'))) {
			input.disabled = this.mode === 'files';
		}
	}

	private scheduleSearch() {
		if (this.disposed) return;
		this.generation++;
		this.scheduledAt = performance.now();
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.abortController?.abort();
		// Filename lookup uses a shared in-memory index. Content queries have a
		// short pause to coalesce typing without adding a perceptible 150ms wait.
		this.debounceTimer = window.setTimeout(() => { void this.search(); }, this.mode === 'files' ? 0 : 20);
	}

	private async search() {
		const generation = this.generation;
		const started = this.scheduledAt;
		const mode = this.mode;
		const query = this.queryInput.value;
		if (!this.rootPath) { this.showMessage('Open a folder first.'); return; }
		if (query.length === 0) { this.showMessage(this.mode === 'content' ? 'Enter text to search.' : 'Enter a file name.'); return; }
		const controller = new AbortController();
		this.abortController = controller;
		this.results.setAttribute('aria-busy', 'true');
		try {
			if (mode === 'files') {
				const { files, truncated } = await listFilesDetailed(
					this.rootPath, query, controller.signal, this.includeWorktrees, this.includeGlob, this.excludeGlob,
					this.showHidden,
				);
				if (controller.signal.aborted || this.disposed) return;
				if (!files.length) this.showMessage('No matching files.');
				else {
					const batch = this.results.ownerDocument.createElement('div');
					for (const file of files) this.renderFile(file, batch);
					this.results.replaceChildren(...Array.from(batch.childNodes));
				}
				this.setSummary(files.length, 0, truncated);
				this.recordTiming(generation, query, mode, started);
				return;
			}
			const options: SearchOptions = {
				query,
				caseSensitive: this.caseSensitive,
				wholeWord: this.wholeWord,
				regex: this.regex,
				includeGlob: this.includeGlob,
				excludeGlob: this.excludeGlob,
				includeWorktrees: this.includeWorktrees,
				limit: 1000,
			};
			const groups = await searchContent(this.rootPath, options, controller.signal);
			if (controller.signal.aborted || this.disposed) return;
			this.renderGroups(groups);
			this.recordTiming(generation, query, mode, started);
		} catch (error) {
			if (controller.signal.aborted || this.disposed) return;
			this.showMessage(error instanceof Error && error.message.includes('regular expression')
				? `Invalid regular expression: ${error.message}`
				: `Search failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (generation === this.generation) this.results.setAttribute('aria-busy', 'false');
		}
	}

	private recordTiming(generation: number, query: string, mode: string, started: number) {
		const timing = { query, mode, elapsedMs: performance.now() - started, paintMs: 0 };
		this.lastSearchTiming = timing;
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				if (!this.disposed && generation === this.generation) timing.paintMs = performance.now() - started;
			});
		});
	}

	private renderGroups(groups: SearchResultSet) {
		if (!groups.length) { this.showMessage('No results.'); return; }
		const batch = this.results.ownerDocument.createElement('div');
		let matchCount = 0;
		const highlight = this.createTextHighlighter();
		for (const group of groups) {
			const section = batch.createDiv({ cls: 'so-search-file-group' });
			const id = `so-search-group-${Math.random().toString(36).slice(2)}`;
			const header = section.createEl('button', {
				cls: 'so-search-file',
				text: `${path.relative(this.rootPath, group.filePath)} (${group.matches.length})`,
				attr: { type: 'button', 'aria-expanded': 'true', 'aria-controls': id },
			});
			header.title = group.filePath;
			const matches = section.createDiv({ cls: 'so-search-file-matches', attr: { id } });
			header.addEventListener('click', () => {
				const expanded = header.getAttribute('aria-expanded') === 'true';
				header.setAttribute('aria-expanded', String(!expanded));
				matches.hidden = expanded;
			});
			for (const match of group.matches) {
				matchCount++;
				const preview = searchPreview(match.text, match.column);
				const row = matches.createEl('button', {
					cls: 'so-search-match',
					attr: { type: 'button', role: 'listitem', 'aria-label': `${path.basename(match.filePath)}, line ${match.line}: ${preview}` },
				});
				row.createSpan({ cls: 'so-search-line-number', text: String(match.line) });
				const lineText = row.createSpan({ cls: 'so-search-match-text' });
				highlight(lineText, preview);
				row.addEventListener('click', () => this.onSelect(match.filePath, match.line, match.column));
			}
		}
		this.results.replaceChildren(...Array.from(batch.childNodes));
		this.setSummary(matchCount, groups.length, groups.truncated);
	}

	private renderFile(filePath: string, parent: HTMLElement) {
		const row = parent.createEl('button', {
			cls: 'so-search-file so-search-file-result',
			text: path.relative(this.rootPath, filePath),
			attr: { type: 'button', role: 'listitem', 'aria-label': `Open ${path.relative(this.rootPath, filePath)}` },
		});
		row.title = filePath;
		row.addEventListener('click', () => this.onSelect(filePath));
	}

	private showMessage(message: string) {
		this.results.empty();
		this.summary.setText('');
		this.results.createDiv({ cls: 'so-search-status', text: message });
	}

	private setSummary(count: number, fileCount: number, truncated: boolean) {
		const summary = this.mode === 'files'
			? `${count}${truncated ? '+' : ''} files`
			: `${count}${truncated ? '+' : ''} results in ${fileCount}${truncated ? '+' : ''} files`;
		this.summary.setText(`${summary}${truncated ? ' · Refine your search to see more.' : ''}`);
	}

	private createTextHighlighter(): (target: HTMLElement, text: string) => void {
		const source = this.regex ? this.queryInput.value : this.queryInput.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		if (!source) return (target, text) => target.setText(text);
		let matcher: RegExp;
		try { matcher = new RegExp(source, `${this.caseSensitive ? '' : 'i'}g`); }
		catch { return (target, text) => target.setText(text); }
		const isWord = (value: string) => /[\p{L}\p{N}_]/u.test(value);
		return (target, text) => {
			matcher.lastIndex = 0;
			let cursor = 0;
			let match: RegExpExecArray | null;
			while ((match = matcher.exec(text)) !== null) {
				if (match[0].length === 0) { matcher.lastIndex++; continue; }
				const before = text[match.index - 1] ?? '';
				const after = text[match.index + match[0].length] ?? '';
				if (this.wholeWord && (isWord(before) || isWord(after))) continue;
				if (match.index > cursor) target.appendText(text.slice(cursor, match.index));
				target.createEl('mark', { text: match[0], cls: 'so-search-highlight' });
				cursor = match.index + match[0].length;
			}
			if (cursor === 0) target.setText(text);
			else if (cursor < text.length) target.appendText(text.slice(cursor));
		};
	}
}
