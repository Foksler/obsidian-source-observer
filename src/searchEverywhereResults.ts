import type { SearchOptions } from './searchEngine';
import * as path from 'path';
import { SEARCH_TABS, SEARCH_TAB_LABELS, type EverywhereBatch, type EverywhereResult } from './searchEverywhere';

/** A loaded page and an exact total are different things; expose both. */
export function batchSummary(batch: EverywhereBatch): string {
	const shown = batch.results.length;
	const count = batch.total === undefined ? `${shown}${batch.truncated ? '+' : ''}` : String(batch.total);
	const label = batch.category === 'text' ? `text matches${batch.fileCount === undefined ? '' : ` in ${batch.fileCount} files`}`
		: SEARCH_TAB_LABELS[batch.category].toLowerCase();
	return `${count} ${label}${batch.truncated ? ` (${shown} shown)` : ''}`;
}

export function searchHighlightRanges(text: string, query: string, options: Omit<SearchOptions, 'query'>): { from: number; to: number }[] {
	if (!query) return [];
	let matcher: RegExp;
	try {
		const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		matcher = new RegExp(source, `${options.caseSensitive ? '' : 'i'}g`);
	} catch { return []; }
	const ranges: { from: number; to: number }[] = [];
	let match: RegExpExecArray | null;
	while ((match = matcher.exec(text)) !== null) {
		if (!match[0].length) { matcher.lastIndex++; continue; }
		if (options.wholeWord && (/[\p{L}\p{N}_]/u.test(text[match.index - 1] ?? '')
			|| /[\p{L}\p{N}_]/u.test(text[match.index + match[0].length] ?? ''))) continue;
		ranges.push({ from: match.index, to: match.index + match[0].length });
	}
	return ranges;
}

export function highlightSearchText(target: HTMLElement, text: string, query: string, options: Omit<SearchOptions, 'query'>) {
	let cursor = 0;
	for (const { from, to } of searchHighlightRanges(text, query, options)) {
		if (from > cursor) target.appendText(text.slice(cursor, from));
		target.createEl('mark', { cls: 'so-search-highlight', text: text.slice(from, to) });
		cursor = to;
	}
	if (!cursor) target.setText(text);
	else if (cursor < text.length) target.appendText(text.slice(cursor));
}

/** Compact, single-line rows share one list above the source preview. */
export function renderEverywhereResults(parent: HTMLElement, batches: Map<string, EverywhereBatch>, results: EverywhereResult[],
	selected: number, query: string, options: Omit<SearchOptions, 'query'>, setIcon: (element: HTMLElement, name: string) => void) {
	parent.empty();
	const pane = parent.createDiv({ cls: 'so-everywhere-pane' });
	let index = 0;
	for (const category of SEARCH_TABS) {
		if (category === 'all') continue;
		const batch = batches.get(category);
		if (!batch) continue;
		for (const result of batch.results) {
			const row = pane.createDiv({ cls: 'so-everywhere-result', attr: {
				id: `so-everywhere-result-${index}`, role: 'option', 'aria-selected': String(index === selected),
			} });
			row.dataset.index = String(index++);
			row.dataset.category = result.category;
			const title = row.createDiv({ cls: 'so-everywhere-result-title' });
			const icon = title.createSpan({ cls: 'so-everywhere-category', attr: { 'aria-hidden': 'true' } });
			if (result.category === 'classes') icon.setText('C');
			else setIcon(icon, result.category === 'files' ? 'file-code' : result.category === 'symbols' ? 'braces' : result.category === 'actions' ? 'zap' : 'text-search');
			highlightSearchText(title.createSpan(), result.name, query, result.category === 'text' ? options : {});
			const detail = result.filePath && result.rootPath
				? `${path.basename(result.rootPath)}/${path.relative(result.rootPath, result.filePath)}${result.line ? ` ${result.line}` : ''}` : result.detail;
			row.createDiv({ cls: 'so-everywhere-detail', text: detail, attr: { title: result.detail } });
		}
		if (batch.error) pane.createDiv({ cls: 'so-search-status', text: batch.error });
		if (batch.truncated) {
			const more = pane.createEl('button', { cls: 'so-everywhere-more', text: `Load more ${SEARCH_TAB_LABELS[category].toLowerCase()}`,
				attr: { type: 'button' } });
			more.dataset.more = category;
		}
	}
	if (!results.length) pane.createDiv({ cls: 'so-search-status', text: 'No results yet.' });
}
