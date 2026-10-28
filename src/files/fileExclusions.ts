import { globToRegExp } from './searchGlobs.ts';

/** Operating system metadata that never belongs to a source tree. */
export const DEFAULT_EXCLUDED_FILES = ['.DS_Store', 'Thumbs.db'];

export type ExcludedFileMatcher = (relativePath: string) => boolean;

interface ExcludedPattern { glob: string; anchored: boolean }

/** Trims patterns and drops blanks; falls back to the defaults for invalid saved data. */
export function normalizeExcludedFiles(value: unknown): string[] {
	if (!Array.isArray(value)) return [...DEFAULT_EXCLUDED_FILES];
	return value.filter((glob): glob is string => typeof glob === 'string').map((glob) => glob.trim()).filter(Boolean);
}

/** A pattern containing a slash is relative to the open folder; otherwise it matches a name at any depth. */
function parsePattern(value: string): ExcludedPattern | null {
	const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
	const anchored = normalized.includes('/');
	const glob = normalized.replace(/^\.?\/+/, '');
	return glob ? { glob, anchored } : null;
}

function parsePatterns(globs: readonly string[]): ExcludedPattern[] {
	return globs.map(parsePattern).filter((pattern): pattern is ExcludedPattern => pattern !== null);
}

/** Matches '/'-separated relative paths; an excluded folder also excludes everything inside it. */
export function createExcludedFileMatcher(globs: readonly string[]): ExcludedFileMatcher {
	const patterns = parsePatterns(globs).map(({ glob, anchored }) =>
		new RegExp(`${anchored ? '^' : '(?:^|/)'}${globToRegExp(glob).source.slice(1, -1)}(?:/|$)`));
	if (!patterns.length) return () => false;
	return (relativePath) => patterns.some((pattern) => pattern.test(relativePath));
}

/** Negated ripgrep globs equivalent to `createExcludedFileMatcher`; a leading slash anchors one-segment names. */
export function excludedFileRgGlobs(globs: readonly string[]): string[] {
	return parsePatterns(globs).flatMap(({ glob, anchored }) => anchored
		? [`!/${glob}`, `!/${glob}/**`]
		: [`!**/${glob}`, `!**/${glob}/**`]);
}

// The filename index and content search share the plugin-wide rule.
let activeKey = '';
let activeMatcher: ExcludedFileMatcher = () => false;
let activeRgGlobs: string[] = [];

/** Replaces the plugin-wide exclusions; returns whether they changed. */
export function setExcludedFiles(globs: readonly string[]): boolean {
	const key = globs.join('\n');
	if (key === activeKey) return false;
	activeKey = key;
	activeMatcher = createExcludedFileMatcher(globs);
	activeRgGlobs = excludedFileRgGlobs(globs);
	return true;
}

export function isExcludedFile(relativePath: string): boolean {
	return activeMatcher(relativePath);
}

export function activeExcludedFileRgGlobs(): readonly string[] {
	return activeRgGlobs;
}

/** Immutable rules captured before any asynchronous scan. */
export interface ExclusionPolicy {
 readonly key: string;
 readonly matches: ExcludedFileMatcher;
 readonly rgGlobs: readonly string[];
}
export function createExclusionPolicy(globs: readonly string[]): ExclusionPolicy {
 const snapshot = [...globs];
 return Object.freeze({ key: JSON.stringify(snapshot), matches: createExcludedFileMatcher(snapshot),
  rgGlobs: Object.freeze(excludedFileRgGlobs(snapshot)) });
}
export function activeExclusionPolicy(): ExclusionPolicy {
 return Object.freeze({ key: activeKey, matches: activeMatcher, rgGlobs: Object.freeze([...activeRgGlobs]) });
}
