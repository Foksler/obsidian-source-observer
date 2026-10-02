import { execFile } from 'child_process';
import { realpathSync } from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { runRipgrep } from './rgRunner.ts';
export { resolveRgExecutable } from './rgRunner.ts';
import {
	invalidateFileIndex as invalidateSharedFileIndex,
	searchFilePathIndex,
	warmFileIndex as warmSharedFileIndex,
} from './filePathIndex.ts';

const execFileAsync = promisify(execFile);
const worktreeCache = new Map<string, { expiresAt: number; roots: string[] }>();
const canonicalPathCache = new Map<string, string>();
const MAX_FALLBACK_FILE_BYTES = 5 * 1024 * 1024;

export interface SearchOptions {
	query: string;
	caseSensitive?: boolean;
	wholeWord?: boolean;
	regex?: boolean;
	includeGlob?: string;
	excludeGlob?: string;
	includeWorktrees?: boolean;
	limit?: number;
}

export interface SearchMatch {
	filePath: string;
	line: number;
	column: number;
	text: string;
}

export interface SearchResultGroup {
	filePath: string;
	matches: SearchMatch[];
}

export type SearchResultSet = SearchResultGroup[] & { truncated: boolean };

interface RgJsonEvent {
	type: string;
	data?: {
		path?: { text?: string };
		lines?: { text?: string };
		line_number?: number;
		submatches?: Array<{ start: number }>;
	};
}

