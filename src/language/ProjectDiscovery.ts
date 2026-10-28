import { findLanguageWorktrees as findRegisteredWorktrees } from '../git/index.ts';
export { findLanguageWorktrees as findRegisteredWorktrees } from '../git/index.ts';
import { FILE_POLICY_PROFILES } from '../files/index.ts';
import { existsSync, realpathSync } from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { isPhpFile } from '../files/index.ts';

const EXCLUDED_DIRECTORY_NAMES = new Set<string>(FILE_POLICY_PROFILES.languageRoots.excludedDirectories);
const WORKTREE_DIRECTORY_NAMES = new Set(['.worktrees', 'worktrees']);
const MAX_DIRECTORIES = 5000;
const MAX_DEPTH = 8;
const MAX_PROJECTS = 16;
const BASE_FILE_EXCLUDES = [
	'**/.git/**', '**/.svn/**', '**/.hg/**', '**/CVS/**', '**/.DS_Store/**',
	'**/node_modules/**', '**/bower_components/**',
	'**/vendor/**/{Tests,tests}/**', '**/.history/**', '**/vendor/**/vendor/**',
];
const WORKTREE_FILE_EXCLUDES = ['**/.worktrees/**', '**/worktrees/**'];
const STORAGE_FILE_EXCLUDES = ['**/storage/framework/**'];

function canonicalPath(candidate: string): string {
	try { return realpathSync(candidate); } catch { return path.resolve(candidate); }
}

function isWithin(parent: string, candidate: string): boolean {
	const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}


export async function createIntelephenseSettings(root: string, includeWorktrees = false) {
	const excludes = [...BASE_FILE_EXCLUDES, ...STORAGE_FILE_EXCLUDES];
	if (!includeWorktrees) {
		excludes.push(...WORKTREE_FILE_EXCLUDES);
		for (const worktree of await findRegisteredWorktrees(root)) {
			if (!isWithin(root, worktree) || canonicalPath(root) === worktree) continue;
			const relative = path.relative(canonicalPath(root), worktree).split(path.sep).join('/');
			if (relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)) {
				excludes.push(`${relative}/**`, `**/${relative}/**`);
			}
		}
	}
	return {
		telemetry: { enabled: false },
		environment: { phpVersion: '8.4', documentRoot: 'public' },
		files: { exclude: [...new Set(excludes)], maxSize: 5_000_000 },
	};
}

/**
 * Resolve Composer roots only when a workspace-symbol query is requested.
 * The walk is bounded and skips dependency, metadata, and duplicate checkout
 * trees so opening a broad folder never triggers recursive LSP startup work.
 */
export function findWorkspaceComposerRoots(root: string, includeWorktrees = false): Promise<string[]> {
	return findWorkspaceProjectRoots(root, ['composer.json'], includeWorktrees, isPhpFile);
}

/** Shared bounded discovery; each adapter supplies its own workspace markers. */
export async function findWorkspaceProjectRoots(root: string, markers: string[], includeWorktrees = false,
	supportedFile?: (file: string) => boolean): Promise<string[]> {
	const workspaceRoot = path.resolve(root);
	if (markers.some((marker) => existsSync(path.join(workspaceRoot, marker)))) return [workspaceRoot];
	const registered = includeWorktrees ? [] : await findRegisteredWorktrees(workspaceRoot);
	const results: string[] = [];
	let visited = 0;
	let hasLooseFiles = false;

	const walk = async (directory: string, depth: number): Promise<void> => {
		if (visited >= MAX_DIRECTORIES || results.length >= MAX_PROJECTS || depth > MAX_DEPTH) return;
		if (!includeWorktrees && registered.some((worktree) => isWithin(workspaceRoot, worktree) && isWithin(worktree, directory))) return;
		visited++;
		let entries;
		try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
		if (supportedFile && entries.some((entry) => entry.isFile() && supportedFile(path.join(directory, entry.name)))) hasLooseFiles = true;
		if (entries.some((entry) => entry.isFile() && markers.includes(entry.name))) {
			results.push(directory);
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink() || EXCLUDED_DIRECTORY_NAMES.has(entry.name) ||
				(!includeWorktrees && WORKTREE_DIRECTORY_NAMES.has(entry.name))) continue;
			await walk(path.join(directory, entry.name), depth + 1);
			if (results.length >= MAX_PROJECTS || visited >= MAX_DIRECTORIES) break;
		}
	};

	await walk(workspaceRoot, 0);
	return results.length ? results : hasLooseFiles ? [workspaceRoot] : [];
}
