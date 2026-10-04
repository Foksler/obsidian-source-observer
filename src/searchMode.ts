import type { Component } from 'obsidian';

export type SearchMode = 'vscode' | 'phpstorm';

export function normalizeSearchMode(value: unknown): SearchMode {
	return value === 'phpstorm' ? 'phpstorm' : 'vscode';
}

/** Capture at the window before Obsidian and editor handlers can consume a tap. */
export function registerDoubleShiftSearch(owner: Pick<Component, 'registerDomEvent'>, root: HTMLElement,
	enabled: () => boolean, active: () => boolean, open: () => void,
	containsFocus: (target: Node) => boolean = (target) => root.contains(target)) {
	const document = root.ownerDocument;
	const gesture = new DoubleShiftGesture();
	const accepts = (event: KeyboardEvent) => {
		if (!enabled() || document.querySelector('.modal-container')) return false;
		const target = event.target as Node | null;
		// Focus inside the view is authoritative, even while Obsidian is updating
		// its active leaf after closing a picker or switching folder tabs.
		if (target !== null && containsFocus(target)) return true;
		return active() && (target === document || target === document.body || target === document.documentElement);
	};
	const keydown = (event: KeyboardEvent) => {
		if (accepts(event)) gesture.keydown(event); else gesture.reset();
	};
	const keyup = (event: KeyboardEvent) => {
		if (!accepts(event)) { gesture.reset(); return; }
		if (gesture.keyup(event, performance.now())) open();
	};
	if (document.defaultView) {
		owner.registerDomEvent(document.defaultView, 'keydown', keydown, true);
		owner.registerDomEvent(document.defaultView, 'keyup', keyup, true);
	} else {
		owner.registerDomEvent(document, 'keydown', keydown, true);
		owner.registerDomEvent(document, 'keyup', keyup, true);
	}
	// Switching windows must not leave a half-completed shortcut behind.
	if (document.defaultView) owner.registerDomEvent(document.defaultView, 'blur', () => gesture.reset());
}

/** Recognizes two plain Shift taps, excluding held keys and modified shortcuts. */
export class DoubleShiftGesture {
	private pressed = false;
	private lastTap: number | null = null;

	reset() { this.pressed = false; this.lastTap = null; }

	keydown(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey'>) {
		if (event.key !== 'Shift' || event.ctrlKey || event.metaKey || event.altKey || event.repeat) {
			this.reset();
			return;
		}
		this.pressed = true;
	}

	keyup(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>, now: number): boolean {
		if (event.key !== 'Shift' || !this.pressed || event.ctrlKey || event.metaKey || event.altKey) {
			this.reset();
			return false;
		}
		this.pressed = false;
		if (this.lastTap !== null && now - this.lastTap <= 400) {
			this.lastTap = null;
			return true;
		}
		this.lastTap = now;
		return false;
	}
}
