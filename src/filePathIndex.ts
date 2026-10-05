import { realpathSync } from 'fs';
import * as path from 'path';
import { createFileMatcher } from './fileSearchMatching.ts';
import { collectFilePaths, inventoryFilePaths } from './fileInventory.ts';
import { globToRegExp, splitGlobs } from './searchGlobs.ts';

const INDEX_TTL_MS = 5_000;
const MAX_INDEXED_FILES = 250_000;
const MAX_CACHED_INDEXES = 4;
export const FILE_SEARCH_RESULTS_CAP = 500;

export interface FilePathSearchOptions {
	signal?: AbortSignal;
	includeWorktrees?: boolean;
	showHidden?: boolean;
	includeGlob?: string;
	excludeGlob?: string;
	limit?: number;
	worktreeRoots?: string[];
	matchMode?: 'substring' | 'fuzzy';
}

export interface FilePathSearchResult {
	files: string[];
	total?: number;
	truncated: boolean;
	indexedFiles: number;
	indexBuildMs: number;
}

interface IndexEntry {
	rootPath: string;
	includeWorktrees: boolean;
	files: string[];
	relativePaths: string[];
	foldedPaths: string[];
	hiddenPaths: boolean[];
	builtAt: number;
	buildDurationMs: number;
	pending: Promise<void> | null;
	controller: AbortController | null;
	disposed: boolean;
	version: number;
	indexedVersion: number;
	truncated: boolean;
}

const indexes = new Map<string, IndexEntry>();
const canonicalPaths = new Map<string, string>();

function cacheKey(root: string, includeWorktrees: boolean): string {
	return `${canonicalPath(root)}\0${includeWorktrees ? 'with-worktrees' : 'without-worktrees'}`;
}

function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	const cached = canonicalPaths.get(resolved);
	if (cached) return cached;
	let canonical = resolved;
	try { canonical = realpathSync(resolved); } catch { /* Keep the resolved path if it no longer exists. */ }
	canonicalPaths.set(resolved, canonical);
	return canonical;
}

function indexFor(root: string, includeWorktrees: boolean): IndexEntry {
	const key = cacheKey(root, includeWorktrees);
	let entry = indexes.get(key);
	if (!entry) {
		entry = {
			rootPath: path.resolve(root),
			includeWorktrees,
			files: [],
			relativePaths: [],
			foldedPaths: [],
			hiddenPaths: [],
			builtAt: 0,
			buildDurationMs: 0,
			pending: null,
			controller: null,
			disposed: false,
			version: 0,
			indexedVersion: -1,
			truncated: false,
		};
	} else {
		indexes.delete(key);
	}
	indexes.set(key, entry);
	while (indexes.size > MAX_CACHED_INDEXES) {
		const oldest = indexes.keys().next().value;
		if (!oldest || oldest === key) break;
		indexes.delete(oldest);
	}
	return entry;
}

function startIndexBuild(entry: IndexEntry, worktreeRoots: string[]): Promise<void> {
	if (entry.pending) return entry.pending;
	const version = entry.version;
	const controller = new AbortController();
	entry.controller = controller;
	const started = performance.now();
	const build = (async () => {
		const { paths, truncated } = await collectFilePaths(entry.rootPath, entry.includeWorktrees, worktreeRoots,
			controller.signal, MAX_INDEXED_FILES);
		if (entry.version !== version) return;
		if (path.sep === '/') paths.sort();
		else paths.sort((a, b) => {
			const left = a.split('/').join(path.sep), right = b.split('/').join(path.sep);
			return left < right ? -1 : left > right ? 1 : 0;
		});
		const files = new Array<string>(paths.length);
		const folded = new Array<string>(paths.length);
		const hidden = new Array<boolean>(paths.length);
		const rootPrefix = entry.rootPath.endsWith(path.sep) ? entry.rootPath : `${entry.rootPath}${path.sep}`;
		for (let index = 0; index < paths.length; index++) {
			const relative = paths[index]!;
			files[index] = rootPrefix + (path.sep === '/' ? relative : relative.split('/').join(path.sep));
			folded[index] = relative.toLowerCase();
			hidden[index] = relative.startsWith('.') || relative.includes('/.');
		}
		entry.files = files;
		entry.relativePaths = paths;
		entry.foldedPaths = folded;
		entry.hiddenPaths = hidden;
		entry.builtAt = Date.now();
		entry.buildDurationMs = performance.now() - started;
		entry.indexedVersion = version;
		entry.truncated = truncated;
	})();
	entry.pending = build;
	void build.then(
		() => { if (entry.pending === build) { entry.pending = null; entry.controller = null; } },
		() => { if (entry.pending === build) { entry.pending = null; entry.controller = null; } },
	);
	return build;
}

async function ensureIndexed(entry: IndexEntry, worktreeRoots: string[]): Promise<void> {
	if (entry.disposed) throw new Error('Search cancelled');
	if (entry.builtAt > 0 && entry.indexedVersion === entry.version) {
		if (Date.now() - entry.builtAt < INDEX_TTL_MS) return;
		// Keep filename queries responsive when the TTL expires; refresh the inventory in the background.
		void startIndexBuild(entry, worktreeRoots).catch(() => { entry.pending = null; });
		return;
	}
	if (entry.pending) {
		await entry.pending;
		return ensureIndexed(entry, worktreeRoots);
	}
	await startIndexBuild(entry, worktreeRoots);
	if (entry.indexedVersion !== entry.version) return ensureIndexed(entry, worktreeRoots);
}

