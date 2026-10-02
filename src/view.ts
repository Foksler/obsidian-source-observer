import { ItemView, WorkspaceLeaf, Notice, Scope, setIcon } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type SourceObserverPlugin from './main';
import { FileTree } from './fileTree';
import { CodePane } from './codePane';
import { SearchPanel } from './searchPanel';
import { EditorTabs, type SourceTab } from './editorTabs';
import { SymbolPicker } from './symbolPicker';
import { FilePicker } from './filePicker';
import { isPhpFile } from './phpFiles';
import { getRegisteredWorktrees, invalidateFileIndex, warmFileIndex } from './searchEngine';
import { PhpLsp, detectIntelephense, detectNode } from './phpLsp';
import { getChangedFiles, getFileDiff, isGitRepo, renderDiff, ChangedFile } from './gitDiff';

export const VIEW_TYPE = 'source-observer';

/** Debounce delay for the file-tree search input, in ms. */
const SEARCH_DEBOUNCE_MS = 0;
/** Interval for polling `git status` when fs.watch is unavailable, in ms. */
const GIT_POLL_MS = 5000;

interface ElectronRemote {
	dialog: {
		showOpenDialog(opts: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }>;
	};
}

/**
 * Main plugin view — two-column layout with a file/changes sidebar on the left
 * and a code or diff pane on the right. Watches `.git/index` and `.git/refs`
 * with `fs.watch`, falling back to polling `git status` on an interval.
 */
export class SourceObserverView extends ItemView {
	plugin: SourceObserverPlugin;
	private fileTree!: FileTree;
	private codePane!: CodePane;
	private phpLsp: PhpLsp | null = null;
	private lspKey = '';
	private rightPane!: HTMLElement;
	private changesContainer!: HTMLElement;
	private changesCounts!: HTMLElement;
	private pathLabel!: HTMLElement;
	private repoPath = '';
	private isRepo = false;
	private allChanges: ChangedFile[] = [];
	private changesQuery = '';
	private watchers: fs.FSWatcher[] = [];
	private pollTimer: number | null = null;
	private refreshTimer: number | null = null;
	private treeSearchTimer: number | null = null;
	private fileIndexTimer: number | null = null;
	private indexedWorktrees: string[] = [];
	private diffRequestId = 0;
	private searchPanel!: SearchPanel;
	private editorTabs!: EditorTabs;
	private filePicker: FilePicker | null = null;
	private gitSection!: HTMLElement;
	private gitToggle!: HTMLButtonElement;
	private closed = false;

	constructor(leaf: WorkspaceLeaf, plugin: SourceObserverPlugin) {
		super(leaf);
		this.plugin = plugin;
		// View scopes run before Obsidian's global command palette shortcuts.
		this.scope = new Scope(this.app.scope);
		this.scope.register(['Mod'], 'p', () => { this.openFiles(); return false; });
		this.scope.register(['Mod', 'Shift'], 'f', () => { this.searchPanel.focus('content'); return false; });
		this.scope.register(['Mod', 'Shift'], 'o', () => { this.openFiles(); return false; });
		this.scope.register(['Mod', 'Alt'], 'o', () => { this.showSymbols(true); return false; });
		this.scope.register(['Mod'], 't', () => { this.showSymbols(false); return false; });
		this.scope.register(['Mod'], 'f', () => { this.codePane.findInFile(); return false; });
		this.scope.register(['Mod'], '[', () => { void this.codePane.goBack(); return false; });
		this.scope.register(['Mod'], ']', () => { void this.codePane.goForward(); return false; });
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return 'Source observer'; }
	getIcon() { return 'code-2'; }