// eslint-disable-next-line obsidianmd/hardcoded-config-path -- Source roots should omit the conventional vault config folder.
const DEFAULT_IGNORES = ['.git', 'node_modules', '.obsidian', '.cursor', 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt'];
const DEFAULT_IGNORED_FILES = ['composer.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '_ide_helper.php'];
const CONVENTIONAL_WORKTREE_GLOBS = ['.claude/worktrees', '.worktrees', 'worktrees'];

function splitGlobs(value?: string): string[] {
	return (value ?? '').split(/[\n,;]/).map((part) => part.trim()).filter(Boolean);
}

export function makeRgArgs(
	root: string,
	options: SearchOptions,
	registeredWorktrees: string[] = [],
	ignoreParent = false,
	scanRoots: string[] = [root],
): string[] {
	const args = ['--json', '--line-number', '--column', '--no-heading', '--color', 'never', '--hidden'];
	if (ignoreParent) args.push('--no-ignore-parent');
	if (!options.caseSensitive) args.push('--ignore-case');
	if (options.wholeWord) args.push('--word-regexp');
	for (const glob of DEFAULT_IGNORES) {
		args.push('--glob', `!${glob}`, '--glob', `!**/${glob}/**`);
	}
	for (const file of DEFAULT_IGNORED_FILES) args.push('--glob', `!${file}`, '--glob', `!**/${file}`);
	if (!options.includeWorktrees) {
		for (const glob of CONVENTIONAL_WORKTREE_GLOBS) {
			args.push('--glob', `!${glob}`, '--glob', `!${glob}/**`, '--glob', `!**/${glob}`, '--glob', `!**/${glob}/**`);
		}
		for (const worktree of registeredWorktrees) {
			const relative = path.relative(root, worktree).split(path.sep).join('/');
			if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) continue;
			args.push('--glob', `!${relative}`, '--glob', `!${relative}/**`);
		}
	}
	for (const glob of splitGlobs(options.includeGlob)) args.push('--glob', glob);
	for (const glob of splitGlobs(options.excludeGlob)) args.push('--glob', `!${glob}`);
	if (options.regex) args.push('--regexp', options.query);
	else args.push('--fixed-strings', '--regexp', options.query);
	args.push('--', ...scanRoots);
	return args;
}

function mergeSearchResults(results: SearchResultGroup[][], limit: number): SearchResultSet {
	const groups = new Map<string, SearchResultGroup>();
	let count = 0;
	let truncated = false;
	for (const result of results) {
		if ((result as SearchResultSet).truncated) truncated = true;
		for (const group of result) {
			const canonicalFilePath = canonicalPath(group.filePath);
			let merged = groups.get(canonicalFilePath);
			if (!merged) {
				merged = { filePath: group.filePath, matches: [] };
				groups.set(canonicalFilePath, merged);
			}
			const seen = new Set(merged.matches.map((match) => `${match.line}:${match.column}`));
			for (const match of group.matches) {
				const key = `${match.line}:${match.column}`;
				if (seen.has(key)) continue;
				if (count >= limit) { truncated = true; break; }
				merged.matches.push(match);
				seen.add(key);
				count++;
			}
			if (count >= limit) break;
		}
		if (count >= limit) {
			if (results.length > 1) truncated = true;
			break;
		}
	}
	return Object.assign([...groups.values()].filter((group) => group.matches.length > 0), { truncated });
}

export function parseRgJson(output: string, limit = 1000, root?: string): SearchResultGroup[] {
	const groups = new Map<string, SearchResultGroup>();
	let count = 0;
	for (const line of output.split(/\r?\n/)) {
		if (count >= limit) break;
		if (!line) continue;
		let event: RgJsonEvent;
		try { event = JSON.parse(line) as RgJsonEvent; } catch { continue; }
		if (event.type !== 'match') continue;
		const data = event.data;
		if (data?.path?.text === undefined || data.lines?.text === undefined || typeof data.line_number !== 'number') continue;
		const rawPath = data.path.text;
		const filePath = root ? pathInRoot(root, path.resolve(root, rawPath)) : rawPath;
		const group = groups.get(filePath) ?? { filePath, matches: [] };
		const text = data.lines.text.replace(/[\r\n]+$/, '');
		const utf8Line = Buffer.from(text, 'utf8');
		for (const submatch of data.submatches ?? []) {
			if (count >= limit) break;
			group.matches.push({
				filePath,
				line: data.line_number,
				column: byteOffsetToColumn(utf8Line, submatch.start),
				text,
			});
			count++;
		}
		groups.set(filePath, group);
	}
	return [...groups.values()];
}

function capGroups(groups: SearchResultGroup[], limit: number): { groups: SearchResultGroup[]; truncated: boolean } {
	let remaining = limit;
	let truncated = false;
	const capped: SearchResultGroup[] = [];
	for (const group of groups) {
		if (remaining <= 0) { truncated = true; break; }
		const matches = group.matches.slice(0, remaining);
		if (matches.length < group.matches.length) truncated = true;
		capped.push({ ...group, matches });
		remaining -= matches.length;
	}
	return { groups: capped, truncated };
}

function byteOffsetToColumn(utf8Line: Buffer, byteOffset: number): number {
	return utf8Line.subarray(0, byteOffset).toString('utf8').length + 1;
}

export function isDefaultExcludedRelativePath(relativePath: string): boolean {
	if (isAlwaysExcludedRelativePath(relativePath)) return true;
	return isConventionalWorktreeRelativePath(relativePath);
}

function isConventionalWorktreeRelativePath(relativePath: string): boolean {
	const parts = relativePath.split(/[\\/]+/).filter(Boolean);
	return CONVENTIONAL_WORKTREE_GLOBS.some((glob) => {
		const globParts = glob.split('/');
		return parts.some((_, index) => globParts.every((part, offset) => parts[index + offset] === part));
	});
}

function isAlwaysExcludedRelativePath(relativePath: string): boolean {
	const parts = relativePath.split(/[\\/]+/).filter(Boolean);
	return parts.some((part) => DEFAULT_IGNORES.includes(part) || DEFAULT_IGNORED_FILES.includes(part));
}

export async function getRegisteredWorktrees(root: string): Promise<string[]> {
	const canonicalRoot = canonicalPath(root);
	const cached = worktreeCache.get(canonicalRoot);
	if (cached && cached.expiresAt > Date.now()) return cached.roots;

	const roots = new Set<string>();
	try {
		const { stdout } = await execFileAsync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
			encoding: 'utf8', timeout: 1500, maxBuffer: 1024 * 1024,
		});
		for (const line of stdout.split(/\r?\n/)) {
			if (!line.startsWith('worktree ')) continue;
			const worktree = canonicalPath(line.slice('worktree '.length));
			if (worktree !== canonicalRoot && isWithin(canonicalRoot, worktree)) roots.add(worktree);
		}
	} catch { /* Selected root may be a plain directory or non-Git container. */ }
	for (const worktree of await findNestedWorktrees(canonicalRoot)) {
		if (worktree !== canonicalRoot) roots.add(worktree);
	}
	const result = [...roots];
	worktreeCache.set(canonicalRoot, { expiresAt: Date.now() + 10_000, roots: result });
	return result;
}

