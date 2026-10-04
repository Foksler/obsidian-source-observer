import { promises as fsp, realpathSync } from 'fs';
import * as path from 'path';
import { runRipgrep } from './rgRunner.ts';
import { createFileMatcher } from './fileSearchMatching.ts';
import { inventoryFilePaths } from './fileInventory.ts';

const INDEX_TTL_MS = 5_000;
const MAX_INDEXED_FILES = 250_000;
const MAX_CACHED_INDEXES = 4;
export const FILE_SEARCH_RESULTS_CAP = 500;
// eslint-disable-next-line obsidianmd/hardcoded-config-path -- Search roots must omit their conventional vault metadata directory.
const ALWAYS_EXCLUDED_DIRS = new Set(['.git', '.obsidian', 'node_modules']);
const CONVENTIONAL_WORKTREE_PATHS = ['.claude/worktrees', '.worktrees', 'worktrees'];

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

function globToRegExp(glob: string): RegExp {
	const normalized = glob.replace(/\\/g, '/');
	let source = '^';
	for (let index = 0; index < normalized.length; index++) {
		const character = normalized[index] ?? '';
		if (character === '*') {
			if (normalized[index + 1] === '*' && normalized[index + 2] === '/') {
				source += '(?:.*/)?';
				index += 2;
			} else if (normalized[index + 1] === '*') {
				source += '.*';
				index++;
			} else source += '[^/]*';
		} else if (character === '?') source += '[^/]';
		else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
	}
	return new RegExp(`${source}$`, 'i');
}

function splitGlobs(value?: string): RegExp[] {
	return (value ?? '').split(/[\n,;]/).map((glob) => glob.trim()).filter(Boolean).map(globToRegExp);
}

function isConventionalWorktree(relativePath: string): boolean {
	const parts = relativePath.split(/[\\/]+/).filter(Boolean);
	return CONVENTIONAL_WORKTREE_PATHS.some((pattern) => {
		const expected = pattern.split('/');
		return parts.some((_, index) => expected.every((part, offset) => parts[index + offset] === part));
	});
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
	const started = performance.now();
	const build = (async () => {
		const indexed: Array<{ filePath: string; relativePath: string }> = [];
		const root = entry.rootPath;
		const canonicalRoot = canonicalPath(root);
		const worktrees = worktreeRoots.map((worktree) => {
			const canonicalWorktree = canonicalPath(worktree);
			const relative = path.relative(canonicalRoot, canonicalWorktree);
			return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
				? relative.split(path.sep).join('/')
				: null;
		}).filter((relative): relative is string => relative !== null && relative !== '');
		const addFallbackInventory = async (): Promise<void> => {
		let directories = [root];
		while (directories.length && entry.version === version && indexed.length < MAX_INDEXED_FILES) {
			const nextDirectories: string[] = [];
			for (let offset = 0; offset < directories.length; offset += 32) {
				const batch = directories.slice(offset, offset + 32);
				const children = await Promise.all(batch.map(async (dir) => {
					try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
				}));
				for (let index = 0; index < batch.length; index++) {
					const dir = batch[index];
					const entries = children[index];
					if (!dir || !entries) continue;
					for (const child of entries) {
						if (entry.version !== version || indexed.length >= MAX_INDEXED_FILES) return;
						const fullPath = path.join(dir, child.name);
						const relative = path.relative(root, fullPath).split(path.sep).join('/');
						if (child.isSymbolicLink()) continue;
						if (child.isDirectory()) {
							if (ALWAYS_EXCLUDED_DIRS.has(child.name)) continue;
							if (!entry.includeWorktrees && (isConventionalWorktree(relative) || worktrees.some((worktree) => relative === worktree || relative.startsWith(`${worktree}/`)))) continue;
							nextDirectories.push(fullPath);
						} else if (child.isFile()) {
							if (!entry.includeWorktrees && worktrees.some((worktree) => relative === worktree || relative.startsWith(`${worktree}/`))) continue;
							indexed.push({ filePath: fullPath, relativePath: relative });
						}
					}
				}
			}
			directories = nextDirectories;
		}
		};
		let indexedWithRg = false;
		let inventoryTruncated = false;
		try {
			const args = ['--files', '--hidden', '--no-ignore', '--null'];
			for (const excluded of ALWAYS_EXCLUDED_DIRS) {
				args.push('--glob', `!**/${excluded}`, '--glob', `!**/${excluded}/**`);
			}
			if (!entry.includeWorktrees) {
				for (const worktree of CONVENTIONAL_WORKTREE_PATHS) {
					args.push('--glob', `!**/${worktree}`, '--glob', `!**/${worktree}/**`);
				}
				for (const worktree of worktrees) args.push('--glob', `!${worktree}`, '--glob', `!${worktree}/**`);
			}
			args.push('--', root);
			const output = await runRipgrep(args, new AbortController().signal, 64 * 1024 * 1024);
			indexedWithRg = true;
			inventoryTruncated = output.truncated;
			const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
			for (const file of output.text.split('\0')) {
				if (indexed.length >= MAX_INDEXED_FILES) break;
				if (!file) continue;
				let filePath: string;
				let relativePath: string;
				if (file.startsWith(rootPrefix)) {
					filePath = file;
					relativePath = file.slice(rootPrefix.length);
					if (path.sep !== '/') relativePath = relativePath.split(path.sep).join('/');
				} else {
					filePath = path.resolve(root, file);
					relativePath = path.relative(root, filePath).split(path.sep).join('/');
					if (!relativePath || relativePath.startsWith('../') || path.isAbsolute(relativePath)) continue;
				}
				indexed.push({ filePath, relativePath });
			}
		} catch {
			// Fall back to bounded parallel directory reads when bundled/system ripgrep is unavailable.
		}
		if (!indexedWithRg) await addFallbackInventory();
		if (entry.version !== version) return;
		indexed.sort((left, right) => left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0);
		entry.files = indexed.map((item) => item.filePath);
		entry.relativePaths = indexed.map((item) => item.relativePath);
		entry.foldedPaths = indexed.map((item) => item.relativePath.toLowerCase());
		entry.hiddenPaths = indexed.map((item) => /(?:^|\/)\./.test(item.relativePath));
		entry.builtAt = Date.now();
		entry.buildDurationMs = performance.now() - started;
		entry.indexedVersion = version;
		entry.truncated = inventoryTruncated || indexed.length >= MAX_INDEXED_FILES;
	})();
	entry.pending = build;
	void build.then(
		() => { if (entry.pending === build) entry.pending = null; },
		() => { if (entry.pending === build) entry.pending = null; },
	);
	return build;
}