	async onOpen() {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass('so-root');
		this.closed = false;
		root.toggleClass('so-cursor-theme', this.plugin.settings.syntaxTheme === 'cursor-monokai');

		// ── Left sidebar ──────────────────────────────────────────────
		const sidebar = root.createDiv({ cls: 'so-sidebar' });
		const openBtn = sidebar.createEl('button', { cls: 'so-open-btn', text: 'Open folder…' });

		const { body: treeBody, searchInput: treeSearch } = this.buildSection(sidebar, 'Files');
		const treeContainer = treeBody.createDiv({ cls: 'so-tree' });

		const { section: gitSection, body: changesBody, searchInput: changesSearch, headerRight: changesHeaderRight } =
			this.buildSection(sidebar, 'Changes');

		const refreshBtn = changesHeaderRight.createEl('button', {
			cls: 'so-search-icon-btn',
			attr: { 'aria-label': 'Refresh changes' },
		});
		setIcon(refreshBtn, 'refresh-cw');
		this.registerDomEvent(refreshBtn, 'click', (e) => {
			e.stopPropagation();
			void this.refreshChanges();
		});

		this.gitSection = gitSection;
		this.gitToggle = changesHeaderRight.createEl('button', { cls: 'so-search-icon-btn', attr: { 'aria-label': 'Hide Git changes' } });
		this.registerDomEvent(this.gitToggle, 'click', () => {
			this.plugin.settings.gitPanelHidden = !this.plugin.settings.gitPanelHidden;
			void this.plugin.saveSettings();
		});
		this.updateGitVisibility();

		this.changesCounts = changesHeaderRight.createDiv({ cls: 'so-section-counts' });
		this.changesContainer = changesBody.createDiv({ cls: 'so-changes' });

		// ── Right pane ────────────────────────────────────────────────
		const main = root.createDiv({ cls: 'so-main' });
		const toolbar = main.createDiv({ cls: 'so-toolbar' });
		this.addToolbarButton(toolbar, 'arrow-left', 'Go back', () => { void this.codePane.goBack(); });
		this.addToolbarButton(toolbar, 'arrow-right', 'Go forward', () => { void this.codePane.goForward(); });
		this.addToolbarButton(toolbar, 'search', 'Search in files (Cmd+Shift+F)', () => this.searchPanel.focus('content'));
		this.addToolbarButton(toolbar, 'file-search', 'Quick open file (Ctrl/Cmd+P or Ctrl/Cmd+Shift+O)', () => this.openFiles());
		this.addToolbarButton(toolbar, 'list-tree', 'Go to symbol in file (Ctrl/Cmd+Alt+O)', () => this.showSymbols(true));
		this.addToolbarButton(toolbar, 'shapes', 'Go to PHP symbol (Cmd+T)', () => this.showSymbols(false));
		this.addToolbarButton(toolbar, 'corner-down-right', 'Go to definition (F12)', () => { const view = this.codePane.getEditor(); if (view) this.phpLsp?.jumpToDefinition(view); });
		this.addToolbarButton(toolbar, 'list', 'Find references (Shift+F12)', () => { const view = this.codePane.getEditor(); if (view) this.phpLsp?.findReferences(view); });
		this.editorTabs = new EditorTabs(main.createDiv(), (tab) => { void this.openTab(tab); }, () => {
			++this.diffRequestId; this.codePane.suspend(); this.pathLabel.setText('');
		});
		this.pathLabel = main.createDiv({ cls: 'so-path-label' });
		this.rightPane = main.createDiv({ cls: 'so-pane' });

		this.codePane = new CodePane(
			this.rightPane,
			this.plugin.settings.fontSize,
			this.plugin.settings.syntaxTheme,
			(filePath) => {
				this.pathLabel.setText(path.relative(this.repoPath, filePath) || filePath);
				this.editorTabs.show({ filePath, kind: 'code' });
			},
			this.plugin.settings.editorFontFamily,
			this.plugin.settings.editorFontLigatures,
		);
		this.syncPhpLsp();

		this.fileTree = new FileTree(
			treeContainer,
			this.plugin.settings.showHidden,
			(filePath) => { void this.openTab({ filePath, kind: 'code' }); },
		);

		this.fileTree.setIncludeWorktrees(this.plugin.settings.includeWorktrees);
		const searchContainer = sidebar.createDiv({ cls: 'so-workspace-search' });
		sidebar.insertBefore(searchContainer, gitSection);
		this.searchPanel = new SearchPanel(searchContainer, (filePath, line, column) => {
			++this.diffRequestId;
			void this.codePane.openAt(filePath, line ?? 1, column ?? 1).then(() => this.codePane.focus());
		}, (include) => { this.plugin.settings.includeWorktrees = include; void this.plugin.saveSettings(); });
		this.searchPanel.setIncludeWorktrees(this.plugin.settings.includeWorktrees);
		this.searchPanel.setShowHidden(this.plugin.settings.showHidden);

		this.registerDomEvent(treeSearch, 'input', () => {
			if (this.treeSearchTimer) window.clearTimeout(this.treeSearchTimer);
			this.treeSearchTimer = window.setTimeout(
				() => { void this.fileTree.search(treeSearch.value); },
				SEARCH_DEBOUNCE_MS,
			);
		});
		this.registerDomEvent(changesSearch, 'input', () => {
			this.changesQuery = changesSearch.value;
			this.renderChanges(this.changesQuery);
		});

		// Re-render when font size or hidden-file settings change.
		const settingsRef = this.plugin.settingsEvents.on('changed', () => {
			root.toggleClass('so-cursor-theme', this.plugin.settings.syntaxTheme === 'cursor-monokai');
			this.codePane.setFontOptions(this.plugin.settings.editorFontFamily, this.plugin.settings.editorFontLigatures);
			this.codePane.setFontSize(this.plugin.settings.fontSize);
			this.codePane.setTheme(this.plugin.settings.syntaxTheme);
			this.fileTree.setShowHidden(this.plugin.settings.showHidden);
			this.fileTree.setIncludeWorktrees(this.plugin.settings.includeWorktrees);
			this.searchPanel.setIncludeWorktrees(this.plugin.settings.includeWorktrees);
			this.searchPanel.setShowHidden(this.plugin.settings.showHidden);
			this.updateGitVisibility();
			this.syncPhpLsp();
		});
		this.register(() => this.plugin.settingsEvents.offref(settingsRef));

		if (this.plugin.settings.lastOpenedPath) {
			await this.openFolder(this.plugin.settings.lastOpenedPath);
		}

		this.registerDomEvent(openBtn, 'click', () => {
			void (async () => {
				const { remote } = window.require('electron') as { remote: ElectronRemote };
				const result = await remote.dialog.showOpenDialog({ properties: ['openDirectory'] });
				const [dir] = result.filePaths;
				if (result.canceled || !dir) return;
				this.plugin.settings.lastOpenedPath = dir;
				await this.plugin.saveSettings();
				await this.openFolder(dir);
			})();
		});
	}

