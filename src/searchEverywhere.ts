import * as path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { createFileMatcher } from './fileSearchMatching.ts';
import { searchFilePathIndex } from './filePathIndex.ts';
import { getRegisteredWorktrees, type SearchOptions } from './searchEngine.ts';
import { searchContentPage } from './contentSearchPage.ts';
import { containsFile, searchRoots } from './searchRoots.ts';
import type { LspSymbol } from './lspWorkspace';

export const SEARCH_TABS = ['all', 'files', 'classes', 'symbols', 'actions', 'text'] as const;
export type SearchTab = typeof SEARCH_TABS[number];
export const SEARCH_TAB_LABELS: Record<SearchTab, string> = {
	all: 'All', files: 'Files', classes: 'Classes', symbols: 'Symbols', actions: 'Actions', text: 'Text',
};
export interface SearchAction { id: string; name: string; run: () => void }
export interface EverywhereResult {
	id: string;
	category: Exclude<SearchTab, 'all'>;
	name: string;
	detail: string;
	filePath?: string;
	rootPath?: string;
	line?: number;
	column?: number;
	action?: SearchAction;
}
export interface EverywhereContext {
	root: string;
	roots?: string[];
	includeWorktrees: boolean;
	showHidden: boolean;
	recentFiles: string[];
	actions: SearchAction[];
	symbols?: (query: string, root: string) => Promise<LspSymbol[]>;
}
export interface EverywhereBatch {
	category: Exclude<SearchTab, 'all'>;
	results: EverywhereResult[];
	total?: number;
	fileCount?: number;
	truncated?: boolean;
	error?: string;
}

function fileResult(root: string, filePath: string): EverywhereResult {
	return { id: `file:${filePath}`, category: 'files', name: path.basename(filePath), detail: path.relative(root, filePath), filePath, rootPath: root };
}

export function flattenSymbols(symbols: LspSymbol[]): LspSymbol[] {
	return symbols.flatMap((symbol) => [symbol, ...flattenSymbols(symbol.children ?? [])]);
}

export function symbolResults(root: string, symbols: LspSymbol[], query: string, classesOnly: boolean): EverywhereResult[] {
	const match = createFileMatcher(query);
	const ranked: Array<{ result: EverywhereResult; score: number }> = [];
	const seen = new Set<string>();
	for (const symbol of flattenSymbols(symbols)) {
		// LSP kinds: Class, Interface, Enum and Struct (PHP traits may be Class).
		if (classesOnly && ![5, 10, 11, 23].includes(symbol.kind)) continue;
		const score = query.trim() ? match(symbol.name) : 0;
		if (score === null) continue;
		let filePath: string;
		try { filePath = fileURLToPath(symbol.uri); } catch { continue; }
		const pos = (symbol.selectionRange ?? symbol.range).start;
		const id = `symbol:${filePath}:${pos.line}:${pos.character}:${symbol.name}`;
		if (seen.has(id)) continue;
		seen.add(id);
		ranked.push({ score, result: {
			id, category: classesOnly ? 'classes' : 'symbols', name: symbol.name,
			detail: `${symbol.containerName ? `${symbol.containerName} · ` : ''}${path.relative(root, filePath)}:${pos.line + 1}`,
			filePath, rootPath: root, line: pos.line + 1, column: pos.character + 1,
		} });
	}
	return ranked.sort((a, b) => b.score - a.score || a.result.name.localeCompare(b.result.name)).map(({ result }) => result);
}