async function findNestedWorktrees(root: string): Promise<string[]> {
	const found: string[] = [];
	const skipDirs = new Set([...DEFAULT_IGNORES, 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt']);
	let visited = 0;
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (depth > 5 || visited >= 1500) return;
		visited++;
		let marker;
		try { marker = await fsp.lstat(path.join(dir, '.git')); } catch { marker = null; }
		if (marker?.isFile()) {
			try {
				const contents = await fsp.readFile(path.join(dir, '.git'), 'utf8');
				if (/^gitdir:\s*.+[\\/]\.git[\\/]worktrees[\\/]/im.test(contents)) {
					found.push(canonicalPath(dir));
					return;
				}
			} catch { /* Ignore unreadable markers. */ }
		}
		let entries;
		try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink() || skipDirs.has(entry.name)) continue;
			await walk(path.join(dir, entry.name), depth + 1);
			if (visited >= 1500) return;
		}
	};
	await walk(root, 0);
	return found;
}

function isWithin(parent: string, candidate: string): boolean {
	const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalPath(candidate: string): string {
	const resolved = path.resolve(candidate);
	const cached = canonicalPathCache.get(resolved);
	if (cached) return cached;
	let canonical = resolved;
	try { canonical = realpathSync(resolved); } catch { /* Keep the resolved path if it disappeared. */ }
	canonicalPathCache.set(resolved, canonical);
	return canonical;
}

function pathInRoot(root: string, candidate: string): string {
	const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
	if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
		return path.resolve(root, relative);
	}
	return candidate;
}

function globToRegExp(glob: string): RegExp {
	const normalized = glob.replace(/\\/g, '/');
	let source = '^';
	for (let i = 0; i < normalized.length; i++) {
		const char = normalized[i] ?? '';
		if (char === '*') {
			if (normalized[i + 1] === '*' && normalized[i + 2] === '/') { source += '(?:.*/)?'; i += 2; }
			else if (normalized[i + 1] === '*') { source += '.*'; i++; }
			else source += '[^/]*';
		} else if (char === '?') source += '[^/]';
		else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
	}
	return new RegExp(`${source}$`);
}

interface IgnoreRule { base: string; pattern: RegExp; negated: boolean; }