	/** Starts, restarts or stops the PHP language server to match the settings. */
	private syncPhpLsp() {
		const s = this.plugin.settings;
		const key = s.phpLsp ? [s.nodePath, s.intelephensePath, s.intelephenseLicence, String(s.includeWorktrees)].join('\0') : '';
		if (key === this.lspKey) return;
		this.lspKey = key;
		this.codePane.setLsp(null);
		this.phpLsp?.dispose();
		this.phpLsp = s.phpLsp
			? new PhpLsp({
				app: this.app,
				nodePath: s.nodePath || detectNode(),
				serverPath: s.intelephensePath || detectIntelephense(),
				licenceKey: s.intelephenseLicence,
				includeWorktrees: s.includeWorktrees,
				display: (filePath) => { ++this.diffRequestId; this.codePane.rememberPosition(); return this.codePane.open(filePath); },
				beforeJump: () => this.codePane.rememberPosition(),
			})
			: null;
		this.phpLsp?.setWorkspaceRoot(this.repoPath);
		this.codePane.setLsp(this.phpLsp);
	}

	private async openFolder(dir: string) {
		this.filePicker?.close();
		++this.diffRequestId;
		this.repoPath = dir;
		this.phpLsp?.setWorkspaceRoot(dir);
		this.searchPanel.setRoot(dir);
		this.indexedWorktrees = await getRegisteredWorktrees(dir);
		this.isRepo = await isGitRepo(dir);
		await this.fileTree.loadPath(dir);
		await this.refreshChanges();
		this.startWatching();
		// Interval-based poll covers anything fs.watch misses (untracked
		// files, platforms without reliable recursive watching).
		if (this.pollTimer === null) {
			this.pollTimer = this.registerInterval(
				window.setInterval(() => { void this.refreshChanges(); }, GIT_POLL_MS),
			);
		}
	}

	// Watch .git/index (staged changes) and .git/refs (branch/commit updates).
	// Both share a debounce so rapid saves don't hammer git.
	private startWatching() {
		this.stopWatching();
		try {
			const root = this.repoPath;
			const watcher = fs.watch(root, { recursive: true }, (event, filename) => {
				if (event !== 'rename') return; // Content edits do not change file paths.
				const parts = filename?.toString().split(/[\\/]/) ?? [];
				if (parts.some((part) => ['.git', this.app.vault.configDir, 'node_modules'].includes(part))) return;
				if (!this.plugin.settings.includeWorktrees && filename) {
					const fullPath = path.resolve(root, filename.toString());
					if (this.indexedWorktrees.some((worktree) => fullPath === worktree || fullPath.startsWith(`${worktree}${path.sep}`))) return;
					if (parts.includes('worktrees') || parts.includes('.worktrees')) return;
				}
				if (this.fileIndexTimer !== null) window.clearTimeout(this.fileIndexTimer);
				this.fileIndexTimer = window.setTimeout(() => {
					this.fileIndexTimer = null;
					invalidateFileIndex(root);
					void warmFileIndex(root, this.plugin.settings.includeWorktrees).catch(() => {});
				}, 80);
			});
			watcher.on('error', () => { watcher.close(); });
			this.watchers.push(watcher);
		} catch { /* The index also refreshes periodically when recursive watching is unavailable. */ }
		if (!this.isRepo) return;

		const schedule = () => {
			if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
			this.refreshTimer = window.setTimeout(() => { void this.refreshChanges(); }, 800);
		};

		const watch = (target: string) => {
			try {
				// 'error' must be handled: unhandled watcher errors throw as
				// uncaught exceptions on the EventEmitter.
				const w = fs.watch(target, schedule);
				w.on('error', () => { /* watched path removed or unreadable */ });
				this.watchers.push(w);
			} catch { /* not a git repo */ }
		};

		watch(path.join(this.repoPath, '.git', 'index'));
		watch(path.join(this.repoPath, '.git', 'refs'));
	}

