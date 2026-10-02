import { Component, MarkdownRenderer, type App } from 'obsidian';
import type { Extension } from '@codemirror/state';
import { hoverTooltip, tooltips, type EditorView, type Tooltip } from '@codemirror/view';
import { LSPPlugin } from '@codemirror/lsp-client';
import { createHoverLifecycle, hoverContentsToMarkdown, hoverTooltipRect, hoverTooltipWidth, renderHoverContent, type HoverContents } from './hoverMarkdown';

interface Position { line: number; character: number }
interface HoverResult {
	contents: HoverContents;
	range?: { start: Position; end: Position };
}

/** Waits for Obsidian's Markdown renderer before CodeMirror measures the hover box. */
export function hoverTooltips(app: App): Extension {
	const placement = tooltips({
		tooltipSpace: (view) => hoverTooltipRect(view.dom.getBoundingClientRect()),
	});
	const hover = hoverTooltip(async (view: EditorView, pos: number): Promise<Tooltip | null> => {
		const plugin = LSPPlugin.get(view);
		if (!plugin) return null;

		const sourceDoc = view.state.doc;
		const sourceUri = plugin.uri;
		const positionLine = sourceDoc.lineAt(pos);
		plugin.client.sync();
		let result: HoverResult | null;
		try {
			result = await plugin.client.request<
				{ textDocument: { uri: string }; position: Position }, HoverResult | null
			>('textDocument/hover', {
				textDocument: { uri: sourceUri },
				position: { line: positionLine.number - 1, character: pos - positionLine.from },
			});
		} catch {
			return null;
		}
		if (!result || view.state.doc !== sourceDoc || plugin.uri !== sourceUri || LSPPlugin.get(view) !== plugin || !view.dom.isConnected) return null;

		const markdown = hoverContentsToMarkdown(result.contents);
		const dom = view.dom.ownerDocument.createElement('div');
		dom.className = 'cm-lsp-hover-tooltip cm-lsp-documentation';
		dom.style.setProperty('--so-hover-max-width', `${hoverTooltipWidth(view.dom.clientWidth)}px`);
		const component = new Component();
		try {
			await renderHoverContent(() => MarkdownRenderer.render(app, markdown, dom, '', component));
		} catch {
			dom.textContent = markdown;
		}
		if (view.state.doc !== sourceDoc || plugin.uri !== sourceUri || LSPPlugin.get(view) !== plugin || !view.dom.isConnected) {
			return null;
		}

		const lifecycle = createHoverLifecycle(component, dom);
		return {
			pos: result.range ? plugin.fromPosition(result.range.start) : pos,
			end: result.range ? plugin.fromPosition(result.range.end) : pos,
			above: true,
			create: () => lifecycle.create(),
		};
	}, { hideOn: (transaction) => transaction.docChanged });
	return [placement, hover];
}