async function readIgnoreRules(dir: string, root: string, inherited: IgnoreRule[]): Promise<IgnoreRule[]> {
	const base = path.relative(root, dir).split(path.sep).join('/');
	const rules = [...inherited];
	for (const name of ['.gitignore', '.ignore', '.cursorignore']) {
		let lines: string[];
		try { lines = (await fsp.readFile(path.join(dir, name), 'utf8')).split(/\r?\n/); } catch { continue; }
		for (let pattern of lines) {
			pattern = pattern.trim();
			if (!pattern || pattern.startsWith('#')) continue;
			const negated = pattern.startsWith('!');
			if (negated) pattern = pattern.slice(1);
			pattern = pattern.replace(/^\//, '').replace(/\/$/, '');
			const globPattern = globToRegExp(pattern).source.slice(1, -1);
			const source = pattern.includes('/')
				? `^${globPattern}(?:/.*)?$`
				: `(?:^|/)${globPattern}(?:/.*)?$`;
			rules.push({ base, pattern: new RegExp(source), negated });
		}
	}
	return rules;
}

function isIgnoredPath(relative: string, rules: IgnoreRule[]): boolean {
	let ignored = false;
	for (const rule of rules) {
		const local = rule.base
			? relative.startsWith(`${rule.base}/`) ? relative.slice(rule.base.length + 1) : null
			: relative;
		if (local !== null && rule.pattern.test(local)) ignored = !rule.negated;
	}
	return ignored;
}

async function fallbackSearch(root: string, options: SearchOptions, signal: AbortSignal, worktrees: string[]): Promise<SearchResultSet> {
	const query = options.regex ? new RegExp(options.query, `${options.caseSensitive ? '' : 'i'}g`) : null;
	const needle = options.caseSensitive ? options.query : options.query.toLocaleLowerCase();
	const includes = splitGlobs(options.includeGlob).map(globToRegExp);
	const excludes = splitGlobs(options.excludeGlob).map(globToRegExp);
	const groups: SearchResultGroup[] = [];
	const max = options.limit ?? 1000;
	let truncated = false;
	const walk = async (dir: string, inheritedRules: IgnoreRule[] = []): Promise<void> => {
		if (signal.aborted || groups.reduce((sum, group) => sum + group.matches.length, 0) >= max) return;
		const rules = await readIgnoreRules(dir, root, inheritedRules);
		let entries;
		try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (signal.aborted) return;
			const fullPath = path.join(dir, entry.name);
			const relative = path.relative(root, fullPath).split(path.sep).join('/');
			if (entry.isSymbolicLink()) continue;
			if (isAlwaysExcludedRelativePath(relative) || (!options.includeWorktrees && isConventionalWorktreeRelativePath(relative))) continue;
			if (!options.includeWorktrees && worktrees.some((worktree) => isWithin(worktree, fullPath))) continue;
		const isDirectory = entry.isDirectory();
		const isWorktreeAncestor = isDirectory && worktrees.some((worktree) => isWithin(fullPath, worktree));
		if (isIgnoredPath(relative, rules) && !isWorktreeAncestor) continue;
		if (isDirectory) {
			const localRules = worktrees.some((worktree) => isWithin(worktree, fullPath)) ? [] : rules;
			await walk(fullPath, localRules);
			continue;
		}
			if (!entry.isFile() || (includes.length && !includes.some((glob) => glob.test(relative))) || excludes.some((glob) => glob.test(relative))) continue;
			let content: string;
			try {
				const stat = await fsp.stat(fullPath);
				if (stat.size > MAX_FALLBACK_FILE_BYTES) continue;
				const buffer = await fsp.readFile(fullPath);
				if (buffer.includes(0)) continue;
				content = buffer.toString('utf8');
			} catch { continue; }
			const matches: SearchMatch[] = [];
			for (const [index, text] of content.split(/\r?\n/).entries()) {
				const normalized = options.caseSensitive ? text : text.toLocaleLowerCase();
				if (query) {
					query.lastIndex = 0;
					let match: RegExpExecArray | null;
					while ((match = query.exec(text)) !== null) {
						const before = text[match.index - 1] ?? '';
						const after = text[match.index + match[0].length] ?? '';
						const isWord = (value: string) => /[\p{L}\p{N}_]/u.test(value);
						if (!options.wholeWord || (!isWord(before) && !isWord(after))) {
							matches.push({ filePath: fullPath, line: index + 1, column: match.index + 1, text });
						}
						if (match[0].length === 0) query.lastIndex++;
						if (matches.length >= max) { truncated = true; break; }
					}
				} else {
					let from = 0;
					for (;;) {
						const column = normalized.indexOf(needle, from);
						if (column < 0) break;
						const before = text[column - 1] ?? '';
						const after = text[column + options.query.length] ?? '';
						const isWord = (value: string) => /[\p{L}\p{N}_]/u.test(value);
						if (!options.wholeWord || (!isWord(before) && !isWord(after))) {
							matches.push({ filePath: fullPath, line: index + 1, column: column + 1, text });
						}
						from = column + Math.max(options.query.length, 1);
						if (matches.length >= max) { truncated = true; break; }
					}
				}
				if (matches.length >= max) { truncated = true; break; }
			}
			if (matches.length) groups.push({ filePath: fullPath, matches });
		}
	};
	if (options.query) await walk(root);
	if (signal.aborted) throw new Error('Search cancelled');
	return Object.assign(groups, { truncated });
}

