import { ItemView, WorkspaceLeaf, Notice, Scope, Platform, setIcon } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type SourceObserverPlugin from './main';
import { FileTree } from './fileTree';
import { CodePane, type CodePaneSession } from './codePane';
import { SearchPanel, type SearchPanelState } from './searchPanel';
import { EditorTabs, type SourceTab, type EditorTabsState } from './editorTabs';
import { FolderTabs } from './folderTabs';
import { normalizeFolderWorkspace, closeFolderWorkspace } from './folderWorkspace';
import { SymbolPicker } from './symbolPicker';
import { FilePicker } from './filePicker';
import { SearchEverywhereModal, type EverywhereState } from './searchEverywhereModal';
import { FindInFilesModal } from './findInFilesModal';
import { addVerticalSplitter } from './verticalSplitter';
import type { FindInFilesState } from './findInFilesScope';
import { bindShortcuts, normalizeShortcuts } from './searchShortcuts';
import { registerDoubleShiftSearch } from './searchMode';
import type { SearchTab, SearchAction, EverywhereResult } from './searchEverywhere';
import { isPhpFile } from './phpFiles';
import { getRegisteredWorktrees, invalidateFileIndex, warmFileIndex } from './searchEngine';
import { PhpLsp, detectIntelephense, detectNode } from './phpLsp';
import { getChangedFiles, getFileDiff, getGitRoot, renderDiff, ChangedFile } from './gitDiff';

export const VIEW_TYPE = 'source-observer';

/** Debounce delay for the file-tree search input, in ms. */
const SEARCH_DEBOUNCE_MS = 0;
/** Backup refresh of the file tree and Git changes when filesystem events are missed. */
const PROJECT_POLL_MS = 5000;

interface ElectronRemote {
	dialog: {
		showOpenDialog(opts: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }>;
	};
}

interface FolderSession {
	editor: CodePaneSession;
	tabs: EditorTabsState;
	search: SearchPanelState;
	treeQuery: string;
	changesQuery: string;
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
	private gitRoot = '';
	private gitContext: { path: string; isDirectory: boolean } | null = null;
	private gitSplitter!: HTMLElement;
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
	private everywhere: SearchEverywhereModal | null = null;
	private everywhereState?: EverywhereState;
	private findInFiles: FindInFilesModal | null = null;
	private findStates = new Map<string, FindInFilesState>();
	private clearShortcuts?: () => void;
	private searchLsps = new Map<string, PhpLsp>();
	private recentFiles: string[] = [];
	private gitSection!: HTMLElement;
	private gitToggle!: HTMLButtonElement;
	private closed = false;
	private folderTabs!: FolderTabs;
	private folderPaths: string[] = [];
	private folderSessions = new Map<string, FolderSession>();
	private folderRequestId = 0;
	private gitRequestId = 0;
	private treeSearchInput!: HTMLInputElement;
	private changesSearchInput!: HTMLInputElement;

	constructor(leaf: WorkspaceLeaf, plugin: SourceObserverPlugin) {
		super(leaf);
		this.plugin = plugin;
		// View scopes run before Obsidian's global command palette shortcuts.
		this.scope = new Scope(this.app.scope);
		this.syncShortcuts();
	}

