import {LanguageConnection} from './desktop/index.ts';
import {createCodeMirrorEndpoint} from './ui/index.ts';
import {DesktopActions,type ElectronFileActions} from './desktop/index.ts';
import {VaultNavigation} from './obsidian/index.ts';
import {showFileContextMenu,type FileMenuOptions} from './ui/index.ts';
import { LanguageRuntime } from './language/index.ts';
import { LanguageNotices } from './obsidian/index.ts';
import { FileObservationRuntime } from './files/index.ts';
import { GitRepositoryStore } from './git/index.ts';
import { WorktreeDiscovery } from './git/index.ts';
import { Events, FileSystemAdapter, Notice, Platform, Plugin, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import { DocumentStore } from './documents/index.ts';
import { sourceDocumentIO,readDocumentText } from './files/index.ts';
import { DocumentRecoveryJournal } from './obsidian/index.ts';
import {
	DEFAULT_SETTINGS,
	SourceObserverSettings,
} from './app/index.ts';
import {SourceObserverSettingTab} from './obsidian/index.ts';
import { SourceObserverView, VIEW_TYPE } from './ui/index.ts';
import { normalizeSearchMode } from './app/index.ts';
import { normalizeShortcuts } from './app/index.ts';
import { ExplorerDock, EXPLORER_VIEW_TYPE, SourceExplorerView } from './obsidian/index.ts';
import { SearchRuntime } from './search/index.ts';
import { normalizeExcludedFiles, setExcludedFiles } from './files/index.ts';

export default class SourceObserverPlugin extends Plugin {
	settings!: SourceObserverSettings;
 desktop=new DesktopActions(()=>window.require('electron') as ElectronFileActions,Platform.isMacOS);
 showFileMenu(selection:Parameters<typeof showFileContextMenu>[0],event:MouseEvent|KeyboardEvent,row:HTMLElement,root:string,options:FileMenuOptions={}){
  showFileContextMenu(selection,event,row,root,options,{desktop:this.desktop,vault:new VaultNavigation(this.app)});
 }
	/** Fires 'changed' after settings are persisted so open views can re-render. */
	settingsEvents = new Events();
	explorerDock!: ExplorerDock;
	documents = new DocumentStore(sourceDocumentIO,{saved:()=>this.persistDocumentRecovery(),failed:()=>{this.persistDocumentRecovery();new Notice('Could not save detached source edits; recovery is retained.');},conflict:()=>Promise.resolve('cancel')},()=>this.persistDocumentRecovery());
 observations = new FileObservationRuntime();
 repositories = new GitRepositoryStore();
 worktrees = new WorktreeDiscovery();
 search = new SearchRuntime(root => this.worktrees.roots(root));
	private languageNotices=new LanguageNotices();
 languages=new LanguageRuntime((spec,events)=>new LanguageConnection(spec.root,spec.adapter,spec.includeWorktrees,events,createCodeMirrorEndpoint(spec,events,readDocumentText)),event=>this.languageNotices.handle(event));
	private recovery?: DocumentRecoveryJournal;

	async onload() {
		await this.loadSettings();
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			this.recovery = new DocumentRecoveryJournal(path.join(adapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id, 'unsaved-documents.json'));
			try {
				const recovered = this.recovery.read(); this.documents.restore(recovered);
				if (recovered.length) new Notice(`Recovered unsaved edits for ${recovered.length} file(s). Open those source files to review them.`);
			} catch { new Notice('Could not read document recovery. The journal was left intact.'); }
		}
 this.register(() => this.search.dispose());
		this.explorerDock = new ExplorerDock(this.app, () => this.settings.replaceFileExplorer);
		this.registerView(EXPLORER_VIEW_TYPE, (leaf) => new SourceExplorerView(leaf, () => { void this.activateView(); }));

		this.registerView(VIEW_TYPE, (leaf) => new SourceObserverView(leaf, this));
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => { void this.explorerDock.setActiveLeaf(leaf); }));

		this.addRibbonIcon('code-2', 'Source observer', () => { void this.activateView(); });

		this.addCommand({
			id: 'open',
			name: 'Open',
			callback: () => { void this.activateView(); },
		});

		this.addCommand({ id: 'search-in-files', name: 'Search in files', callback: () => { void this.withView((view) => view.focusSearch('content')); } });
		this.addCommand({ id: 'quick-open', name: 'Quick open file', callback: () => { void this.withView((view) => view.openFiles()); } });
		this.addCommand({ id: 'open-folders', name: 'Open folders', callback: () => { void this.withView((view) => { void view.openFolderDialog(); }); } });
		this.addCommand({ id: 'search-everywhere', name: 'Search everywhere', callback: () => { void this.withView((view) => view.openSearchEverywhere()); } });
		this.addCommand({ id: 'document-symbols', name: 'Go to symbol in file', callback: () => { void this.withView((view) => view.openSymbols(true)); } });
		this.addCommand({ id: 'workspace-symbols', name: 'Go to symbol in workspace', callback: () => { void this.withView((view) => view.openSymbols(false)); } });

		this.addCommand({ id: 'restart-php-navigation', name: 'Restart language navigation', callback: () => { void this.withView((view) => view.restartNavigation()); } });

		this.addSettingTab(new SourceObserverSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => { void this.explorerDock.update(); });
	}

	persistDocumentRecovery() {
		try { this.recovery?.write(this.documents.recoveries()); }
		catch { new Notice('Could not retain unsaved edits. Keep the source view open and save them before closing.'); }
	}
	onunload() { this.persistDocumentRecovery(); this.documents.stop(); this.observations.dispose(); this.search.dispose(); void this.languages.dispose().catch(error=>console.error('Source Observer language shutdown failed',error)); this.languageNotices.dispose(); this.repositories.dispose(); this.worktrees.dispose(); void this.explorerDock.dispose(); }

	async activateView() {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE);

		if (leaves.length > 0) {
			const leaf = leaves[0] as WorkspaceLeaf;
			await workspace.revealLeaf(leaf);
			await this.explorerDock.activate(leaf.view);
			return;
		}

		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		await workspace.revealLeaf(leaf);
		await this.explorerDock.activate(leaf.view);
	}

	private async withView(action: (view: SourceObserverView) => void) {
		await this.activateView();
		const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
		if (view instanceof SourceObserverView) action(view);
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<SourceObserverSettings>,
		);
		this.settings.searchMode = normalizeSearchMode(this.settings.searchMode);
		this.settings.shortcuts = normalizeShortcuts(this.settings.shortcuts);
		this.settings.replaceFileExplorer = this.settings.replaceFileExplorer === true;
		this.settings.excludedFiles = normalizeExcludedFiles(this.settings.excludedFiles);
		setExcludedFiles(this.settings.excludedFiles);
 this.search.setExcludedFiles(this.settings.excludedFiles);
	}

	async saveSettings() {
		// Cached filename indexes were built with the previous exclusions.
		setExcludedFiles(this.settings.excludedFiles);
 this.search.setExcludedFiles(this.settings.excludedFiles);
		await this.saveData(this.settings);
		this.settingsEvents.trigger('changed');
		await this.explorerDock.update();
	}
}
