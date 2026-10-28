export type {SearchOptions,SearchMatch,SearchResultGroup,SearchResultSet} from './Contracts.ts';
import { getRegisteredWorktrees } from '../git/index.ts';
export { getRegisteredWorktrees } from '../git/index.ts';
import { FILE_POLICY_PROFILES, CONVENTIONAL_WORKTREE_PATHS } from '../files/index.ts';
import { realpathSync } from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { runRipgrep } from '../files/index.ts';
import { parseRgJson } from './rgParser.ts';
export { parseRgJson } from './rgParser.ts';
import { globToRegExp, splitGlobs } from '../files/index.ts';
import { activeExclusionPolicy, isExcludedFile, type ExclusionPolicy } from '../files/index.ts';
const MAX_FALLBACK_FILE_BYTES = 5 * 1024 * 1024;

import type {SearchOptions,SearchMatch,SearchResultGroup,SearchResultSet} from './Contracts.ts';
const DEFAULT_IGNORES: readonly string[] = FILE_POLICY_PROFILES.content.excludedDirectories;
const DEFAULT_IGNORED_FILES: readonly string[] = FILE_POLICY_PROFILES.content.excludedFiles;
const CONVENTIONAL_WORKTREE_GLOBS = CONVENTIONAL_WORKTREE_PATHS;

export function makeRgArgs(
	root: string,
	options: SearchOptions,
	registeredWorktrees: string[] = [],
	ignoreParent = false,
	scanRoots: string[] = [root],
 policy: ExclusionPolicy = activeExclusionPolicy(),
): string[] {
	const args = ['--json', '--line-number', '--column', '--no-heading', '--color', 'never'];
	if (options.showHidden !== false) args.push('--hidden');
	if (ignoreParent) args.push('--no-ignore-parent');
	if (!options.caseSensitive) args.push('--ignore-case');
	if (options.wholeWord) args.push('--word-regexp');
	// Positive globs override ripgrep's hidden-file and exclusion rules unless
	// the mandatory exclusions follow them.
	for (const glob of splitGlobs(options.includeGlob)) args.push('--glob', glob);
	if (options.showHidden === false) args.push('--glob', '!**/.*', '--glob', '!**/.*/**');
	for (const glob of DEFAULT_IGNORES) {
		args.push('--glob', `!${glob}`, '--glob', `!**/${glob}/**`);
	}
	for (const file of DEFAULT_IGNORED_FILES) args.push('--glob', `!${file}`, '--glob', `!**/${file}`);
	for (const glob of policy.rgGlobs) args.push('--glob', glob);
	if (!options.includeWorktrees) {
		for (const glob of CONVENTIONAL_WORKTREE_GLOBS) {
			args.push('--glob', `!${glob}`, '--glob', `!${glob}/**`, '--glob', `!**/${glob}`, '--glob', `!**/${glob}/**`);
		}
		for (const worktree of registeredWorktrees) {
			const relative = path.relative(canonicalPath(root), canonicalPath(worktree)).split(path.sep).join('/');
			if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) continue;
			args.push('--glob', `!${relative}`, '--glob', `!${relative}/**`);
		}
	}
	for (const glob of splitGlobs(options.excludeGlob)) args.push('--glob', `!${glob}`);
	if (options.regex) args.push('--regexp', options.query);
	else args.push('--fixed-strings', '--regexp', options.query);
	// Run from root so path globs are relative to the selected folder, including
	// the additional worktree scans. The host app's working directory is unrelated.
	args.push('--', ...scanRoots.map((scanRoot) => path.relative(canonicalPath(root), canonicalPath(scanRoot)) || '.'));
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
	return Object.assign([...groups.values()].filter((group) => group.matches.length > 0), { truncated, totalKind: truncated ? 'unknown' as const : 'exact' as const });
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

function isAlwaysExcludedRelativePath(relativePath: string, policy?: ExclusionPolicy): boolean {
	const parts = relativePath.split(/[\\/]+/).filter(Boolean);
	return parts.some((part) => DEFAULT_IGNORES.includes(part) || DEFAULT_IGNORED_FILES.includes(part))
		|| (policy ? policy.matches(parts.join('/')) : isExcludedFile(parts.join('/')));
}


function isWithin(parent: string, candidate: string): boolean {
	const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalPath(candidate: string): string {
	const resolved = path.resolve(candidate);
	let canonical = resolved;
	try { canonical = realpathSync(resolved); } catch { /* Keep the resolved path if it disappeared. */ }
	return canonical;
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

async function fallbackSearch(root: string, options: SearchOptions, signal: AbortSignal, worktrees: string[], policy = activeExclusionPolicy()): Promise<SearchResultSet> {
	const query = options.regex ? new RegExp(options.query, `${options.caseSensitive ? '' : 'i'}g`) : null;
	const needle = options.caseSensitive ? options.query : options.query.toLocaleLowerCase();
	const includes = splitGlobs(options.includeGlob).map((glob) => globToRegExp(glob));
	const excludes = splitGlobs(options.excludeGlob).map((glob) => globToRegExp(glob));
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
			if (options.showHidden === false && entry.name.startsWith('.')) continue;
			const fullPath = path.join(dir, entry.name);
			const relative = path.relative(root, fullPath).split(path.sep).join('/');
			if (entry.isSymbolicLink()) continue;
			if (isAlwaysExcludedRelativePath(relative, policy) || (!options.includeWorktrees && isConventionalWorktreeRelativePath(relative))) continue;
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
	return Object.assign(groups, { truncated, totalKind: truncated ? 'unknown' as const : 'exact' as const });
}

export interface SearchEnvironment { worktreeRoots?: readonly string[]; policy?: ExclusionPolicy }
export async function searchContent(root: string, options: SearchOptions, signal: AbortSignal, environment: SearchEnvironment = {}): Promise<SearchResultSet> {
 options = { ...options };
 const policy = environment.policy ?? activeExclusionPolicy();
	if (!options.query) return Object.assign([], { truncated: false, totalKind: 'exact' as const });
	await fsp.access(root);
	const worktrees = environment.worktreeRoots ? [...environment.worktreeRoots] : await getRegisteredWorktrees(root);
	try {
		const output = await runRipgrep(makeRgArgs(root, options, worktrees, false, [root], policy), signal, undefined, root);
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
			const visibleWorktrees = options.showHidden === false
				? worktrees.filter((worktree) => !path.relative(root, worktree).split(path.sep).some((part) => part.startsWith('.')))
				: worktrees;
			if (!visibleWorktrees.length) return mergeSearchResults(scans, limit);
			const local = await runRipgrep(makeRgArgs(root, localOptions, [], true, visibleWorktrees, policy), signal, undefined, root);
			const parsedLocal = parseRgJson(local.text, remaining + 1, root);
			const cappedLocal = capGroups(parsedLocal, remaining);
			scans.push(Object.assign(cappedLocal.groups, { truncated: cappedLocal.truncated || local.truncated }));
		}
		return mergeSearchResults(scans, limit);
	} catch (error) {
		if (signal.aborted) throw error;
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		return fallbackSearch(root, options, signal, worktrees, policy);
	}
}

export async function searchContentFallback(root: string, options: SearchOptions, signal: AbortSignal, environment: SearchEnvironment = {}): Promise<SearchResultSet> {
 const policy = environment.policy ?? activeExclusionPolicy();
	const worktrees = environment.worktreeRoots ? [...environment.worktreeRoots] : await getRegisteredWorktrees(root);
	return fallbackSearch(root, options, signal, worktrees, policy);
}