	private syncShortcuts() {
		this.clearShortcuts?.();
		this.clearShortcuts = bindShortcuts(this.scope!, normalizeShortcuts(this.plugin.settings.shortcuts), {
			findInFiles: () => this.focusSearch('content'), everywhere: () => this.openSearchEverywhere(),
			quickOpen: () => this.openFiles(), quickOpenAlternate: () => this.openFiles(),
			documentSymbols: () => this.showSymbols(true), workspaceSymbols: () => this.showSymbols(false),
			findInFile: () => this.codePane.findInFile(), back: () => { void this.codePane.goBack(); }, forward: () => { void this.codePane.goForward(); },
		}, Platform.isMacOS);
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
		registerDoubleShiftSearch(this, root,
			() => !this.closed && this.plugin.settings.searchMode === 'phpstorm' && this.plugin.settings.doubleShiftSearch !== false,
			() => this.app.workspace.getActiveViewOfType(SourceObserverView) === this || this.plugin.explorerDock.isActive(this),
			() => this.openSearchEverywhere(), (target) => root.contains(target) || sidebar.contains(target));
		this.folderTabs = new FolderTabs(sidebar.createDiv(),
			(dir) => { void this.activateFolder(dir).catch(() => new Notice('Could not open this folder.')); },
			(dir) => { void this.closeFolder(dir).catch(() => new Notice('Could not close this folder.')); });

		const sections = sidebar.createDiv({ cls: 'so-sidebar-sections' });
		const { section: filesSection, body: treeBody, searchInput: treeSearch } = this.buildSection(sections, 'Files');
		filesSection.addClass('so-files-section');
		this.treeSearchInput = treeSearch;
		const treeContainer = treeBody.createDiv({ cls: 'so-tree' });

		const gitSplitter = addVerticalSplitter(this, sections, { label: 'Resize Git changes', sizeProperty: '--so-git-size',
			fromBottom: true, initial: 0, minLast: 80, minRatio: 0, maxRatio: 100 });
		this.gitSplitter = gitSplitter;
		const { section: gitSection, body: changesBody, searchInput: changesSearch, headerRight: changesHeaderRight } =
			this.buildSection(sections, 'Changes');
		gitSection.addClass('so-git-section');
		this.changesSearchInput = changesSearch;

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
		this.addToolbarButton(toolbar, 'folder-plus', 'Open folders…', () => { void this.openFolderDialog(); });
		this.addToolbarButton(toolbar, 'arrow-left', 'Go back', () => { void this.codePane.goBack(); });
		this.addToolbarButton(toolbar, 'arrow-right', 'Go forward', () => { void this.codePane.goForward(); });
		this.addToolbarButton(toolbar, 'search', 'Search in files', () => this.focusSearch('content'));
		this.addToolbarButton(toolbar, 'search-code', 'Search everywhere', () => this.openSearchEverywhere());
		this.addToolbarButton(toolbar, 'file-search', 'Quick open file', () => this.openFiles());
		this.addToolbarButton(toolbar, 'locate-fixed', 'Locate current file in tree', () => { void this.locateCurrentFile(); });
		this.addToolbarButton(toolbar, 'list-tree', 'Go to symbol in file', () => this.showSymbols(true));
		this.addToolbarButton(toolbar, 'shapes', 'Go to PHP symbol', () => this.showSymbols(false));
		this.addToolbarButton(toolbar, 'corner-down-right', 'Go to definition (F12)', () => { const view = this.codePane.getEditor(); if (view) this.phpLsp?.jumpToDefinition(view); });
		this.addToolbarButton(toolbar, 'list', 'Find references (Shift+F12)', () => { const view = this.codePane.getEditor(); if (view) this.phpLsp?.findReferences(view); });
		this.editorTabs = new EditorTabs(main.createDiv(), (tab) => { void this.openTab(tab); }, () => {
			++this.diffRequestId; this.codePane.suspend(); this.pathLabel.setText('');
			this.setGitContext(this.fileTree.getSelectedPath() ?? { path: this.repoPath, isDirectory: true });
		});
		this.pathLabel = main.createDiv({ cls: 'so-path-label' });
		this.rightPane = main.createDiv({ cls: 'so-pane' });

		this.codePane = new CodePane(
			this.rightPane,
			this.plugin.settings.fontSize,
			this.plugin.settings.syntaxTheme,
			(filePath) => {
				this.recentFiles = [filePath, ...this.recentFiles.filter((file) => file !== filePath)].slice(0, 50);
				this.pathLabel.setText(path.relative(this.repoPath, filePath) || filePath);
				this.editorTabs.show({ filePath, kind: 'code' });
				this.setGitContext({ path: filePath, isDirectory: false });
			},
			this.plugin.settings.editorFontFamily,
			this.plugin.settings.editorFontLigatures,
		);
		this.syncPhpLsp();
		this.codePane.setShortcuts(this.plugin.settings.shortcuts);

		this.fileTree = new FileTree(
			treeContainer,
			this.plugin.settings.showHidden,
			(filePath) => { void this.openTab({ filePath, kind: 'code' }); },
			(selection) => this.setGitContext(selection),
		);

		this.fileTree.setIncludeWorktrees(this.plugin.settings.includeWorktrees);
		const searchContainer = sections.createDiv({ cls: 'so-workspace-search' });
		sections.insertBefore(searchContainer, gitSplitter);
		this.searchPanel = new SearchPanel(searchContainer, (filePath, line, column) => {
			void this.openSearchResult({ id: filePath, category: 'text', name: '', detail: '', filePath, line: line ?? 1, column });
		}, (include) => { this.plugin.settings.includeWorktrees = include; void this.plugin.saveSettings(); });
		this.searchPanel.setIncludeWorktrees(this.plugin.settings.includeWorktrees);
		this.searchPanel.setShowHidden(this.plugin.settings.showHidden);
		searchContainer.hidden = this.plugin.settings.searchMode === 'phpstorm';

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
			this.syncShortcuts();
			this.codePane.setShortcuts(this.plugin.settings.shortcuts);
			this.findInFiles?.close();
			this.everywhere?.close();
			for (const lsp of this.searchLsps.values()) lsp.dispose();
			this.searchLsps.clear();
			this.filePicker?.close();
			searchContainer.hidden = this.plugin.settings.searchMode === 'phpstorm';
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

		const workspace = normalizeFolderWorkspace(this.plugin.settings.openedFolderPaths, this.plugin.settings.lastOpenedPath);
		this.folderPaths = workspace.paths;
		this.folderTabs.setFolders(this.folderPaths, workspace.activePath);
		if (workspace.activePath) await this.activateFolder(workspace.activePath);
		await this.plugin.explorerDock.attach({ view: this, sidebar, home: root, isClosed: () => this.closed });
	}