	private stopWatching() {
		if (this.fileIndexTimer !== null) { window.clearTimeout(this.fileIndexTimer); this.fileIndexTimer = null; }
		if (this.refreshTimer) { window.clearTimeout(this.refreshTimer); this.refreshTimer = null; }
		for (const w of this.watchers) { try { w.close(); } catch { /* ignore */ } }
		this.watchers = [];
	}

	private buildSection(parent: HTMLElement, title: string) {
		const section = parent.createDiv({ cls: 'so-section' });
		const header = section.createDiv({ cls: 'so-section-header' });

		const toggle = header.createEl('button', { cls: 'so-section-toggle', attr: { 'aria-label': `Toggle ${title.toLowerCase()}`, 'aria-expanded': 'true' } });
		const chevron = toggle.createSpan({ cls: 'so-section-chevron', text: '▾' });
		toggle.createSpan({ cls: 'so-section-title', text: title });

		const headerRight = header.createDiv({ cls: 'so-section-header-right' });
		const searchBtn = headerRight.createEl('button', { cls: 'so-search-icon-btn', attr: { 'aria-label': `Filter ${title.toLowerCase()}` } });
		setIcon(searchBtn, 'search');

		const body = section.createDiv({ cls: 'so-section-body' });
		const searchInput = body.createEl('input', {
			cls: 'so-search-input so-search-input-hidden',
			attr: { type: 'text', placeholder: `Search ${title.toLowerCase()}…` },
		});

		this.registerDomEvent(toggle, 'click', () => {
			const isOpen = !body.hasClass('so-section-body-hidden');
			body.toggleClass('so-section-body-hidden', isOpen);
			chevron.setText(isOpen ? '▸' : '▾');
			toggle.setAttribute('aria-expanded', String(!isOpen));
		});

		this.registerDomEvent(searchBtn, 'click', (e) => {
			e.stopPropagation();
			const hidden = searchInput.hasClass('so-search-input-hidden');
			searchInput.toggleClass('so-search-input-hidden', !hidden);
			if (hidden) {
				body.removeClass('so-section-body-hidden');
				chevron.setText('▾');
				searchInput.focus();
			} else {
				searchInput.value = '';
				searchInput.dispatchEvent(new Event('input'));
			}
		});

		return { section, body, searchInput, headerRight };
	}

	private async refreshChanges() {
		if (!this.repoPath) return;
		this.isRepo = await isGitRepo(this.repoPath);
		this.allChanges = this.isRepo ? await getChangedFiles(this.repoPath) : [];
		this.updateChangeCounts();
		this.renderChanges(this.changesQuery);
	}

	private updateChangeCounts() {
		this.changesCounts.empty();
		const newCount = this.allChanges.filter((cf) => cf.code.includes('A') || cf.code.includes('?')).length;
		const modCount = this.allChanges.filter((cf) => cf.code.includes('M')).length;
		const delCount = this.allChanges.filter((cf) => cf.code.includes('D')).length;
		if (newCount > 0) this.changesCounts.createSpan({ cls: 'so-count-badge so-count-new', text: String(newCount) });
		if (modCount > 0) this.changesCounts.createSpan({ cls: 'so-count-badge so-count-modified', text: String(modCount) });
		if (delCount > 0) this.changesCounts.createSpan({ cls: 'so-count-badge so-count-deleted', text: String(delCount) });
	}

	private renderChanges(query: string) {
		this.changesContainer.empty();
		const filtered = query.trim()
			? this.allChanges.filter((cf) => cf.file.toLowerCase().includes(query.toLowerCase()))
			: this.allChanges;

		if (filtered.length === 0) {
			const text = query
				? 'No results'
				: this.isRepo
					? 'No changes'
					: 'Not a git repository';
			this.changesContainer.createEl('span', { cls: 'so-changes-empty', text });
			return;
		}
		for (const cf of filtered) this.renderChangeRow(cf);
	}