async function ensureIndexed(entry: IndexEntry, worktreeRoots: string[]): Promise<void> {
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

export async function searchFilePathIndex(
	root: string,
	query: string,
	options: FilePathSearchOptions = {},
): Promise<FilePathSearchResult> {
	const includeWorktrees = options.includeWorktrees ?? false;
	const entry = indexFor(root, includeWorktrees);
	await ensureIndexed(entry, options.worktreeRoots ?? []);
	const needle = query.toLowerCase();
	const fuzzy = options.matchMode === 'fuzzy';
	const hasQuery = query.trim().length > 0;
	const match = fuzzy ? createFileMatcher(query) : null;
	const includes = splitGlobs(options.includeGlob);
	const excludes = splitGlobs(options.excludeGlob);
	const limit = options.limit ?? FILE_SEARCH_RESULTS_CAP;
	const found: string[] = [];
	const ranked: Array<{ filePath: string; score: number }> = [];
	if (entry.truncated) {
		// Keep the shared index bounded, but search the full inventory when it overflowed.
		let total = 0;
		const compare = (a: { filePath: string; score: number }, b: { filePath: string; score: number }) =>
			b.score - a.score || (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0);
		await inventoryFilePaths(root, includeWorktrees, options.worktreeRoots ?? [], options.signal ?? new AbortController().signal,
			(filePath, relative) => {
				if (options.showHidden === false && /(?:^|\/)\./.test(relative)) return;
				if (includes.length && !includes.some((glob) => glob.test(relative))) return;
				if (excludes.some((glob) => glob.test(relative))) return;
				const score = fuzzy ? (hasQuery ? match!(relative) : 0) : (needle && relative.toLowerCase().includes(needle) ? 0 : null);
				if (score === null) return;
				total++;
				ranked.push({ filePath, score });
				if (ranked.length >= Math.max(2, limit * 2)) { ranked.sort(compare); ranked.length = limit; }
			});
		ranked.sort(compare);
		return { files: ranked.slice(0, limit).map((item) => item.filePath), total, truncated: total > limit,
			indexedFiles: entry.files.length, indexBuildMs: entry.buildDurationMs };
	}
	for (let index = 0; index < entry.files.length; index++) {
		const filePath = entry.files[index];
		const relative = entry.relativePaths[index];
		if (filePath === undefined || relative === undefined) continue;
		if (!fuzzy && (!needle || !entry.foldedPaths[index]?.includes(needle))) continue;
		if (options.showHidden === false && entry.hiddenPaths[index]) continue;
		if (includes.length && !includes.some((glob) => glob.test(relative))) continue;
		if (excludes.some((glob) => glob.test(relative))) continue;
		if (fuzzy) {
			const score = hasQuery ? match?.(relative) ?? null : 0;
			if (score !== null) ranked.push({ filePath, score });
			continue;
		}
		found.push(filePath);
		if (found.length > limit) break;
	}
	if (fuzzy) {
		ranked.sort((left, right) => right.score - left.score || (left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0));
		found.push(...ranked.slice(0, limit + 1).map((item) => item.filePath));
	}
	return {
		files: found.slice(0, limit),
		total: !entry.truncated && (fuzzy || found.length <= limit) ? (fuzzy ? ranked.length : found.length) : undefined,
		truncated: found.length > limit || entry.truncated,
		indexedFiles: entry.files.length,
		indexBuildMs: entry.buildDurationMs,
	};
}

/** Build or refresh the shared filename index without returning matches. */
export async function warmFileIndex(root: string, includeWorktrees = false, worktreeRoots: string[] = []): Promise<void> {
	const entry = indexFor(root, includeWorktrees);
	await ensureIndexed(entry, worktreeRoots);
}

/** Mark cached paths stale after file-system changes; the next query rebuilds the shared index. */
export function invalidateFilePathIndex(root: string): void {
	const resolved = canonicalPath(root);
	for (const entry of indexes.values()) {
		if (canonicalPath(entry.rootPath) !== resolved) continue;
		entry.version++;
		entry.builtAt = 0;
	}
}

/** Short alias for callers that own file-system change notifications. */
export const invalidateFileIndex = invalidateFilePathIndex;

export function getFilePathIndexStats(root: string, includeWorktrees = false): { indexedFiles: number; ageMs: number } {
	const entry = indexes.get(cacheKey(root, includeWorktrees));
	return {
		indexedFiles: entry?.files.length ?? 0,
		ageMs: entry?.builtAt ? Math.max(0, Date.now() - entry.builtAt) : Infinity,
	};
}