	/** Starts, restarts or stops the PHP language server to match the settings. */
	private syncPhpLsp() {
		const s = this.plugin.settings;
		const key = s.phpLsp && this.repoPath ? [this.repoPath, s.nodePath, s.intelephensePath, s.intelephenseLicence, String(s.includeWorktrees)].join('\0') : '';
		if (key === this.lspKey) return;
		this.lspKey = key;
		this.codePane.setLsp(null);
		this.phpLsp?.dispose();
		const folderRequest = this.folderRequestId;
		this.phpLsp = key
			? new PhpLsp({
				app: this.app,
				nodePath: s.nodePath || detectNode(),
				serverPath: s.intelephensePath || detectIntelephense(),
				licenceKey: s.intelephenseLicence,
				includeWorktrees: s.includeWorktrees,
				display: (filePath) => {
					if (this.closed || folderRequest !== this.folderRequestId) return Promise.resolve(null);
					++this.diffRequestId; this.codePane.rememberPosition(); return this.codePane.open(filePath);
				},
				beforeJump: () => this.codePane.rememberPosition(),
			})
			: null;
		this.phpLsp?.setWorkspaceRoot(this.repoPath);
		this.codePane.setLsp(this.phpLsp);
	}

	async openFolderDialog() {
		try {
			const { remote } = window.require('electron') as { remote: ElectronRemote };
			const result = await remote.dialog.showOpenDialog({ properties: ['openDirectory', 'multiSelections'] });
			if (!result.canceled && !this.closed) await this.openFolders(result.filePaths);
		} catch { new Notice('Could not open the folder picker.'); }
	}

