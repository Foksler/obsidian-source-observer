import * as path from 'path';
import { promises as fs, realpathSync } from 'fs';
import { streamRipgrep } from './rgRunner.ts';

// eslint-disable-next-line obsidianmd/hardcoded-config-path -- Match source filename index exclusions.
const EXCLUDED_DIRS = new Set(['.git', '.obsidian', 'node_modules']);
const WORKTREE_PATHS = ['.claude/worktrees', '.worktrees', 'worktrees'];
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EXCLUDED_PATH = new RegExp(`(?:^|/)(?:${[...EXCLUDED_DIRS].map(escapeRegExp).join('|')})(?:/|$)`);
const WORKTREE_PATH = new RegExp(`(?:^|/)(?:${WORKTREE_PATHS.map(escapeRegExp).join('|')})(?:/|$)`);

function inventoryScope(root: string, includeWorktrees: boolean, worktreeRoots: string[]) {
	root = path.resolve(root);
	let canonicalRoot = path.resolve(root);
	try { canonicalRoot = realpathSync(root); } catch { /* Preserve unavailable roots for the search error. */ }
	const worktrees = worktreeRoots.map((tree) => {
		try { tree = realpathSync(tree); } catch { /* Keep the supplied path. */ }
		return path.relative(canonicalRoot, tree).split(path.sep).join('/');
	}).filter((relative) => relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative));
	const registered = worktrees.length
		? new RegExp(`^(?:${worktrees.map(escapeRegExp).join('|')})(?:/|$)`)
		: null;
	const excluded = (relative: string) => EXCLUDED_PATH.test(relative)
		|| (!includeWorktrees && (WORKTREE_PATH.test(relative)
			|| registered?.test(relative) === true));
	const args = ['--files', '--hidden', '--no-ignore', '--null'];
	for (const dir of EXCLUDED_DIRS) args.push('--glob', `!**/${dir}`, '--glob', `!**/${dir}/**`);
	if (!includeWorktrees) {
		for (const tree of WORKTREE_PATHS) args.push('--glob', `!**/${tree}`, '--glob', `!**/${tree}/**`);
		for (const tree of worktrees) args.push('--glob', `!${tree}`, '--glob', `!${tree}/**`);
	}
	const prefix = `${root.endsWith(path.sep) ? root.slice(0, -1) : root}${path.sep}`;
	const relativePath = (file: string): string | null => {
		let relative = path.isAbsolute(file)
			? file.startsWith(prefix) ? file.slice(prefix.length) : path.relative(root, file)
			: file.startsWith(`.${path.sep}`) ? file.slice(2) : file;
		if (path.sep !== '/') relative = relative.split(path.sep).join('/');
		if (relative.startsWith('../')) relative = path.relative(canonicalRoot, file).split(path.sep).join('/');
		// ripgrep enforces the metadata/conventional globs; registered names may contain glob metacharacters.
		return !relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)
			|| (!includeWorktrees && registered?.test(relative) === true) ? null : relative;
	};
	return { root, args: [...args, '--', '.'], excluded, relativePath };
}

async function walkInventory(scope: ReturnType<typeof inventoryScope>, signal: AbortSignal,
	visit: (relative: string) => void, limit = Infinity): Promise<boolean> {
	let directories = [''];
	let count = 0;
	while (directories.length) {
		const next: string[] = [];
		for (let offset = 0; offset < directories.length; offset += 32) {
			if (signal.aborted) throw new Error('Search cancelled');
			const batch = directories.slice(offset, offset + 32);
			const children = await Promise.all(batch.map(async (dir) => {
				try { return await fs.readdir(path.join(scope.root, dir), { withFileTypes: true }); }
				catch { return []; }
			}));
			for (let index = 0; index < batch.length; index++) {
				for (const child of children[index] ?? []) {
					if (signal.aborted) throw new Error('Search cancelled');
					const relative = batch[index] ? `${batch[index]}/${child.name}` : child.name;
					if (child.isSymbolicLink() || scope.excluded(relative)) continue;
					if (child.isDirectory()) next.push(relative);
					else if (child.isFile()) {
						if (count++ >= limit) return true;
						visit(relative);
					}
				}
			}
		}
		directories = next;
	}
	return false;
}

export async function collectFilePaths(root: string, includeWorktrees: boolean, worktreeRoots: string[],
	signal: AbortSignal, limit: number): Promise<{ paths: string[]; truncated: boolean }> {
	const scope = inventoryScope(root, includeWorktrees, worktreeRoots);
	const paths: string[] = [];
	try {
		let truncated = false;
		await streamRipgrep(scope.args, signal, (file) => {
			const relative = scope.relativePath(file);
			if (relative === null) return true;
			if (paths.length >= limit) { truncated = true; return false; }
			paths.push(relative);
			return true;
		}, '\0', scope.root);
		return { paths, truncated };
	} catch (error) {
		if (signal.aborted || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		return { paths, truncated: await walkInventory(scope, signal, (relative) => paths.push(relative), limit) };
	}
}

/** Enumerate without an output-size cap or following symlinks; ignored source files are searchable. */
export async function inventoryFilePaths(root: string, includeWorktrees: boolean, worktreeRoots: string[], signal: AbortSignal,
	visit: (filePath: string, relativePath: string) => void): Promise<void> {
	const scope = inventoryScope(root, includeWorktrees, worktreeRoots);
	try {
		await streamRipgrep(scope.args, signal, (file) => {
			const relative = scope.relativePath(file);
			if (relative !== null) visit(path.join(scope.root, relative), relative);
		}, '\0', scope.root);
	} catch (error) {
		if (signal.aborted || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		await walkInventory(scope, signal, (relative) => visit(path.join(scope.root, relative), relative));
	}
}
