import * as path from 'path';
import { setIcon } from 'obsidian';
import { containsFile } from './searchRoots';

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

/** File tabs stay separate from the editor so LSP jumps use the same tab strip. */
export class EditorTabs {
	private tabs: SourceTab[] = [];
	private active = '';
	constructor(private container: HTMLElement, private onSelect: (tab: SourceTab) => void,
		private onEmpty: () => void,
		private onContextMenu?: (tab: SourceTab, event: MouseEvent | KeyboardEvent, element: HTMLElement) => void) {
		container.addClass('so-tabs');
		container.setAttribute('role', 'tablist');
		container.setAttribute('aria-label', 'Open source files');
		container.addEventListener('keydown', (event) => {
			if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
			const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
			const current = buttons.indexOf(container.ownerDocument.activeElement as HTMLButtonElement);
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
				: (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
			event.preventDefault(); buttons[next]?.focus(); buttons[next]?.click();
		});
	}
	private key(tab: SourceTab) { return `${tab.kind}:${tab.filePath}`; }
	show(tab: SourceTab) {
		if (!this.tabs.some((entry) => this.key(entry) === this.key(tab))) this.tabs.push(tab);
		this.active = this.key(tab); this.render();
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
		this.render();
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
		this.render();
	}
	reset() { this.tabs = []; this.active = ''; this.render(); }
	/** Whether closing other, left or right tabs around `tab` would close anything. */
	canCloseRelative(tab: SourceTab, scope: TabCloseScope) { return this.relatedTabs(tab, scope).length > 0; }
	/** Closes tabs around `tab`; it becomes active when the active tab is among them. */
	closeRelative(tab: SourceTab, scope: TabCloseScope) {
		const closing = new Set(this.relatedTabs(tab, scope).map((entry) => this.key(entry)));
		if (!closing.size) return;
		this.tabs = this.tabs.filter((entry) => !closing.has(this.key(entry)));
		if (closing.has(this.active)) { this.active = this.key(tab); this.onSelect(cloneTab(tab)); }
		this.render();
	}
	private relatedTabs(tab: SourceTab, scope: TabCloseScope) {
		const index = this.tabs.findIndex((entry) => this.key(entry) === this.key(tab));
		if (index < 0) return [];
		return this.tabs.filter((_, position) => scope === 'others' ? position !== index : scope === 'left' ? position < index : position > index);
	}
	private close(tab: SourceTab) {
		const index = this.tabs.findIndex((entry) => this.key(entry) === this.key(tab));
		this.tabs.splice(index, 1);
		if (this.active === this.key(tab)) {
			const next = this.tabs[Math.min(index, this.tabs.length - 1)];
			this.active = next ? this.key(next) : '';
			if (next) this.onSelect(next); else this.onEmpty();
		}
		this.render();
	}
	private render() {
		this.container.empty();
		for (const tab of this.tabs) {
			const selected = this.key(tab) === this.active;
			const wrapper = this.container.createDiv({ cls: `so-tab${selected ? ' so-tab-active' : ''}` });
			const button = wrapper.createEl('button', { cls: 'so-tab-select', text: path.basename(tab.filePath) + (tab.kind === 'diff' ? ' (diff)' : ''),
				attr: { role: 'tab', 'aria-selected': String(selected), tabindex: selected ? '0' : '-1', title: tab.filePath } });
			button.addEventListener('click', () => this.onSelect(tab));
			// Same file actions as the tree; opening the menu does not switch tabs.
			wrapper.addEventListener('contextmenu', (event) => {
				if (!this.onContextMenu) return;
				event.preventDefault();
				this.onContextMenu(cloneTab(tab), event, wrapper);
			});
			button.addEventListener('keydown', (event) => {
				if (!this.onContextMenu || (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey))) return;
				event.preventDefault();
				event.stopPropagation();
				this.onContextMenu(cloneTab(tab), event, wrapper);
			});
			const close = wrapper.createEl('button', { cls: 'so-tab-close', attr: { 'aria-label': `Close ${path.basename(tab.filePath)}` } });
			setIcon(close, 'x'); close.addEventListener('click', () => this.close(tab));
		}
	}
}
