import type { FileObservation } from '../files/index.ts';
import { FileScope } from '../files/index.ts';
import type { RepositoryContext } from '../git/index.ts';
import { clearWorktreeCaches } from '../git/index.ts';
import { WorkspaceController } from '../app/index.ts';
import { WorkspaceTransitions } from '../app/index.ts';
import { WorkspaceSession } from '../workspace/index.ts';
import { ItemView, WorkspaceLeaf, Notice, Scope, Platform, setIcon } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type {PluginContext} from './PluginContext.ts';
import { FileTree } from './fileTree.ts';
import type {NewEntryKind} from '../files/index.ts';
import { confirmAction, chooseDocumentConflict } from './confirmModal.ts';
import { promptForName } from './nameModal.ts';
import { containsFile } from '../files/index.ts';
import { CodePane } from './codePane.ts';
import { SearchPanel } from './searchPanel.ts';
import { EditorTabs, type SourceTab } from './editorTabs.ts';
import { FolderTabs } from './folderTabs.ts';
import { normalizeFolderWorkspace } from '../workspace/index.ts';
import { SymbolPicker } from './symbolPicker.ts';
import { FilePicker } from './filePicker.ts';
import { SearchEverywhereModal, type EverywhereState } from './searchEverywhereModal.ts';
import { FindInFilesModal } from './findInFilesModal.ts';
import { addVerticalSplitter } from './verticalSplitter.ts';
import type { FindInFilesState } from '../search/index.ts';
import {bindShortcuts} from './searchShortcuts.ts';
import {normalizeShortcuts} from '../app/index.ts';
import { registerDoubleShiftSearch } from './searchMode.ts';
import type { SearchTab, SearchAction, EverywhereResult } from '../search/index.ts';

import { LspNavigation, navigationAdapters } from './lspNavigation.ts';
import {getFileDiff,type ChangedFile} from '../git/index.ts';
import {renderDiff} from './renderDiff.ts';
import { MarkdownPreview, isMarkdownFile } from '../obsidian/index.ts';

export const VIEW_TYPE = 'source-observer';

