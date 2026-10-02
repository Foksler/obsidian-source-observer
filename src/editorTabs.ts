import * as path from 'path';
import { setIcon } from 'obsidian';

export interface SourceTab { filePath: string; kind: 'code' | 'diff' }

/** File tabs stay separate from the editor so LSP jumps use the same tab strip. */
export class EditorTabs {
	private tabs: SourceTab[] = [];
	private active = '';
	constructor(private container: HTMLElement, private onSelect: (tab: SourceTab) => void,
		private onEmpty: () => void) {
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
	closeActive() { const tab = this.tabs.find((entry) => this.key(entry) === this.active); if (tab) this.close(tab); }
	reset() { this.tabs = []; this.active = ''; this.render(); }
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
			const close = wrapper.createEl('button', { cls: 'so-tab-close', attr: { 'aria-label': `Close ${path.basename(tab.filePath)}` } });
			setIcon(close, 'x'); close.addEventListener('click', () => this.close(tab));
		}
	}
}
