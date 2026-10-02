import { Events, Plugin, WorkspaceLeaf } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	SourceObserverSettings,
	SourceObserverSettingTab,
} from './settings';
import { SourceObserverView, VIEW_TYPE } from './view';

/** Root plugin class — registers the view, ribbon icon, command, and settings tab. */
export default class SourceObserverPlugin extends Plugin {
	settings!: SourceObserverSettings;
	/** Fires 'changed' after settings are persisted so open views can re-render. */
	settingsEvents = new Events();

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE, (leaf) => new SourceObserverView(leaf, this));

		this.addRibbonIcon('code-2', 'Source observer', () => { void this.activateView(); });

		this.addCommand({
			id: 'open',
			name: 'Open',
			callback: () => { void this.activateView(); },
		});

		this.addCommand({ id: 'search-in-files', name: 'Search in files', callback: () => { void this.withView((view) => view.focusSearch('content')); } });
		this.addCommand({ id: 'quick-open', name: 'Quick open file', callback: () => { void this.withView((view) => view.openFiles()); } });
		this.addCommand({ id: 'document-symbols', name: 'Go to symbol in file', callback: () => { void this.withView((view) => view.openSymbols(true)); } });
		this.addCommand({ id: 'workspace-symbols', name: 'Go to symbol in workspace', callback: () => { void this.withView((view) => view.openSymbols(false)); } });

		this.addCommand({ id: 'restart-php-navigation', name: 'Restart language navigation', callback: () => { void this.withView((view) => view.restartNavigation()); } });

		this.addSettingTab(new SourceObserverSettingTab(this.app, this));
	}

	onunload() {}

	/** Opens the Source Observer tab, reusing an existing leaf if one is already open. */
	async activateView() {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE);

		if (leaves.length > 0) {
			void workspace.revealLeaf(leaves[0] as WorkspaceLeaf);
			return;
		}

		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		void workspace.revealLeaf(leaf);
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
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.settingsEvents.trigger('changed');
	}
}