	private renderChangeRow(cf: ChangedFile) {
		const row = this.changesContainer.createDiv({ cls: 'so-change-row' });

		const badge = row.createSpan({ cls: 'so-change-badge' });
		badge.setText(cf.code.trim());
		if (cf.code.includes('M')) badge.addClass('so-badge-modified');
		else if (cf.code.includes('A') || cf.code.includes('?')) badge.addClass('so-badge-added');
		else if (cf.code.includes('D')) badge.addClass('so-badge-deleted');

		const label = row.createSpan({ cls: 'so-change-file', text: path.basename(cf.file) });
		// Basenames collide across directories — show the relative dir as context.
		const dir = path.dirname(cf.file);
		if (dir && dir !== '.') label.createSpan({ cls: 'so-change-dir', text: ` ${dir}/` });
		row.title = cf.file;

		row.addEventListener('click', () => {
			const filePath = path.isAbsolute(cf.file) ? cf.file : path.join(this.repoPath, cf.file);
			void this.openTab({ filePath, kind: 'diff' });
		});
	}

	private async openTab(tab: SourceTab) {
		const requestId = ++this.diffRequestId;
		if (tab.kind === 'code') {
			this.codePane.rememberPosition();
			await this.codePane.open(tab.filePath);
			return;
		}
		this.codePane.suspend();
		this.editorTabs.show(tab);
		this.pathLabel.setText(path.relative(this.repoPath, tab.filePath) + ' (diff)');
		const diff = await getFileDiff(this.repoPath, tab.filePath);
		if (requestId !== this.diffRequestId || this.closed) return;
		renderDiff(this.rightPane, diff);
	}

	private addToolbarButton(parent: HTMLElement, icon: string, label: string, callback: () => void) {
		const button = parent.createEl('button', { cls: 'so-search-icon-btn', attr: { 'aria-label': label, title: label } });
		setIcon(button, icon); this.registerDomEvent(button, 'click', callback);
	}

	private updateGitVisibility() {
		const hidden = this.plugin.settings.gitPanelHidden;
		this.gitSection.toggleClass('so-git-collapsed', hidden);
		this.gitToggle.setAttribute('aria-label', hidden ? 'Restore Git changes' : 'Hide Git changes');
		this.gitToggle.title = hidden ? 'Restore Git changes' : 'Hide Git changes';
		setIcon(this.gitToggle, hidden ? 'panel-bottom-open' : 'panel-bottom-close');
	}

	focusSearch(mode: 'content' | 'files') { this.searchPanel.focus(mode); }

	openFiles() {
		if (this.closed) return;
		if (!this.repoPath) { new Notice('Open a folder first.'); return; }
		if (this.filePicker) { this.filePicker.inputEl.focus(); return; }
		this.filePicker = new FilePicker(this.app, this.repoPath, {
			includeWorktrees: this.plugin.settings.includeWorktrees,
			showHidden: this.plugin.settings.showHidden,
		}, (filePath) => {
			if (this.closed) return;
			void this.openTab({ filePath, kind: 'code' }).then(() => this.codePane.focus());
		}, () => { this.filePicker = null; });
		this.filePicker.open();
	}

	openSymbols(document: boolean) { this.showSymbols(document); }

	restartNavigation() { this.lspKey = ''; this.syncPhpLsp(); }

	private showSymbols(document: boolean) {
		if (!this.phpLsp) { new Notice('Enable language navigation in settings.'); return; }
		const file = this.codePane.getCurrentFile();
		if (document && (!file || !isPhpFile(file))) { new Notice('Open a source file first.'); return; }
		new SymbolPicker(this.app, this.phpLsp, document ? file ?? undefined : undefined, (filePath, line, column) => {
			++this.diffRequestId; void this.codePane.openAt(filePath, line, column).then(() => this.codePane.focus());
		}).open();
	}

	async onClose() {
		this.closed = true;
		this.filePicker?.close();
		++this.diffRequestId;
		this.searchPanel?.dispose();
		if (this.pollTimer !== null) { window.clearInterval(this.pollTimer); this.pollTimer = null; }
		this.stopWatching();
		if (this.treeSearchTimer) { window.clearTimeout(this.treeSearchTimer); this.treeSearchTimer = null; }
		this.codePane?.destroy();
		this.phpLsp?.dispose();
		this.phpLsp = null;
	}
}