async function recentResults(context: EverywhereContext, worktrees: string[], signal: AbortSignal): Promise<EverywhereResult[]> {
	const files = await Promise.all([...new Set(context.recentFiles)].map(async (filePath) => {
		const relative = path.relative(context.root, filePath);
		const parts = relative.split(path.sep);
		if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
		// eslint-disable-next-line obsidianmd/hardcoded-config-path -- Match file index exclusions.
		if (parts.some((part) => ['.git', '.obsidian', 'node_modules'].includes(part))) return null;
		if (!context.showHidden && parts.some((part) => part.startsWith('.'))) return null;
		if (!context.includeWorktrees && (parts.some((part) => ['worktrees', '.worktrees'].includes(part))
			|| parts.join('/').includes('.claude/worktrees/')
			|| worktrees.some((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`)))) return null;
		try { return !signal.aborted && (await fs.stat(filePath)).isFile() ? fileResult(context.root, filePath) : null; }
		catch { return null; }
	}));
	return files.filter((file): file is EverywhereResult => file !== null).slice(0, 50);
}

/** Providers publish independently, so language-server indexing never delays filename results. */
export async function searchEverywhere(context: EverywhereContext, tab: SearchTab, query: string,
	options: Omit<SearchOptions, 'query'>, signal: AbortSignal, publish: (batch: EverywhereBatch) => void): Promise<void> {
	const tasks: Promise<void>[] = [];
	const roots = searchRoots(context.roots ?? [context.root]);
	const limit = Math.max(1, options.limit ?? 200);
	const scoped = async (search: (root: string) => Promise<Omit<EverywhereBatch, 'category'>>) => {
		const batches = await Promise.allSettled(roots.map(search));
		const results: EverywhereResult[] = [];
		const errors: string[] = [];
		let total = 0, fileCount = 0, truncated = false, exactTotal = true;
		batches.forEach((batch, index) => {
			if (batch.status === 'rejected') {
				errors.push(`${roots[index]}: ${batch.reason instanceof Error ? batch.reason.message : String(batch.reason)}`);
				return;
			}
			const value = batch.value;
			for (const result of value.results) results.push(roots.length > 1 && result.filePath
				? { ...result, detail: `${path.basename(roots[index]!)} / ${result.detail}` } : result);
			total += value.total ?? value.results.length;
			fileCount += value.fileCount ?? 0;
			truncated ||= !!value.truncated;
			exactTotal &&= value.total !== undefined || !value.truncated;
		});
		return { results, total: exactTotal ? total : undefined, fileCount, truncated, error: errors.join(' · ') || undefined };
	};
	const run = (category: EverywhereBatch['category'], search: () => Promise<Omit<EverywhereBatch, 'category'>>) => {
		tasks.push((async () => {
			try {
				const batch = await search();
				if (!signal.aborted) publish({ category, ...batch });
			} catch (error) {
				if (!signal.aborted) publish({ category, results: [], error: error instanceof Error ? error.message : String(error) });
			}
		})());
	};
	if (signal.aborted) return;
	if (tab === 'all' || tab === 'files') run('files', async () => {
		const batch = await scoped(async (root) => {
			const worktreeRoots = await getRegisteredWorktrees(root);
			if (!query.trim() && tab === 'all') return { results: await recentResults({ ...context, root }, worktreeRoots, signal) };
			const result = await searchFilePathIndex(root, query, {
				...options, includeWorktrees: context.includeWorktrees, showHidden: context.showHidden,
				worktreeRoots, matchMode: 'fuzzy', limit, signal,
			});
			return { results: result.files.map((file) => fileResult(root, file)), total: result.total, truncated: result.truncated };
		});
		const match = createFileMatcher(query);
		if (query.trim()) batch.results.sort((a, b) => (match(path.relative(b.rootPath!, b.filePath!)) ?? 0)
			- (match(path.relative(a.rootPath!, a.filePath!)) ?? 0) || a.detail.localeCompare(b.detail));
		return { ...batch, results: batch.results.slice(0, limit), truncated: batch.truncated || batch.results.length > limit };
	});
	if (tab === 'actions' || (tab === 'all' && query.trim())) run('actions', async () => {
		const match = createFileMatcher(query);
		return { results: context.actions.map((action) => ({ action, score: query.trim() ? match(action.name) : 0 }))
			.filter((item) => item.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
			.map(({ action }) => ({ id: `action:${action.id}`, category: 'actions', name: action.name, detail: 'Source Observer action', action })) };
	});
	if (context.symbols && (tab === 'classes' || tab === 'symbols' || (tab === 'all' && query.trim()))) {
		run(tab === 'classes' ? 'classes' : 'symbols', async () => {
			const batch = await scoped(async (root) => {
				const symbols = await context.symbols!(query, root);
				const results = symbolResults(root, symbols, query, tab === 'classes').filter((result) => {
					const relative = path.relative(root, result.filePath!);
					return containsFile(root, result.filePath!) && (context.showHidden || !relative.split(path.sep).some((part) => part.startsWith('.')));
				});
				return { results, total: results.length };
			});
			const match = createFileMatcher(query);
			batch.results.sort((a, b) => (match(b.name) ?? 0) - (match(a.name) ?? 0) || a.detail.localeCompare(b.detail));
			return { ...batch, results: batch.results.slice(0, limit), truncated: batch.results.length > limit };
		});
	}
	if (query.length && (tab === 'all' || tab === 'text')) run('text', async () => {
		const batch = await scoped(async (root) => {
			const page = await searchContentPage(root, { ...options, query, includeWorktrees: context.includeWorktrees, showHidden: context.showHidden }, signal, limit);
			const results = page.matches.map((match): EverywhereResult => ({
				id: `text:${match.filePath}:${match.line}:${match.column}`, category: 'text',
				name: match.text, detail: `${path.relative(root, match.filePath)}:${match.line}:${match.column}`,
				filePath: match.filePath, rootPath: root, line: match.line, column: match.column,
			}));
			return { results, total: page.totalMatches, fileCount: page.totalFiles };
		});
		return { ...batch, results: batch.results.slice(0, limit), truncated: (batch.total ?? 0) > limit };
	});
	await Promise.all(tasks);
}
