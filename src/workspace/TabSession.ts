import { containsFile } from '../files/index.ts';

export interface SourceTab { filePath: string; kind: 'code' | 'diff' }
export interface EditorTabsState { tabs: SourceTab[]; active: SourceTab | null }
export type TabCloseScope = 'others' | 'left' | 'right';

function cloneTab(tab: SourceTab): SourceTab {
	return { filePath: tab.filePath, kind: tab.kind };
}

/** Returns a plain serializable copy suitable for saving per-folder tabs. */
export function cloneEditorTabsState(state: EditorTabsState | null): EditorTabsState {
	if (!state) return { tabs: [], active: null };
	return { tabs: state.tabs.map(cloneTab), active: state.active ? cloneTab(state.active) : null };
}


/** Owns tab order/selection; rendering and close approval are adapters. */
export class TabSession {
	tabs: SourceTab[] = [];
	active = '';
	private onSelect: (tab: SourceTab) => void;
	private onEmpty: () => void;
	constructor(onSelect: (tab: SourceTab) => void = () => { }, onEmpty: () => void = () => { }) { this.onSelect = onSelect; this.onEmpty = onEmpty; }
	setHandlers(onSelect: (tab: SourceTab) => void, onEmpty: () => void) { this.onSelect = onSelect; this.onEmpty = onEmpty; }
	private key(tab: SourceTab) { return `${tab.kind}:${tab.filePath}`; }
	show(tab: SourceTab) {
		if (!this.tabs.some((entry) => this.key(entry) === this.key(tab))) this.tabs.push(tab);
		this.active = this.key(tab);
	}
	getActive(): SourceTab | null {
		const active = this.tabs.find((entry) => this.key(entry) === this.active);
		return active ? cloneTab(active) : null;
	}
	captureState(): EditorTabsState {
		return cloneEditorTabsState({ tabs: this.tabs, active: this.getActive() });
	}
	restoreState(state: EditorTabsState | null): void {
		const cloned = cloneEditorTabsState(state);
		this.tabs = cloned.tabs;
		const active = cloned.active;
		this.active = active && this.tabs.some((tab) => this.key(tab) === this.key(active))
			? this.key(active)
			: '';

	}
	closeActive() { const tab = this.tabs.find((entry) => this.key(entry) === this.active); if (tab) this.close(tab); }
	/** Remove code and diff tabs of a deleted file or folder, without selecting another deleted tab. */
	closeFile(deletedPath: string) {
		const active = this.getActive();
		const index = this.tabs.findIndex((tab) => this.key(tab) === this.active);
		this.tabs = this.tabs.filter((tab) => !containsFile(deletedPath, tab.filePath));
		if (active && containsFile(deletedPath, active.filePath)) {
			const next = this.tabs[Math.min(index, this.tabs.length - 1)];
			this.active = next ? this.key(next) : '';
			if (next) this.onSelect(next); else this.onEmpty();
		}

	}
	reset() { this.tabs = []; this.active = ''; }
	/** Whether closing other, left or right tabs around `tab` would close anything. */
	canCloseRelative(tab: SourceTab, scope: TabCloseScope) { return this.relatedTabs(tab, scope).length > 0; }
	closesActive(tab: SourceTab, scope: TabCloseScope) { return this.relatedTabs(tab, scope).some(entry => this.key(entry) === this.active); }
	/** Closes tabs around `tab`; it becomes active when the active tab is among them. */
	closeRelative(tab: SourceTab, scope: TabCloseScope) {
		const closing = new Set(this.relatedTabs(tab, scope).map((entry) => this.key(entry)));
		if (!closing.size) return;
		this.tabs = this.tabs.filter((entry) => !closing.has(this.key(entry)));
		if (closing.has(this.active)) { this.active = this.key(tab); this.onSelect(cloneTab(tab)); }

	}
	private relatedTabs(tab: SourceTab, scope: TabCloseScope) {
		const index = this.tabs.findIndex((entry) => this.key(entry) === this.key(tab));
		if (index < 0) return [];
		return this.tabs.filter((_, position) => scope === 'others' ? position !== index : scope === 'left' ? position < index : position > index);
	}
	close(tab: SourceTab) {
		const index = this.tabs.findIndex((entry) => this.key(entry) === this.key(tab));
		if (index < 0) return;
		this.tabs.splice(index, 1);
		if (this.active === this.key(tab)) {
			const next = this.tabs[Math.min(index, this.tabs.length - 1)];
			this.active = next ? this.key(next) : '';
			if (next) this.onSelect(next); else this.onEmpty();
		}

	}
}