	/** Adds folders without replacing the existing workspace. */
	async openFolders(dirs: string[]) {
		const valid: string[] = [];
		for (const dir of dirs) {
			try {
				const real = await fs.promises.realpath(dir);
				if ((await fs.promises.stat(real)).isDirectory()) valid.push(real);
			} catch { new Notice(`Folder is unavailable: ${dir}`); }
		}
		if (this.closed || !valid.length) return;
		this.folderPaths = [...new Set([...this.folderPaths, ...valid])];
		await this.activateFolder(valid[0]!);
	}

	private persistFolders() {
		this.plugin.settings.openedFolderPaths = [...this.folderPaths];
		this.plugin.settings.lastOpenedPath = this.repoPath;
		return this.plugin.saveSettings();
	}

	private async closeFolder(dir: string) {
		const next = closeFolderWorkspace(this.folderPaths, this.repoPath, dir);
		this.folderPaths = next.paths;
		this.folderSessions.delete(dir);
		if (next.activePath !== this.repoPath) await this.activateFolder(next.activePath);
		else { this.folderTabs.setFolders(this.folderPaths, this.repoPath); await this.persistFolders(); }
	}

	private async activateFolder(dir: string) {
		if (this.closed) return;
		if (dir === this.repoPath) {
			this.folderTabs.setFolders(this.folderPaths, dir);
			await this.persistFolders();
			return;
		}
		if (this.repoPath && this.folderPaths.includes(this.repoPath)) {
			this.folderSessions.set(this.repoPath, {
				editor: this.codePane.captureSession(), tabs: this.editorTabs.captureState(),
				search: this.searchPanel.captureState(), treeQuery: this.treeSearchInput.value,
				changesQuery: this.changesQuery,
			});
		}
		const requestId = ++this.folderRequestId;
		++this.diffRequestId;
		this.filePicker?.close();
		this.everywhere?.close();
		this.findInFiles?.close();
		this.stopWatching();
		if (this.treeSearchTimer !== null) { window.clearTimeout(this.treeSearchTimer); this.treeSearchTimer = null; }
		this.repoPath = dir;
		this.indexedWorktrees = [];
		this.isRepo = false;
		this.gitRoot = '';
		this.gitContext = null;
		this.updateGitVisibility();
		this.allChanges = [];
		const session = this.folderSessions.get(dir);
		this.codePane.restoreSession(session?.editor ?? null);
		this.editorTabs.restoreState(session?.tabs ?? null);
		this.pathLabel.setText('');
		this.treeSearchInput.value = session?.treeQuery ?? '';
		this.changesQuery = session?.changesQuery ?? '';
		this.changesSearchInput.value = this.changesQuery;
		this.treeSearchInput.toggleClass('so-search-input-hidden', !this.treeSearchInput.value);
		this.changesSearchInput.toggleClass('so-search-input-hidden', !this.changesQuery);
		this.updateChangeCounts();
		this.renderChanges(this.changesQuery);
		this.folderTabs.setFolders(this.folderPaths, dir);
		this.searchPanel.setRoot(dir);
		this.searchPanel.restoreState(session?.search ?? null);
		this.syncPhpLsp();
		// Start the tree load now to clear the previous folder synchronously.
		const treeLoad = this.fileTree.loadPath(dir);
		await this.persistFolders();
		if (requestId !== this.folderRequestId || this.closed) return;
		if (!dir) {
			if (this.pollTimer !== null) { window.clearInterval(this.pollTimer); this.pollTimer = null; }
			await treeLoad;
			return;
		}
		const worktrees = await getRegisteredWorktrees(dir);
		if (requestId !== this.folderRequestId || this.closed) return;
		this.indexedWorktrees = worktrees;
		await treeLoad;
		if (requestId !== this.folderRequestId || this.closed) return;
		if (this.treeSearchInput.value) await this.fileTree.search(this.treeSearchInput.value);
		if (requestId !== this.folderRequestId || this.closed) return;
		await this.refreshChanges();
		if (requestId !== this.folderRequestId || this.closed) return;
		this.startWatching();
		const active = this.editorTabs.getActive();
		if (active?.kind === 'code') await this.codePane.open(active.filePath);
		else if (active) await this.openTab(active);
		if (requestId !== this.folderRequestId || this.closed) return;
		// Interval-based poll covers anything fs.watch misses (untracked
		// files, platforms without reliable recursive watching).
		if (this.pollTimer === null) {
			this.pollTimer = this.registerInterval(
				window.setInterval(() => {
					void this.refreshChanges();
					void this.fileTree.refresh().catch(() => {});
				}, PROJECT_POLL_MS),
			);
		}
	}