async function waitForIndex(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) return pending;
	await new Promise<void>((resolve, reject) => {
		const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Search cancelled')); };
		const finish = () => signal.removeEventListener('abort', abort);
		signal.addEventListener('abort', abort, { once: true });
		void pending.then(() => { finish(); resolve(); }, (error: unknown) => {
			finish(); reject(error instanceof Error ? error : new Error(String(error)));
		});
		if (signal.aborted) abort();
	});
}

export async function searchFilePathIndex(
	root: string,
	query: string,
	options: FilePathSearchOptions = {},
): Promise<FilePathSearchResult> {
	if (options.signal?.aborted) throw new Error('Search cancelled');
	const includeWorktrees = options.includeWorktrees ?? false;
	const entry = indexFor(root, includeWorktrees);
	await waitForIndex(ensureIndexed(entry, options.worktreeRoots ?? []), options.signal);
	if (options.signal?.aborted) throw new Error('Search cancelled');
	const needle = query.toLowerCase();
	const fuzzy = options.matchMode === 'fuzzy';
	const hasQuery = query.trim().length > 0;
	const match = fuzzy ? createFileMatcher(query) : null;
	const includes = splitGlobs(options.includeGlob).map((glob) => globToRegExp(glob, 'i'));
	const excludes = splitGlobs(options.excludeGlob).map((glob) => globToRegExp(glob, 'i'));
	const limit = options.limit ?? FILE_SEARCH_RESULTS_CAP;
	const found: string[] = [];
	const ranked: Array<{ filePath: string; score: number }> = [];
	const compare = (a: { filePath: string; score: number }, b: { filePath: string; score: number }) =>
		b.score - a.score || (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0);
	const rank = (filePath: string, score: number) => {
		ranked.push({ filePath, score });
		if (ranked.length >= Math.max(2, limit * 2)) { ranked.sort(compare); ranked.length = limit; }
	};
	let total = 0;
	if (entry.truncated) {
		// Keep the shared index bounded, but search the full inventory when it overflowed.
		await inventoryFilePaths(root, includeWorktrees, options.worktreeRoots ?? [], options.signal ?? new AbortController().signal,
			(filePath, relative) => {
				if (options.showHidden === false && /(?:^|\/)\./.test(relative)) return;
				if (includes.length && !includes.some((glob) => glob.test(relative))) return;
				if (excludes.some((glob) => glob.test(relative))) return;
				const score = fuzzy ? (hasQuery ? match!(relative) : 0) : (needle && relative.toLowerCase().includes(needle) ? 0 : null);
				if (score === null) return;
				total++;
				rank(filePath, score);
			});
		ranked.sort(compare);
		return { files: ranked.slice(0, limit).map((item) => item.filePath), total, truncated: total > limit,
			indexedFiles: entry.files.length, indexBuildMs: entry.buildDurationMs };
	}
	const showHidden = options.showHidden !== false;
	const folded = entry.foldedPaths;
	for (let index = 0; index < entry.files.length; index++) {
		if (!fuzzy && (!needle || !folded[index]!.includes(needle))) continue;
		if (!showHidden && entry.hiddenPaths[index]) continue;
		const relative = entry.relativePaths[index]!;
		if (includes.length && !includes.some((glob) => glob.test(relative))) continue;
		if (excludes.length && excludes.some((glob) => glob.test(relative))) continue;
		if (fuzzy) {
			const score = hasQuery ? match!(relative, folded[index]) : 0;
			if (score !== null) {
				total++;
				if (hasQuery) rank(entry.files[index]!, score);
				else if (found.length < limit) found.push(entry.files[index]!);
			}
			continue;
		}
		found.push(entry.files[index]!);
		if (found.length > limit) break;
	}
	if (fuzzy && hasQuery) {
		ranked.sort(compare);
		found.push(...ranked.slice(0, limit).map((item) => item.filePath));
	}
	return {
		files: found.slice(0, limit),
		total: fuzzy ? total : found.length <= limit ? found.length : undefined,
		truncated: fuzzy ? total > limit : found.length > limit,
		indexedFiles: entry.files.length,
		indexBuildMs: entry.buildDurationMs,
	};
}

export async function warmFileIndex(root: string, includeWorktrees = false, worktreeRoots: string[] = []): Promise<void> {
	const entry = indexFor(root, includeWorktrees);
	await ensureIndexed(entry, worktreeRoots);
}

export function invalidateFilePathIndex(root: string): void {
	const resolved = canonicalPath(root);
	for (const entry of indexes.values()) {
		if (canonicalPath(entry.rootPath) !== resolved) continue;
		entry.version++;
		entry.builtAt = 0;
	}
}

export const invalidateFileIndex = invalidateFilePathIndex;

export function clearFilePathIndexes(): void {
	for (const entry of indexes.values()) {
		entry.disposed = true;
		entry.version++;
		entry.controller?.abort();
	}
	indexes.clear();
	canonicalPaths.clear();
}

export function getFilePathIndexStats(root: string, includeWorktrees = false): { indexedFiles: number; ageMs: number } {
	const entry = indexes.get(cacheKey(root, includeWorktrees));
	return {
		indexedFiles: entry?.files.length ?? 0,
		ageMs: entry?.builtAt ? Math.max(0, Date.now() - entry.builtAt) : Infinity,
	};
}
