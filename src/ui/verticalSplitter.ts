import type { Component } from 'obsidian';

interface SplitterOptions {
	label?: string;
	sizeProperty?: string;
	fromBottom?: boolean;
	initial?: number;
	minLast?: number;
	minRatio?: number;
	maxRatio?: number;
}

/** Resize adjacent panes while keeping both usable and release capture on unload. */
export function addVerticalSplitter(lifecycle: Component, body: HTMLElement, options: SplitterOptions = {}): HTMLElement {
	let ratio = options.initial ?? 42;
	const minRatio = options.minRatio ?? 15, maxRatio = options.maxRatio ?? 80;
	const handle = body.createDiv({ cls: 'so-search-preview-splitter', attr: {
		role: 'separator', tabindex: '0', 'aria-label': options.label ?? 'Resize source preview', 'aria-orientation': 'horizontal',
		'aria-valuemin': String(minRatio), 'aria-valuemax': String(maxRatio), 'aria-valuenow': String(ratio),
	} });
	let pointer: number | null = null;
	const resize = (value: number) => {
		const height = body.getBoundingClientRect().height;
		const first = 80, last = options.minLast ?? 150;
		const min = Math.max(minRatio, (options.fromBottom ? last : first) / Math.max(height, 1) * 100);
		const max = Math.min(maxRatio, 100 - ((options.fromBottom ? first : last) + 8) / Math.max(height, 1) * 100);
		ratio = Math.max(min, Math.min(Math.max(min, max), value));
		body.setCssProps({ [options.sizeProperty ?? '--so-search-results-size']: `${ratio}%` });
		handle.setAttribute('aria-valuenow', String(Math.round(ratio)));
	};
	const release = () => {
		const captured = pointer;
		pointer = null;
		if (captured !== null && handle.hasPointerCapture(captured)) handle.releasePointerCapture(captured);
	};
	lifecycle.registerDomEvent(handle, 'pointerdown', (event) => {
		if (event.button !== 0 || !(event.buttons & 1)) return;
		release();
		handle.focus({ preventScroll: true });
		event.preventDefault(); pointer = event.pointerId; handle.setPointerCapture(pointer);
	});
	lifecycle.registerDomEvent(handle, 'pointermove', (event) => {
		if (pointer !== event.pointerId) return;
		// A release outside the window can arrive without pointerup (Electron/macOS).
		if (!(event.buttons & 1)) { release(); return; }
		const rect = body.getBoundingClientRect();
		const position = (event.clientY - rect.top) / Math.max(rect.height, 1) * 100;
		resize(options.fromBottom ? 100 - position : position);
	});
	const finish = (event: PointerEvent) => { if (pointer === event.pointerId) release(); };
	lifecycle.registerDomEvent(handle.ownerDocument, 'pointerup', finish, { capture: true });
	lifecycle.registerDomEvent(handle.ownerDocument, 'pointercancel', finish, { capture: true });
	const win = handle.ownerDocument.defaultView;
	if (win) lifecycle.registerDomEvent(win, 'blur', release);
	lifecycle.registerDomEvent(handle, 'lostpointercapture', () => { pointer = null; });
	lifecycle.registerDomEvent(handle, 'keydown', (event) => {
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		event.preventDefault(); event.stopPropagation();
		resize(ratio);
		resize(ratio + (event.key === 'ArrowUp' ? -5 : 5) * (options.fromBottom ? -1 : 1));
	});
	lifecycle.register(release);
	return handle;
}