	// Watch path changes for the tree and search index, plus Git metadata changes.
	private startWatching() {
		this.stopWatching();
		try {
			const root = this.repoPath;
			const folderRequest = this.folderRequestId;
			const watcher = fs.watch(root, { recursive: true }, (event, filename) => {
				if (this.closed || folderRequest !== this.folderRequestId || root !== this.repoPath) return;
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
					if (this.closed || folderRequest !== this.folderRequestId || root !== this.repoPath) return;
					invalidateFileIndex(root);
					void warmFileIndex(root, this.plugin.settings.includeWorktrees).catch(() => {});
					void this.fileTree.refresh().catch(() => {});
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

	private async locateCurrentFile() {
		const filePath = this.editorTabs.getActive()?.filePath ?? this.codePane.getCurrentFile();
		if (!filePath) { new Notice('Open a file first.'); return; }
		if (this.treeSearchTimer) window.clearTimeout(this.treeSearchTimer);
		this.treeSearchTimer = null;
		this.treeSearchInput.value = '';
		const section = this.treeSearchInput.closest('.so-section');
		section?.querySelector('.so-section-body')?.removeClass('so-section-body-hidden');
		section?.querySelector('.so-section-toggle')?.setAttribute('aria-expanded', 'true');
		section?.querySelector('.so-section-chevron')?.setText('▾');
		const request = this.folderRequestId;
		if (!await this.fileTree.reveal(filePath) && !this.closed && request === this.folderRequestId) {
			await this.fileTree.search('');
			new Notice('Could not locate this file. Check hidden-file and worktree visibility.');
		}
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

	private setGitContext(context: { path: string; isDirectory: boolean }) {
		if (this.gitContext?.path === context.path && this.gitContext.isDirectory === context.isDirectory) return;
		this.gitContext = context;
		// Hide stale changes while resolving a different repository.
		this.isRepo = false;
		this.updateGitVisibility();
		void this.refreshChanges();
	}

	private async refreshChanges() {
		if (!this.repoPath) return;
		const root = this.repoPath;
		const folderRequest = this.folderRequestId;
		const requestId = ++this.gitRequestId;
		const context = this.gitContext ?? { path: root, isDirectory: true };
		const gitRoot = await getGitRoot(context.path, context.isDirectory);
		if (this.closed || root !== this.repoPath || folderRequest !== this.folderRequestId || requestId !== this.gitRequestId) return;
		const changes = gitRoot ? await getChangedFiles(gitRoot) : [];
		if (this.closed || root !== this.repoPath || folderRequest !== this.folderRequestId || requestId !== this.gitRequestId) return;
		this.gitRoot = gitRoot ?? '';
		this.isRepo = !!gitRoot;
		this.allChanges = changes;
		this.updateGitVisibility();
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
		const root = this.gitRoot;
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
			if (this.closed || root !== this.gitRoot) return;
			const filePath = path.isAbsolute(cf.file) ? cf.file : path.join(root, cf.file);
			void this.openTab({ filePath, kind: 'diff' });
		});
	}

	private async openTab(tab: SourceTab) {
		if (this.plugin.explorerDock?.isDocked(this)) await this.app.workspace.revealLeaf(this.leaf);
		const requestId = ++this.diffRequestId;
		if (tab.kind === 'code') {
			this.codePane.rememberPosition();
			await this.codePane.open(tab.filePath);
			return;
		}
		this.codePane.suspend();
		this.editorTabs.show(tab);
		this.setGitContext({ path: tab.filePath, isDirectory: false });
		this.pathLabel.setText(path.relative(this.repoPath, tab.filePath) + ' (diff)');
		const diff = await getFileDiff(path.dirname(tab.filePath), tab.filePath);
		if (requestId !== this.diffRequestId || this.closed) return;
		renderDiff(this.rightPane, diff);
	}

	private addToolbarButton(parent: HTMLElement, icon: string, label: string, callback: () => void) {
		const button = parent.createEl('button', { cls: 'so-search-icon-btn', attr: { 'aria-label': label } });
		setIcon(button, icon); this.registerDomEvent(button, 'click', callback);
	}

	private updateGitVisibility() {
		const hidden = this.plugin.settings.gitPanelHidden;
		this.gitSection.hidden = !this.isRepo;
		if (this.gitSplitter) this.gitSplitter.hidden = !this.isRepo || hidden;
		this.gitSection.toggleClass('so-git-collapsed', hidden);
		this.gitToggle.setAttribute('aria-label', hidden ? 'Restore Git changes' : 'Hide Git changes');
		this.gitToggle.title = hidden ? 'Restore Git changes' : 'Hide Git changes';
		setIcon(this.gitToggle, hidden ? 'panel-bottom-open' : 'panel-bottom-close');
	}

	focusSearch(mode: 'content' | 'files') {
		if (this.plugin.settings.searchMode === 'phpstorm') {
			if (mode === 'content') this.openFindInFiles(); else this.openSearchEverywhere('files');
		}
		else this.searchPanel.focus(mode);
	}

	openFindInFiles() {
		if (this.closed) return;
		if (!this.repoPath) { new Notice('Open a folder first.'); return; }
		if (this.findInFiles) { this.findInFiles.focus(); return; }
		const root = this.repoPath;
		const context = { root, selectedPath: this.fileTree.getSelectedPath(), treeFocused: this.fileTree.hasFocus(),
			currentFile: this.codePane.getCurrentFile(), openFiles: this.editorTabs.captureState().tabs.filter((tab) => tab.kind === 'code').map((tab) => tab.filePath),
			showHidden: this.plugin.settings.showHidden, includeWorktrees: this.plugin.settings.includeWorktrees };
		this.everywhere?.close(); this.filePicker?.close();
		this.findInFiles = new FindInFilesModal(this.app, context, this.plugin.settings, (match) => {
			void this.openSearchResult({ ...match, category: 'text', rootPath: root, id: 'find-result', name: match.text, detail: match.filePath })
				.catch(() => new Notice('Could not open this search result.'));
		}, (state) => { this.findStates.set(root, state); this.findInFiles = null; }, this.findStates.get(root));
		this.findInFiles.open();
	}

	openSearchEverywhere(tab: SearchTab = 'all') {
		if (this.closed) return;
		if (!this.repoPath) { new Notice('Open a folder first.'); return; }
		if (this.everywhere) { this.everywhere.setTab(tab); return; }
		this.filePicker?.close();
		this.findInFiles?.close();
		const actions: SearchAction[] = [
			{ id: 'quick-open', name: 'Quick open file', run: () => this.openFiles() },
			{ id: 'locate-current-file', name: 'Locate current file in tree', run: () => { void this.locateCurrentFile(); } },
			{ id: 'search-in-files', name: 'Search in files', run: () => this.focusSearch('content') },
			{ id: 'document-symbols', name: 'Go to symbol in file', run: () => this.openSymbols(true) },
			{ id: 'workspace-symbols', name: 'Go to symbol in workspace', run: () => this.openSymbols(false) },
			{ id: 'restart-php-navigation', name: 'Restart language navigation', run: () => this.restartNavigation() },
			{ id: 'back', name: 'Go back', run: () => { void this.codePane.goBack(); } },
			{ id: 'forward', name: 'Go forward', run: () => { void this.codePane.goForward(); } },
		];
		this.everywhere = new SearchEverywhereModal(this.app, {
			root: this.repoPath, roots: [...this.folderPaths], includeWorktrees: this.plugin.settings.includeWorktrees,
			showHidden: this.plugin.settings.showHidden, recentFiles: [...this.recentFiles], actions,
			symbols: this.plugin.settings.phpLsp ? (query, root) => this.searchSymbols(query, root) : undefined,
		}, tab, (result) => {
			void this.openSearchResult(result).catch(() => new Notice('Could not open this search result.'));
		}, (state) => { this.everywhereState = state; this.everywhere = null; }, this.plugin.settings, this.everywhereState);
		this.everywhere.open();
	}

	private async openSearchResult(result: EverywhereResult) {
		if (this.closed) return;
		if (result.action) { result.action.run(); return; }
		if (!result.filePath) return;
		if (result.rootPath && result.rootPath !== this.repoPath) await this.activateFolder(result.rootPath);
		if (this.closed || (result.rootPath && this.repoPath !== result.rootPath)) return;
		const folderRequest = this.folderRequestId;
		if (!result.line) await this.openTab({ filePath: result.filePath, kind: 'code' });
		else {
			if (this.plugin.explorerDock?.isDocked(this)) await this.app.workspace.revealLeaf(this.leaf);
			++this.diffRequestId;
			this.codePane.rememberPosition();
			await this.codePane.openAt(result.filePath, result.line, result.column ?? 1);
		}
		if (!this.closed && folderRequest === this.folderRequestId) this.codePane.focus();
	}

	private searchSymbols(query: string, root: string) {
		if (this.closed) return Promise.resolve([]);
		if (root === this.repoPath && this.phpLsp) return this.phpLsp.workspaceSymbols(query);
		let lsp = this.searchLsps.get(root);
		if (!lsp) {
			const s = this.plugin.settings;
			lsp = new PhpLsp({ app: this.app, nodePath: s.nodePath || detectNode(),
				serverPath: s.intelephensePath || detectIntelephense(), licenceKey: s.intelephenseLicence,
				includeWorktrees: s.includeWorktrees, display: () => Promise.resolve(null), beforeJump: () => {} });
			lsp.setWorkspaceRoot(root);
			this.searchLsps.set(root, lsp);
		}
		return lsp.workspaceSymbols(query);
	}

	openFiles() {
		if (this.plugin.settings.searchMode === 'phpstorm') { this.openSearchEverywhere('files'); return; }
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
		if (!document && this.plugin.settings.searchMode === 'phpstorm') { this.openSearchEverywhere('symbols'); return; }
		if (!this.phpLsp) { new Notice('Enable language navigation in settings.'); return; }
		const file = this.codePane.getCurrentFile();
		if (document && (!file || !isPhpFile(file))) { new Notice('Open a source file first.'); return; }
		const folderRequest = this.folderRequestId;
		new SymbolPicker(this.app, this.phpLsp, document ? file ?? undefined : undefined, (filePath, line, column) => {
			if (this.closed || folderRequest !== this.folderRequestId) return;
			++this.diffRequestId; void this.codePane.openAt(filePath, line, column).then(() => this.codePane.focus());
		}).open();
	}

	async onClose() {
		this.closed = true;
		await this.plugin.explorerDock?.detach(this);
		this.clearShortcuts?.();
		this.findInFiles?.close();
		++this.folderRequestId;
		this.folderTabs?.dispose();
		this.fileTree?.dispose();
		this.folderSessions.clear();
		this.filePicker?.close();
		this.everywhere?.close();
		for (const lsp of this.searchLsps.values()) lsp.dispose();
		this.searchLsps.clear();
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