export async function searchContent(root: string, options: SearchOptions, signal: AbortSignal): Promise<SearchResultSet> {
	if (!options.query) return Object.assign([], { truncated: false });
	const worktrees = await getRegisteredWorktrees(root);
	try {
		const output = await runRipgrep(makeRgArgs(root, options, worktrees), signal);
		const limit = options.limit ?? 1000;
		const parsed = parseRgJson(output.text, limit + 1, root);
		const capped = capGroups(parsed, limit);
		const groups = capped.groups.filter((group) =>
			options.includeWorktrees || !worktrees.some((worktree) => isWithin(worktree, group.filePath)),
		);
		const scans: SearchResultGroup[][] = [Object.assign(groups, { truncated: capped.truncated || output.truncated })];
		if (options.includeWorktrees && worktrees.length) {
			const remaining = Math.max(1, limit - groups.reduce((sum, group) => sum + group.matches.length, 0));
			const localOptions = { ...options, limit: remaining, includeWorktrees: true };
			const local = await runRipgrep(makeRgArgs(root, localOptions, [], true, worktrees), signal);
			const parsedLocal = parseRgJson(local.text, remaining + 1, root);
			const cappedLocal = capGroups(parsedLocal, remaining);
			scans.push(Object.assign(cappedLocal.groups, { truncated: cappedLocal.truncated || local.truncated }));
		}
		return mergeSearchResults(scans, limit);
	} catch (error) {
		if (signal.aborted) throw error;
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		return fallbackSearch(root, options, signal, worktrees);
	}
}

export async function listFilesDetailed(
	root: string,
	query: string,
	signal: AbortSignal,
	includeWorktrees = false,
	includeGlob = '',
	excludeGlob = '',
	showHidden = true,
): Promise<{ files: string[]; truncated: boolean }> {
	const worktrees = await getRegisteredWorktrees(root);
	const indexed = await searchFilePathIndex(root, query, {
		matchMode: 'fuzzy',
		includeWorktrees,
		showHidden,
		includeGlob,
		excludeGlob,
		limit: 500,
		worktreeRoots: worktrees,
	});
	return { files: indexed.files, truncated: indexed.truncated };
}

/** Warm the shared filename inventory, including Git-registered worktree discovery. */
export async function warmFileIndex(root: string, includeWorktrees = false): Promise<void> {
	const worktrees = await getRegisteredWorktrees(root);
	await warmSharedFileIndex(root, includeWorktrees, worktrees);
}

/** Invalidate the shared filename inventory after a root-level filesystem change. */
export function invalidateFileIndex(root: string): void {
	invalidateSharedFileIndex(root);
}

export async function listFiles(root: string, query: string, signal: AbortSignal, includeWorktrees = false): Promise<string[]> {
	return (await listFilesDetailed(root, query, signal, includeWorktrees)).files;
}

export async function searchContentFallback(root: string, options: SearchOptions, signal: AbortSignal): Promise<SearchResultSet> {
	const worktrees = await getRegisteredWorktrees(root);
	return fallbackSearch(root, options, signal, worktrees);
}
