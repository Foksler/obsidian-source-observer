import * as path from 'path';
import { setIcon } from 'obsidian';

import { TabSession, type SourceTab, type EditorTabsState, type TabCloseScope } from '../workspace/index.ts';
export type { SourceTab, EditorTabsState, TabCloseScope } from '../workspace/index.ts';

/** File tabs stay separate from the editor so LSP jumps use the same tab strip. */
export class EditorTabs {
	private sessionState?: TabSession;
 private get session() { return this.sessionState ??= new TabSession(tab=>this.onSelect(tab),()=>this.onEmpty()); }
 private closeGuard?: ()=>Promise<boolean>;
 private mutation = 0;
 setCloseGuard(guard: ()=>Promise<boolean>) { this.closeGuard=guard; }
 setSession(session: TabSession) {this.sessionState=session; session.setHandlers(tab=>this.onSelect(tab),()=>this.onEmpty());}
 private requestClose(action: ()=>void, affectsActive: boolean) {
  if(!this.closeGuard || !affectsActive) {action(); this.mutation++; this.render(); return;}
  const request=this.mutation;
  void this.closeGuard().then(ready=>{if(ready && request===this.mutation) {action(); this.mutation++; this.render();}});
 }
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
 show(tab: SourceTab) { this.session.show(tab); this.mutation++; this.render(); }
 getActive() { return this.session.getActive(); }
 captureState(): EditorTabsState { return this.session.captureState(); }
 restoreState(state: EditorTabsState | null) { this.session.restoreState(state); this.mutation++; this.render(); }
 closeActive() { const active=this.getActive(); if(active) this.close(active); }
 closeFile(deletedPath: string) {this.session.closeFile(deletedPath); this.mutation++; this.render();}
 reset() {this.session.reset(); this.mutation++; this.render();}
 canCloseRelative(tab: SourceTab,scope:TabCloseScope) {return this.session.canCloseRelative(tab,scope);}
 closeRelative(tab:SourceTab,scope:TabCloseScope) {this.requestClose(()=>this.session.closeRelative(tab,scope),this.session.closesActive(tab,scope));}
 private close(tab:SourceTab) {this.requestClose(()=>this.session.close(tab),this.key(tab)===this.session.active);}
	private render() {
		this.container.empty();
		for (const tab of this.session.tabs) {
			const selected = this.key(tab) === this.session.active;
			const wrapper = this.container.createDiv({ cls: `so-tab${selected ? ' so-tab-active' : ''}` });
			const button = wrapper.createEl('button', { cls: 'so-tab-select', text: path.basename(tab.filePath) + (tab.kind === 'diff' ? ' (diff)' : ''),
				attr: { role: 'tab', 'aria-selected': String(selected), tabindex: selected ? '0' : '-1', title: tab.filePath } });
			button.addEventListener('click', () => this.onSelect(tab));
			// Same file actions as the tree; opening the menu does not switch tabs.
			wrapper.addEventListener('contextmenu', (event) => {
				if (!this.onContextMenu) return;
				event.preventDefault();
				this.onContextMenu({ filePath: tab.filePath, kind: tab.kind }, event, wrapper);
			});
			button.addEventListener('keydown', (event) => {
				if (!this.onContextMenu || (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey))) return;
				event.preventDefault();
				event.stopPropagation();
				this.onContextMenu({ filePath: tab.filePath, kind: tab.kind }, event, wrapper);
			});
			const close = wrapper.createEl('button', { cls: 'so-tab-close', attr: { 'aria-label': `Close ${path.basename(tab.filePath)}` } });
			setIcon(close, 'x'); close.addEventListener('click', () => this.close(tab));
		}
	}
}
