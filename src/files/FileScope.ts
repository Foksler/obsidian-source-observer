import * as path from 'path';
import { realpathSync } from 'fs';
import { createExcludedFileMatcher } from './fileExclusions.ts';

export interface PathIdentity { readonly display: string; readonly canonical: string }
export function pathIdentity(target: string): PathIdentity {
	const display = path.resolve(target); let ancestor = display;
	while (true) {
		try { return { display, canonical: path.resolve(realpathSync(ancestor), path.relative(ancestor, display)) }; }
		catch (error) {
			if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) break;
			const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
		}
	}
	return { display, canonical: display };
}
export const CONVENTIONAL_WORKTREE_PATHS = Object.freeze(['.claude/worktrees', '.worktrees', 'worktrees']);
// eslint-disable-next-line obsidianmd/hardcoded-config-path -- Existing source policies use the conventional metadata name, independently of the active vault.
const filenameDirectories = Object.freeze(['.git', '.obsidian', 'node_modules']);
// eslint-disable-next-line obsidianmd/hardcoded-config-path -- Preserve content search coverage independently of filename inventory.
const contentDirectories = Object.freeze(['.git', 'node_modules', '.obsidian', '.cursor', 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt']);
export const FILE_POLICY_PROFILES = Object.freeze({
	tree: Object.freeze({ symlinks: 'expand-one-level', ignoreFiles: false, excludedDirectories: Object.freeze([] as string[]), excludedFiles: Object.freeze([] as string[]) }),
	filename: Object.freeze({ symlinks: 'skip', ignoreFiles: false, excludedDirectories: filenameDirectories, excludedFiles: Object.freeze([] as string[]) }),
	content: Object.freeze({ symlinks: 'skip', ignoreFiles: true, excludedDirectories: contentDirectories, excludedFiles: Object.freeze(['composer.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '_ide_helper.php']) }),
	languageRoots: Object.freeze({ symlinks: 'skip', ignoreFiles: false, excludedDirectories: Object.freeze(['.git', '.svn', '.hg', 'CVS', 'node_modules', 'bower_components', 'vendor', '.beads']), excludedFiles: Object.freeze([] as string[]) }),
});
export const GO_INDEX_EXCLUDED_DIRECTORIES = Object.freeze(['.git', 'node_modules', '.beads']);
export type FileProfile = keyof typeof FILE_POLICY_PROFILES;
export interface FileScopeOptions {
	showHidden: boolean;
	includeWorktrees: boolean;
	excludedFiles: readonly string[];
	worktreeRoots: readonly string[];
	revision?: number;
}

/** Immutable root/policy snapshot. Ignore-file parsing and lazy symlink expansion stay with their adapters. */
export class FileScope {
	readonly root: PathIdentity;
	readonly revision: number;
	private options: FileScopeOptions;
	private excluded: (relative: string) => boolean;
	private worktrees: string[];
	constructor(root: string, options: FileScopeOptions) {
		this.root = Object.freeze(pathIdentity(root)); this.revision = options.revision ?? 0;
		this.options = { ...options, excludedFiles: [...options.excludedFiles], worktreeRoots: [...options.worktreeRoots] };
		this.excluded = createExcludedFileMatcher(this.options.excludedFiles);
		this.worktrees = options.worktreeRoots.map(tree => path.relative(this.root.canonical, pathIdentity(tree).canonical).split(path.sep).join('/'))
			.filter(relative => relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative));
	}
	allows(profile: FileProfile, relative: string, isSymlink = false): boolean {
		relative = path.posix.normalize(relative.split(path.sep).join('/'));
		if (relative === '.') relative = '';
		const parts = relative.split('/').filter(Boolean), policy = FILE_POLICY_PROFILES[profile];
		if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return false;
		if (isSymlink && policy.symlinks === 'skip') return false;
		if (profile !== 'filename' && !this.options.showHidden && parts.some(part => part.startsWith('.'))) return false;
		if (parts.some(part => policy.excludedDirectories.includes(part) || policy.excludedFiles.includes(part))) return false;
		if (this.excluded(relative)) return false;
		return this.options.includeWorktrees || !this.isWorktree(relative);
	}
	isWorktree(relative: string): boolean {
		const parts = relative.split('/');
		return parts.some((part, index) => part === 'worktrees' || part === '.worktrees' || (part === '.claude' && parts[index + 1] === 'worktrees'))
			|| this.worktrees.some(tree => relative === tree || relative.startsWith(tree + '/'));
	}
	containsCanonical(target: string): boolean {
		const relative = path.relative(this.root.canonical, pathIdentity(target).canonical);
		return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	}
}
