import { ItemView, Notice, type App, type View, type ViewState, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';

export const EXPLORER_VIEW_TYPE = 'source-observer-explorer';

export interface ExplorerOwner {
	view: ItemView;
	sidebar: HTMLElement;
	home: HTMLElement;
	isClosed: () => boolean;
}

/** Hosts the existing tree; the editor view continues to own its state and listeners. */
export class SourceExplorerView extends ItemView {
	owner?: ExplorerOwner;
	previousState: ViewState = { type: 'file-explorer', active: true };

	constructor(leaf: WorkspaceLeaf, private openSource: () => void) { super(leaf); }
	getViewType() { return EXPLORER_VIEW_TYPE; }
	getDisplayText() { return 'Source files'; }
	getIcon() { return 'folder-code'; }
	getState() { return { previousState: this.previousState }; }
	async setState(state: { previousState?: ViewState }, result: ViewStateResult) {
		if (state?.previousState?.type === 'file-explorer') this.previousState = state.previousState;
		await super.setState(state, result);
	}
	async onOpen() {
		this.contentEl.addClass('so-root');
		this.contentEl.addClass('so-explorer-host');
		const button = this.contentEl.createEl('button', { text: 'Open source observer' });
		this.registerDomEvent(button, 'click', this.openSource);
	}
	mount(owner: ExplorerOwner) {
		if (this.owner !== owner) { this.unmount(); this.contentEl.empty(); }
		this.owner = owner;
		this.scope = owner.view.scope;
		this.contentEl.toggleClass('so-cursor-theme', owner.home.hasClass('so-cursor-theme'));
		owner.sidebar.addClass('so-sidebar-docked');
		this.contentEl.appendChild(owner.sidebar);
	}
	unmount() {
		if (!this.owner) return;
		const { sidebar, home } = this.owner;
		sidebar.removeClass('so-sidebar-docked');
		home.insertBefore(sidebar, home.firstChild);
		this.owner = undefined;
		this.scope = null;
	}
	async onClose() { this.unmount(); }
}

/** Replaces only the native Files leaf and restores it when this mode is released. */
export class ExplorerDock {
	private owner?: ExplorerOwner;
	private queue = Promise.resolve();
	private disposed = false;
	private sourceActive = false;

	constructor(private app: App, private enabled: () => boolean) {}
	attach(owner: ExplorerOwner) {
		this.owner = owner;
		this.sourceActive = this.app.workspace.getActiveViewOfType(ItemView) === owner.view;
		return this.update();
	}
	/** Sidebar focus keeps the last main-tab context; note tabs restore native Files. */
	setActiveLeaf(leaf: WorkspaceLeaf | null) {
		if (!leaf) return Promise.resolve();
		const workspace = this.app.workspace;
		if (leaf.view === this.owner?.view) this.sourceActive = true;
		else if (leaf.getRoot() === workspace.leftSplit || leaf.getRoot() === workspace.rightSplit) return Promise.resolve();
		else this.sourceActive = false;
		return this.update();
	}
	activate(view: View) {
		if (this.owner?.view === view) this.sourceActive = true;
		return this.update();
	}
	detach(view: ItemView) {
		if (this.owner?.view !== view) return Promise.resolve();
		this.owner = undefined;
		this.queue = this.queue.then(() => this.restore()).catch(() => { new Notice('Could not restore the file explorer.'); });
		return this.queue;
	}
	isActive(view: ItemView) {
		return this.app.workspace.getActiveViewOfType(SourceExplorerView)?.owner?.view === view;
	}
	isDocked(view: ItemView) {
		return this.hosts().some((host) => host.owner?.view === view);
	}
	update() {
		this.queue = this.queue.then(() => this.apply()).catch(() => { new Notice('Could not change the source files location.'); });
		return this.queue;
	}
	dispose() {
		this.disposed = true;
		this.owner = undefined;
		// Start restoration before Obsidian unregisters the plugin's view types.
		return this.restore();
	}
	private hosts() {
		return this.app.workspace.getLeavesOfType(EXPLORER_VIEW_TYPE)
			.map((leaf) => leaf.view).filter((view): view is SourceExplorerView => view instanceof SourceExplorerView);
	}
	private async restore() {
		for (const host of this.hosts()) {
			host.unmount();
			await host.leaf.setViewState({ ...host.previousState, active: false });
		}
	}
	private async apply() {
		const owner = this.owner, workspace = this.app.workspace;
		if (this.disposed || !this.enabled() || !this.sourceActive) { await this.restore(); return; }
		// A restored sidebar may await opening its editor after Obsidian startup.
		if (!owner || owner.isClosed()) return;
		let host = this.hosts().find((view) => view.leaf.getRoot() === workspace.leftSplit);
		if (!host) {
			const files = workspace.getLeavesOfType('file-explorer').find((leaf) => leaf.getRoot() === workspace.leftSplit);
			const leaf = files ?? workspace.getLeftLeaf(false);
			if (!leaf) return;
			const previousState = files?.getViewState() ?? { type: 'file-explorer', active: true };
			await leaf.setViewState({ type: EXPLORER_VIEW_TYPE, active: false, state: { previousState } });
			if (!(leaf.view instanceof SourceExplorerView)) return;
			host = leaf.view;
		}
		if (owner !== this.owner || owner.isClosed() || this.disposed || !this.enabled() || !this.sourceActive) { await this.restore(); return; }
		const moved = host.owner !== owner || owner.sidebar.parentElement !== host.contentEl;
		host.mount(owner);
		if (moved) await workspace.revealLeaf(host.leaf);
	}
}
