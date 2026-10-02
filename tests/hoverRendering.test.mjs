import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createHoverLifecycle, hoverContentsToMarkdown, hoverTooltipRect, hoverTooltipWidth, renderHoverContent } from '../src/hoverMarkdown.ts';

test('LSP hover markdown preserves markdown and turns legacy code strings into fenced snippets', () => {
	assert.equal(hoverContentsToMarkdown({ kind: 'markdown', value: '**app()** returns `string`' }), '**app()** returns `string`');
	assert.equal(hoverContentsToMarkdown({ kind: 'plaintext', value: 'A ``` fence\nwith details' }), '````\nA ``` fence\nwith details\n````');
	assert.equal(hoverContentsToMarkdown({ language: 'php\n<script>', value: 'function app(): void {}' }), '```phpscript\nfunction app(): void {}\n```');
	assert.equal(hoverContentsToMarkdown(['First paragraph', { language: 'php', value: 'return app();' }]), 'First paragraph\n\n```php\nreturn app();\n```');
});

test('hover content does not resolve until the async renderer settles', async () => {
	let finish;
	let completed = false;
	const rendered = renderHoverContent(() => new Promise((resolve) => { finish = resolve; }));
	void rendered.then(() => { completed = true; });
	await Promise.resolve();
	assert.equal(completed, false);
	finish('rendered');
	assert.equal(await rendered, 'rendered');
	assert.equal(completed, true);
});

test('a discarded async hover does not load component listeners', () => {
	let loads = 0;
	let unloads = 0;
	const component = { load: () => loads++, unload: () => unloads++ };
	createHoverLifecycle(component, {});

	assert.equal(loads, 0);
	assert.equal(unloads, 0);
});

test('mounted hover component loads once and unloads once on destroy', () => {
	let loads = 0;
	let unloads = 0;
	const component = { load: () => loads++, unload: () => unloads++ };
	const lifecycle = createHoverLifecycle(component, {});
	const tooltip = lifecycle.create();

	assert.equal(loads, 1);
	tooltip.destroy();
	tooltip.destroy();
	assert.equal(unloads, 1);
});

test('hover placement and width stay within a docked editor column', () => {
	assert.deepEqual(hoverTooltipRect({ left: 556, right: 1174, top: 30, bottom: 900 }), {
		left: 564,
		right: 1166,
		top: 30,
		bottom: 900,
	});
	assert.equal(hoverTooltipWidth(618), 602);
	assert.equal(hoverTooltipWidth(1200), 680);
	assert.equal(hoverTooltipWidth(12), 1);
});

test('hover tooltip has a bounded first-paint width and wraps code before measuring', async () => {
	const stylesheet = await readFile(path.resolve('styles.css'), 'utf8');
	const hoverRules = stylesheet.slice(stylesheet.indexOf('.so-root .cm-lsp-hover-tooltip'));
	assert.match(hoverRules, /width:\s*min\(680px, var\(--so-hover-max-width, calc\(100vw - 32px\)\)\)/);
	assert.match(hoverRules, /max-width:\s*var\(--so-hover-max-width, calc\(100vw - 32px\)\)/);
	assert.match(hoverRules, /max-height:\s*min\(50vh, 420px\)/);
	assert.match(hoverRules, /overflow-wrap:\s*anywhere/);
	assert.match(hoverRules, /white-space:\s*pre-wrap !important/);
	assert.doesNotMatch(hoverRules, /transition\s*:/);
});