/** Debounce delay for the file-tree search input, in ms. */
const SEARCH_DEBOUNCE_MS = 0;
/** Keeps section title ids unique across open views. */
let sectionTitleCount = 0;

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
	plugin: PluginContext;
 private workspaceState?: WorkspaceSession;
 private transitionsState?: WorkspaceTransitions;
 private get transitions() { return this.transitionsState ??= new WorkspaceTransitions(this.workspaceSession,()=>this.closed); }
 private get workspaceSession() { return this.workspaceState ??= new WorkspaceSession(); }
 private controllerState?: WorkspaceController;
 private get workspaceController() {
  return this.controllerState ??= new WorkspaceController(this.workspaceSession, {
   closed:()=>this.closed, prepareDocument:()=>this.codePane.prepareToLeave(),
   captureFolder:()=>({editor:this.codePane.captureSession(),tabs:this.editorTabs.captureState(),search:this.searchPanel.captureState(),treeQuery:this.treeSearchInput.value,changesQuery:this.changesQuery}),
   restoreEditor:session=>this.codePane.restorePreparedSession(session),
   beforeChange:()=>{
    ++this.workspaceSession.contentGeneration; this.filePicker?.close();this.everywhere?.close();this.findInFiles?.close();this.stopWatching();
    if(this.treeSearchTimer!==null) {window.clearTimeout(this.treeSearchTimer);this.treeSearchTimer=null;}
    this.indexedWorktrees=[];this.isRepo=false;this.gitRoot='';this.gitContext=null;this.repositoryContext=null;this.setGitError(null);this.updateGitVisibility();this.allChanges=[];
   },
   presentFolder:(dir,session)=>{
    this.markdownPreview.clear();this.editorTabs.restoreState(session?.tabs??null);this.pathLabel.setText('');this.updatePreviewToggle();
    this.treeSearchInput.value=session?.treeQuery??'';this.changesQuery=session?.changesQuery??'';this.changesSearchInput.value=this.changesQuery;
    this.treeSearchInput.toggleClass('so-search-input-hidden',!this.treeSearchInput.value);this.changesSearchInput.toggleClass('so-search-input-hidden',!this.changesQuery);
    this.updateChangeCounts();this.renderChanges(this.changesQuery);this.folderTabs.setFolders(this.workspaceSession.folders,dir);
    this.searchPanel.setRoot(dir);this.searchPanel.restoreState(session?.search??null);this.syncNavigation();
   },
   presentFolders:()=>this.folderTabs.setFolders(this.workspaceSession.folders,this.workspaceSession.activeFolder),persistFolders:()=>this.persistFolders(),
   loadTree:dir=>this.fileTree.loadPath(dir),worktrees:dir=>this.plugin.worktrees.roots(dir),applyWorktrees:roots=>{this.indexedWorktrees=roots;},
   treeQuery:()=>this.treeSearchInput.value,filterTree:query=>this.fileTree.search(query),refreshGit:()=>this.refreshChanges(),watch:()=>this.startWatching(),
   showActive:async()=>{
    const active=this.editorTabs.getActive();
    if(active?.kind==='code' && this.workspaceSession.previews.has(active.filePath)) await this.showPreview(active.filePath);
    else if(active?.kind==='code') await this.codePane.open(active.filePath);else if(active) await this.openTab(active);
   },
   poll:enabled=>{if(enabled)this.observation?.enablePolling();else this.observation?.stopPolling();},
  });
 }
	private fileTree!: FileTree;
	private codePane!: CodePane;
	private markdownPreview!: MarkdownPreview;
	private previewToggle!: HTMLButtonElement;
	/** Markdown code tabs that show the rendered file instead of its source. */
	private languageNavigation: LspNavigation | null = null;
	private lspKey = '';
	private rightPane!: HTMLElement;
	private changesContainer!: HTMLElement;
	private changesCounts!: HTMLElement;
	private pathLabel!: HTMLElement;
	private isRepo = false;
	private gitRoot = '';
	private gitContext: { path: string; isDirectory: boolean } | null = null;
	private gitSplitter!: HTMLElement;
	private allChanges: readonly ChangedFile[] = [];
	private changesQuery = '';
	private observation?:FileObservation;
 private repositoryContext:RepositoryContext|null=null;
 private gitError:string|null=null;
 private gitErrorLabel?:HTMLElement;
	private treeSearchTimer: number | null = null;
	private indexedWorktrees: string[] = [];
	private searchPanel!: SearchPanel;
	private editorTabs!: EditorTabs;
	private filePicker: FilePicker | null = null;
	private everywhere: SearchEverywhereModal | null = null;
	private everywhereState?: EverywhereState;
	private findInFiles: FindInFilesModal | null = null;
	private findStates = new Map<string, FindInFilesState>();
	private clearShortcuts?: () => void;
	private searchLsps = new Map<string, LspNavigation>();
	private gitSection!: HTMLElement;
	private gitToggle!: HTMLButtonElement;
	private closed = false;
	private folderTabs!: FolderTabs;
	private gitRequestId = 0;
	private treeSearchInput!: HTMLInputElement;
	private changesSearchInput!: HTMLInputElement;

	constructor(leaf: WorkspaceLeaf, plugin: PluginContext) {
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
		// The sidebar moves into Obsidian's Files panel when docked, so its size travels with it.
		const applySidebarFontSize = () => sidebar.setCssProps({ '--so-sidebar-font-size': `${this.plugin.settings.sidebarFontSize}px` });
		applySidebarFontSize();
		registerDoubleShiftSearch(this, root,
			() => !this.closed && this.plugin.settings.searchMode === 'phpstorm' && this.plugin.settings.doubleShiftSearch !== false,
			() => this.app.workspace.getActiveViewOfType(SourceObserverView) === this || this.plugin.explorerDock.isActive(this),
			() => this.openSearchEverywhere(), (target) => root.contains(target) || sidebar.contains(target));
		this.folderTabs = new FolderTabs(sidebar.createDiv(),
			(dir) => { void this.activateFolder(dir).catch(() => new Notice('Could not open this folder.')); },
			(dir) => { void this.closeFolder(dir).catch(() => new Notice('Could not close this folder.')); });

		const sections = sidebar.createDiv({ cls: 'so-sidebar-sections' });
		const { section: filesSection, body: treeBody, searchInput: treeSearch, titleId: filesTitleId } = this.buildSection(sections, 'Files');
		filesSection.addClass('so-files-section');
		this.treeSearchInput = treeSearch;
		// Named by the section title: an aria-label would show Obsidian's tooltip over the whole tree.
		const treeContainer = treeBody.createDiv({ cls: 'so-tree', attr: { 'aria-labelledby': filesTitleId } });

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
   this.plugin.repositories.invalidate();
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
  this.gitErrorLabel=changesBody.createDiv({cls:'so-changes-empty'});this.gitErrorLabel.hidden=true;
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
		this.addToolbarButton(toolbar, 'shapes', 'Go to symbol', () => this.showSymbols(false));
		this.addToolbarButton(toolbar, 'corner-down-right', 'Go to definition (F12)', () => { const view = this.codePane.getEditor(); if (view) this.languageNavigation?.jumpToDefinition(view); });
		this.addToolbarButton(toolbar, 'list', 'Find references (Shift+F12)', () => { const view = this.codePane.getEditor(); if (view) this.languageNavigation?.findReferences(view); });
		this.markdownPreview = this.addChild(new MarkdownPreview(this.app));
		this.editorTabs = new EditorTabs(main.createDiv(), (tab) => { void this.openTab(tab); }, () => {
			void this.closeContentIfEmpty();
		}, (tab, event, element) => this.plugin.showFileMenu({ path: tab.filePath, isDirectory: false }, event, element, this.workspaceSession.activeFolder, {
			onDeleted: (filePath, rootPath) => this.onPathDeleted(filePath, rootPath),
			addLeadingItems: (menu) => {
				for (const [title, icon, scope] of [['Close others', 'x', 'others'], ['Close tabs to the left', 'arrow-left-to-line', 'left'],
					['Close tabs to the right', 'arrow-right-to-line', 'right']] as const) {
					menu.addItem((item) => item.setTitle(title).setIcon(icon).setDisabled(!this.editorTabs.canCloseRelative(tab, scope))
						.onClick(() => this.editorTabs.closeRelative(tab, scope)));
				}
			},
		}));
		const pathBar = main.createDiv({ cls: 'so-path-bar' });
		this.pathLabel = pathBar.createDiv({ cls: 'so-path-label' });
		this.previewToggle = pathBar.createEl('button', { cls: 'so-search-icon-btn so-preview-toggle' });
		this.registerDomEvent(this.previewToggle, 'click', () => { void this.toggleMarkdownPreview(); });
		this.rightPane = main.createDiv({ cls: 'so-pane' });

		this.codePane = new CodePane(
			this.rightPane,
			this.plugin.settings.fontSize,
			this.plugin.settings.syntaxTheme,
			(filePath) => {
				// Source replaces any diff or preview that is still loading.
				++this.workspaceSession.contentGeneration;
				this.workspaceSession.previews.delete(filePath);
				this.markdownPreview.clear();
				this.fileShown(filePath);
			},
			this.plugin.settings.editorFontFamily,
			this.plugin.settings.editorFontLigatures,
			{ documents: this.plugin.documents, navigation: this.workspaceSession.navigation },
		);
		this.editorTabs.setSession(this.workspaceSession.tabs);
		this.editorTabs.setCloseGuard(() => this.codePane.prepareToLeave());
		this.codePane.setSaveHandlers({
			saved: () => { this.scheduleChangesRefresh(); this.plugin.persistDocumentRecovery(); },
			conflict: (filePath, missing) => chooseDocumentConflict(this.app, filePath, missing),
			failed: (filePath, error) => {
				this.plugin.persistDocumentRecovery();
				new Notice(`Could not save ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
			},
		});
		this.syncNavigation();
		this.codePane.setShortcuts(this.plugin.settings.shortcuts);

		this.fileTree = new FileTree(
			treeContainer,
			this.plugin.settings.showHidden,
			(filePath) => { void this.openTab({ filePath, kind: 'code' }); },
			(selection) => this.setGitContext(selection),
			(selection, event, row, root) => this.plugin.showFileMenu(selection, event, row, root, {
				onDeleted: (deletedPath, rootPath) => this.onPathDeleted(deletedPath, rootPath),
				confirmFolderDelete: (folderPath) => confirmAction(this.app, 'Delete folder',
					`Are you sure you want to delete "${path.basename(folderPath)}" and everything in it? It will be moved to the system trash.`, 'Delete'),
				promptNewName: (kind, parentDir, submit) => promptForName(this.app, kind === 'file' ? 'New file' : 'New folder',
					`In ${path.join(path.basename(root), path.relative(root, parentDir))}`, 'Create', submit),
				onCreated: (createdPath, kind, rootPath) => this.onPathCreated(createdPath, kind, rootPath),
			}),
		);

  this.fileTree.setSearchRuntime(this.plugin.search);
 this.fileTree.setRepositories(this.plugin.repositories,()=>this.observeRepositories(),dir=>this.plugin.worktrees.roots(dir));
		this.fileTree.setIncludeWorktrees(this.plugin.settings.includeWorktrees);
		void this.fileTree.setExcludedFiles(this.plugin.settings.excludedFiles);
		const searchContainer = sections.createDiv({ cls: 'so-workspace-search' });
		sections.insertBefore(searchContainer, gitSplitter);
		this.searchPanel = new SearchPanel(searchContainer, (filePath, line, column) => {
			void this.openSearchResult({ id: filePath, category: 'text', name: '', detail: '', filePath, line: line ?? 1, column });
		}, (include) => { this.plugin.settings.includeWorktrees = include; void this.plugin.saveSettings(); }, this.plugin.search);
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
			applySidebarFontSize();
			this.codePane.setTheme(this.plugin.settings.syntaxTheme);
			this.fileTree.setShowHidden(this.plugin.settings.showHidden);
			this.fileTree.setIncludeWorktrees(this.plugin.settings.includeWorktrees);
			void this.fileTree.setExcludedFiles(this.plugin.settings.excludedFiles);
			this.searchPanel.setIncludeWorktrees(this.plugin.settings.includeWorktrees);
			this.searchPanel.setShowHidden(this.plugin.settings.showHidden);
			this.updateGitVisibility();
   this.observation?.updateScope(this.fileScope());
			this.syncNavigation();
		});
		this.register(() => this.plugin.settingsEvents.offref(settingsRef));

		const workspace = normalizeFolderWorkspace(this.plugin.settings.openedFolderPaths, this.plugin.settings.lastOpenedPath);
		this.workspaceSession.folders = workspace.paths;
		this.folderTabs.setFolders(this.workspaceSession.folders, workspace.activePath);
		if (workspace.activePath) await this.activateFolder(workspace.activePath);
		await this.plugin.explorerDock.attach({ view: this, sidebar, home: root, isClosed: () => this.closed });
	}

	/** Starts, restarts or stops language servers to match the settings. */
	private syncNavigation() {
		const s = this.plugin.settings;
		const key = (s.phpLsp || s.goLsp) && this.workspaceSession.activeFolder
			? [this.workspaceSession.activeFolder, s.phpLsp, s.goLsp, s.nodePath, s.intelephensePath, s.intelephenseLicence, s.goPath, s.goplsPath, s.includeWorktrees].join('\0') : '';
		if (key === this.lspKey) return;
		this.lspKey = key;
		this.codePane.setLsp(null);
		for (const lsp of this.searchLsps.values()) lsp.dispose();
		this.searchLsps.clear();
		this.languageNavigation?.dispose();
		const folderRequest = this.workspaceSession.folderEpoch;
		this.languageNavigation = key
			? new LspNavigation({
				app: this.app, runtime: this.plugin.languages,
				includeWorktrees: s.includeWorktrees,
				display: (filePath) => {
					if (this.closed || folderRequest !== this.workspaceSession.folderEpoch) return Promise.resolve(null);
					++this.workspaceSession.contentGeneration; this.codePane.rememberPosition(); return this.codePane.open(filePath);
				},
				beforeJump: () => this.codePane.rememberPosition(),
			}, navigationAdapters(s))
			: null;
		this.languageNavigation?.setWorkspaceRoot(this.workspaceSession.activeFolder);
		this.codePane.setLsp(this.languageNavigation);
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
		await this.workspaceController.open(valid);
	}

	private persistFolders() {
		this.plugin.settings.openedFolderPaths = [...this.workspaceSession.folders];
		this.plugin.settings.lastOpenedPath = this.workspaceSession.activeFolder;
		return this.plugin.saveSettings();
	}

	private async closeFolder(dir: string) {await this.workspaceController.close(dir);}
 private async activateFolder(dir: string) {await this.workspaceController.activate(dir);}

	private fileScope() {
  return new FileScope(this.workspaceSession.activeFolder,{showHidden:this.plugin.settings.showHidden,includeWorktrees:this.plugin.settings.includeWorktrees,
   excludedFiles:this.plugin.settings.excludedFiles??[],worktreeRoots:this.indexedWorktrees});
 }
 private refreshObservedGit() {
  const owner=this.observation;if(!owner)return;
  void this.refreshWorktreeContext().then(()=>{if(this.observation===owner && !this.closed)void this.refreshChanges();});
 }
 private async refreshWorktreeContext() {
  const root=this.workspaceSession.activeFolder,owner=this.observation;
  if(!root || !owner)return;
  const worktrees=await this.plugin.worktrees.roots(root);
  if(this.closed || root!==this.workspaceSession.activeFolder || this.observation!==owner)return;
  if(JSON.stringify(worktrees)===JSON.stringify(this.indexedWorktrees)){owner.updateScope(this.fileScope());return;}
  this.indexedWorktrees=worktrees;owner.updateScope(this.fileScope());this.plugin.search.invalidate(root);
  await this.fileTree.setWorktreeRoots(worktrees);
 }
 private observeRepositories() {
  const contexts=[...(this.fileTree.getRepositoryContexts?.()??[]),...(this.repositoryContext?[this.repositoryContext]:[])];
  this.observation?.setRepositories(contexts);
 }
 private startWatching() {
  this.stopWatching();
  if(!this.workspaceSession.activeFolder || this.closed)return;
  this.observation=this.plugin.observations.open(this.fileScope(),{
   currentFile:()=>this.codePane.getCurrentFile(),contentChanged:()=>{void this.codePane.reloadIfChanged();},
   pathsChanged:()=>{this.plugin.search.invalidate(this.workspaceSession.activeFolder);void this.plugin.search.warm(this.workspaceSession.activeFolder,this.plugin.settings.includeWorktrees).catch(()=>{});void this.fileTree.refresh().catch(()=>{});},
   gitChanged:()=>this.refreshObservedGit(),
   invalidateGit:(target,topology)=>{
    if(target)this.plugin.repositories.invalidatePath(target);else this.plugin.repositories.invalidate();
    if(topology){this.plugin.repositories.invalidateDiscovery();this.plugin.worktrees.clear();clearWorktreeCaches();}
   },
   poll:()=>{this.refreshObservedGit();void this.fileTree.refresh().catch(()=>{});void this.codePane.reloadIfChanged();},
  },{
   // Timer adaptation keeps the filesystem owner independent of Obsidian's window lifecycle.
   after:(callback,delay)=>{const timer=window.setTimeout(callback,delay);return ()=>window.clearTimeout(timer);},
   every:(callback,delay)=>{const timer=window.setInterval(callback,delay);return ()=>window.clearInterval(timer);},
   watch:(target,recursive,changed,failed)=>{const handle=fs.watch(target,{recursive},(event,filename)=>changed(event,filename?.toString()??null));handle.on('error',failed);return handle;},
  });
  this.observeRepositories();
 }
 private scheduleChangesRefresh() {this.plugin.repositories.invalidate();this.observation?.scheduleGit();}
 private stopWatching() {if(this.observation)this.plugin.observations.close(this.observation);this.observation=undefined;}

	private async locateCurrentFile() {
		const filePath = this.editorTabs.getActive()?.filePath ?? this.codePane.getCurrentFile();
		if (!filePath) { new Notice('Open a file first.'); return; }
		await this.revealInTree(filePath, 'Could not locate this file. Check hidden-file and worktree visibility.');
	}

	/** Clears the tree filter and reveals `target`, or shows `failure` when the tree hides it. */
	private async revealInTree(target: string, failure: string) {
		if (this.treeSearchTimer) window.clearTimeout(this.treeSearchTimer);
		this.treeSearchTimer = null;
		this.treeSearchInput.value = '';
		const section = this.treeSearchInput.closest('.so-section');
		section?.querySelector('.so-section-body')?.removeClass('so-section-body-hidden');
		section?.querySelector('.so-section-toggle')?.setAttribute('aria-expanded', 'true');
		section?.querySelector('.so-section-chevron')?.setText('▾');
		const request = this.workspaceSession.folderGeneration;
		if (!await this.fileTree.reveal(target) && !this.closed && request === this.workspaceSession.folderGeneration) {
			await this.fileTree.search('');
			new Notice(failure);
		}
	}

	private buildSection(parent: HTMLElement, title: string) {
		const section = parent.createDiv({ cls: 'so-section' });
		const header = section.createDiv({ cls: 'so-section-header' });

		const toggle = header.createEl('button', { cls: 'so-section-toggle', attr: { 'aria-label': `Toggle ${title.toLowerCase()}`, 'aria-expanded': 'true' } });
		const chevron = toggle.createSpan({ cls: 'so-section-chevron', text: '▾' });
		const titleId = `so-section-title-${++sectionTitleCount}`;
		toggle.createSpan({ cls: 'so-section-title', text: title, attr: { id: titleId } });

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

		return { section, body, searchInput, headerRight, titleId };
	}

	private setGitContext(context: { path: string; isDirectory: boolean }) {
		if (this.gitContext?.path === context.path && this.gitContext.isDirectory === context.isDirectory) return;
		this.gitContext = context;
		// Keep the current snapshot visible until the next Git context is resolved.
		void this.refreshChanges();
	}

	private setGitError(error:string|null) {
  this.gitError=error;
  if(error && !this.allChanges.length)this.changesContainer?.empty();
  if(this.gitErrorLabel){this.gitErrorLabel.hidden=!error;this.gitErrorLabel.setText(error?'Git status unavailable':'');this.gitErrorLabel.title=error??'';}
 }
 private async refreshChanges() {
  if(!this.workspaceSession.activeFolder)return;
  void this.fileTree.refreshGitStatus();
  const root=this.workspaceSession.activeFolder,folderRequest=this.workspaceSession.folderGeneration,requestId=++this.gitRequestId;
  const current=()=>!this.closed && root===this.workspaceSession.activeFolder && folderRequest===this.workspaceSession.folderGeneration && requestId===this.gitRequestId;
  const selected=this.gitContext??{path:root,isDirectory:true};
  const discovery=await this.plugin.repositories.resolve(selected.path,selected.isDirectory);if(!current())return;
  if(discovery.state==='error'){this.setGitError(discovery.error);this.updateGitVisibility();return;}
  const context=discovery.state==='ready'?discovery.context:null;
  const snapshot=context?await this.plugin.repositories.read(context):null;if(!current())return;
  const error=snapshot?.state==='error'?snapshot.error:null;
  const changes=snapshot?.state==='ready'?snapshot.changes:snapshot?.lastGood?.changes??(context?.root===this.gitRoot?this.allChanges:[]);
  const changed=this.gitRoot!==(context?.root??'') || this.isRepo!==!!context || changes.length!==this.allChanges.length
   || changes.some((change,index)=>change.file!==this.allChanges[index]?.file || change.code!==this.allChanges[index]?.code);
  const errorChanged=!!this.gitError!==!!error;
  this.repositoryContext=context;this.observeRepositories();this.setGitError(error);
  this.gitRoot=context?.root??'';this.isRepo=!!context;this.updateGitVisibility();
  if(!changed && !(errorChanged && !changes.length))return;
  this.allChanges=changes;this.updateChangeCounts();this.renderChanges(this.changesQuery);
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
   if(this.gitError)return;
			const text = query
				? 'No results'
				: this.isRepo
					? this.gitError?'Git status unavailable':'No changes'
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
		const filePath = path.isAbsolute(cf.file) ? cf.file : path.join(root, cf.file);
		row.addEventListener('contextmenu', (event) => {
			if (this.closed || root !== this.gitRoot) return;
			event.preventDefault();
			event.stopPropagation();
			this.plugin.showFileMenu({ path: filePath, isDirectory: false }, event, row, root, {
				onDeleted: (deletedPath, rootPath) => this.onPathDeleted(deletedPath, rootPath),
			});
		});

		row.addEventListener('click', () => {
			if (this.closed || root !== this.gitRoot) return;
			void this.openTab({ filePath, kind: 'diff' });
		});
	}

	/** Opens a new file and selects the new entry in the tree. */
	private async onPathCreated(createdPath: string, kind: NewEntryKind, rootPath: string): Promise<void> {
		this.plugin.search.invalidate(rootPath);
		if (this.closed || this.workspaceSession.activeFolder !== rootPath) return;
		// Refresh first: revealing alone re-reads the parent and would collapse its open subfolders.
		await this.fileTree.refresh();
		if (this.closed || this.workspaceSession.activeFolder !== rootPath) return;
		if (kind === 'file') await this.openTab({ filePath: createdPath, kind: 'code' });
		if (this.closed || this.workspaceSession.activeFolder !== rootPath) return;
		await this.revealInTree(createdPath, `${kind === 'file' ? 'File' : 'Folder'} created, but the tree hides it. Check hidden-file, excluded-file and worktree settings.`);
	}

	/** Forgets a trashed file, or every file inside a trashed folder, across tabs, history and folder sessions. */
	private async onPathDeleted(deletedPath: string, rootPath: string): Promise<void> {
		const removed = (filePath: string) => containsFile(deletedPath, filePath);
		this.plugin.search.invalidate(rootPath);
		this.workspaceSession.forget(removed);
		if (this.closed) return;
		this.codePane.forgetFile(deletedPath);
		this.plugin.persistDocumentRecovery();
		const activeTab = this.editorTabs.getActive();
		if (activeTab && removed(activeTab.filePath)) ++this.workspaceSession.contentGeneration;
		this.editorTabs.closeFile(deletedPath);
		// Folder tabs opened from inside a trashed folder no longer exist.
		for (const folder of this.workspaceSession.folders.filter((dir) => dir !== this.workspaceSession.activeFolder && removed(dir))) await this.closeFolder(folder);
		if (this.closed) return;
		const activeRoot = this.workspaceSession.activeFolder;
		await this.fileTree.refresh();
		if (this.closed || this.workspaceSession.activeFolder !== activeRoot) return;
		const active = this.editorTabs.getActive();
		this.setGitContext(active ? { path: active.filePath, isDirectory: false }
			: this.fileTree.getSelectedPath() ?? { path: activeRoot, isDirectory: true });
	}

	private async closeContentIfEmpty() {
  if(this.editorTabs.getActive()) return;
  const transition=this.transitions.content();
		if (await this.codePane.suspend() === false) {
			const filePath = this.codePane.getCurrentFile();
			if (filePath) this.editorTabs.show({ filePath, kind: 'code' });
			return;
		}
  if(!transition.current() || this.editorTabs.getActive()) return;
		this.markdownPreview.clear(); this.pathLabel.setText('');
		this.updatePreviewToggle();
		this.setGitContext(this.fileTree.getSelectedPath() ?? { path: this.workspaceSession.activeFolder, isDirectory: true });
	}

	private async openTab(tab: SourceTab) {
		if (this.plugin.explorerDock?.isDocked(this)) await this.app.workspace.revealLeaf(this.leaf);
		const target = this.workspaceSession.target(tab);
		if (target.kind === 'source' && target.mode === 'preview') {
			await this.showPreview(tab.filePath);
			return;
		}
  const transition=this.transitions.content();
  const requestId=transition.generation;
		if (tab.kind === 'code') {
			this.codePane.rememberPosition();
			await this.codePane.open(tab.filePath);
			return;
		}
		if (await this.codePane.suspend() === false || requestId !== this.workspaceSession.contentGeneration || this.closed) return;
		this.markdownPreview.clear();
		this.editorTabs.show(tab);
		this.updatePreviewToggle();
		this.setGitContext({ path: tab.filePath, isDirectory: false });
		this.pathLabel.setText(path.relative(this.workspaceSession.activeFolder, tab.filePath) + ' (diff)');
		const diff = await getFileDiff(path.dirname(tab.filePath), tab.filePath);
		if (requestId !== this.workspaceSession.contentGeneration || this.closed) return;
		renderDiff(this.rightPane, diff);
	}

	/** Records a file shown in the main pane, either as source or as a preview. */
	private fileShown(filePath: string) {
		this.workspaceSession.shown(filePath);
		this.pathLabel.setText(path.relative(this.workspaceSession.activeFolder, filePath) || filePath);
		this.editorTabs.show({ filePath, kind: 'code' });
		this.setGitContext({ path: filePath, isDirectory: false });
		this.updatePreviewToggle();
	}

	private async showPreview(filePath: string) {
  const requestId = ++this.workspaceSession.contentGeneration;
  if (await this.codePane.suspend() === false || requestId !== this.workspaceSession.contentGeneration || this.closed) return false;
  this.fileShown(filePath);
		await this.markdownPreview.show(this.rightPane, filePath, () => !this.closed && requestId === this.workspaceSession.contentGeneration);
  return !this.closed && requestId===this.workspaceSession.contentGeneration;
	}

	private async toggleMarkdownPreview() {
		const active = this.editorTabs.getActive();
		if (this.closed || active?.kind !== 'code' || !isMarkdownFile(active.filePath)) return;
  const preview = this.workspaceSession.previews.has(active.filePath);
  if(!await this.codePane.prepareToLeave() || this.closed || this.editorTabs.getActive()?.filePath!==active.filePath) return;
  if(preview) this.workspaceSession.previews.delete(active.filePath); else this.workspaceSession.previews.add(active.filePath);
  await this.openTab(active);
	}

	private updatePreviewToggle() {
		const active = this.editorTabs.getActive();
		this.previewToggle.hidden = active?.kind !== 'code' || !isMarkdownFile(active.filePath);
		if (!active || this.previewToggle.hidden) return;
		const preview = this.workspaceSession.previews.has(active.filePath);
		this.previewToggle.setAttribute('aria-label', preview ? 'Show source' : 'Show preview');
		setIcon(this.previewToggle, preview ? 'file-code' : 'book-open');
	}

	private addToolbarButton(parent: HTMLElement, icon: string, label: string, callback: () => void) {
		const button = parent.createEl('button', { cls: 'so-search-icon-btn', attr: { 'aria-label': label } });
		setIcon(button, icon); this.registerDomEvent(button, 'click', callback);
	}

	private updateGitVisibility() {
		const hidden = this.plugin.settings.gitPanelHidden;
		this.gitSection.hidden = !this.isRepo && !this.gitError;
		if (this.gitSplitter) this.gitSplitter.hidden = (!this.isRepo && !this.gitError) || hidden;
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
		if (!this.workspaceSession.activeFolder) { new Notice('Open a folder first.'); return; }
		if (this.findInFiles) { this.findInFiles.focus(); return; }
		const root = this.workspaceSession.activeFolder;
		const context = { root, search: this.plugin.search, selectedPath: this.fileTree.getSelectedPath(), treeFocused: this.fileTree.hasFocus(),
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
		if (!this.workspaceSession.activeFolder) { new Notice('Open a folder first.'); return; }
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
			root: this.workspaceSession.activeFolder, search: this.plugin.search, roots: [...this.workspaceSession.folders], includeWorktrees: this.plugin.settings.includeWorktrees,
			showHidden: this.plugin.settings.showHidden, recentFiles: [...this.workspaceSession.recents], actions,
			symbols: (this.plugin.settings.phpLsp || this.plugin.settings.goLsp) ? (query, root) => this.searchSymbols(query, root) : undefined,
		}, tab, (result) => {
			void this.openSearchResult(result).catch(() => new Notice('Could not open this search result.'));
		}, (state) => { this.everywhereState = state; this.everywhere = null; }, this.plugin.settings, this.everywhereState);
		this.everywhere.open();
	}

	private async openSearchResult(result: EverywhereResult) {
		if (this.closed) return;
		if (result.action) { result.action.run(); return; }
		if (!result.filePath) return;
		if (result.rootPath && result.rootPath !== this.workspaceSession.activeFolder) await this.activateFolder(result.rootPath);
		if (this.closed || (result.rootPath && this.workspaceSession.activeFolder !== result.rootPath)) return;
		const folderRequest = this.workspaceSession.folderGeneration;
		if (!result.line) await this.openTab({ filePath: result.filePath, kind: 'code' });
		else {
			if (this.plugin.explorerDock?.isDocked(this)) await this.app.workspace.revealLeaf(this.leaf);
			++this.workspaceSession.contentGeneration;
			this.codePane.rememberPosition();
			await this.codePane.openAt(result.filePath, result.line, result.column ?? 1);
		}
		if (!this.closed && folderRequest === this.workspaceSession.folderGeneration) this.codePane.focus();
	}

	private searchSymbols(query: string, root: string) {
		if (this.closed) return Promise.resolve([]);
		if (root === this.workspaceSession.activeFolder && this.languageNavigation) return this.languageNavigation.workspaceSymbols(query);
		let lsp = this.searchLsps.get(root);
		if (!lsp) {
			const s = this.plugin.settings;
			lsp = new LspNavigation({ app: this.app, runtime: this.plugin.languages, includeWorktrees: s.includeWorktrees,
				display: () => Promise.resolve(null), beforeJump: () => {} }, navigationAdapters(s));
			lsp.setWorkspaceRoot(root);
			this.searchLsps.set(root, lsp);
		}
		return lsp.workspaceSymbols(query);
	}

	openFiles() {
		if (this.plugin.settings.searchMode === 'phpstorm') { this.openSearchEverywhere('files'); return; }
		if (this.closed) return;
		if (!this.workspaceSession.activeFolder) { new Notice('Open a folder first.'); return; }
		if (this.filePicker) { this.filePicker.inputEl.focus(); return; }
		this.filePicker = new FilePicker(this.app, this.workspaceSession.activeFolder, {
			includeWorktrees: this.plugin.settings.includeWorktrees,
			showHidden: this.plugin.settings.showHidden,
		}, (filePath) => {
			if (this.closed) return;
			void this.openTab({ filePath, kind: 'code' }).then(() => this.codePane.focus());
		}, () => { this.filePicker = null; }, this.plugin.search);
		this.filePicker.open();
	}

	openSymbols(document: boolean) { this.showSymbols(document); }

	restartNavigation() { this.plugin.languages.restart(); this.lspKey = ''; this.syncNavigation(); }

	private showSymbols(document: boolean) {
		if (!document && this.plugin.settings.searchMode === 'phpstorm') { this.openSearchEverywhere('symbols'); return; }
		if (!this.languageNavigation) { new Notice('Enable language navigation in settings.'); return; }
		const file = this.codePane.getCurrentFile();
		if (document && (!file || !this.languageNavigation.supports(file))) { new Notice('Open a source file first.'); return; }
		const folderRequest = this.workspaceSession.folderGeneration;
		new SymbolPicker(this.app, this.languageNavigation, document ? file ?? undefined : undefined, (filePath, line, column) => {
			if (this.closed || folderRequest !== this.workspaceSession.folderGeneration) return;
			++this.workspaceSession.contentGeneration; void this.codePane.openAt(filePath, line, column).then(() => this.codePane.focus());
		}).open();
	}

	async onClose() {
		if (this.codePane && !await this.codePane.prepareToLeave()) this.plugin.persistDocumentRecovery();
		this.closed = true;
		await this.plugin.explorerDock?.detach(this);
		this.clearShortcuts?.();
		this.findInFiles?.close();
		++this.workspaceSession.folderGeneration;
		this.folderTabs?.dispose();
		this.fileTree?.dispose();
		this.workspaceSession.sessions.clear();
		this.filePicker?.close();
		this.everywhere?.close();
		for (const lsp of this.searchLsps.values()) lsp.dispose();
		this.searchLsps.clear();
		++this.workspaceSession.contentGeneration;
		this.searchPanel?.dispose();
		this.stopWatching();
		if (this.treeSearchTimer) { window.clearTimeout(this.treeSearchTimer); this.treeSearchTimer = null; }
		this.codePane?.disposeView();
		this.languageNavigation?.dispose();
		this.languageNavigation = null;
	}
}
