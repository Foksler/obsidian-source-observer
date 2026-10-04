import * as path from 'path';
import { promises as fs, realpathSync } from 'fs';
import { streamRipgrep } from './rgRunner.ts';

// eslint-disable-next-line obsidianmd/hardcoded-config-path -- Match source filename index exclusions.
const EXCLUDED_DIRS = new Set(['.git', '.obsidian', 'node_modules']);
const WORKTREE_PATHS = ['.claude/worktrees', '.worktrees', 'worktrees'];

/** Enumerate without an output-size cap or following symlinks; ignored source files are searchable. */
export async function inventoryFilePaths(root: string, includeWorktrees: boolean, worktreeRoots: string[], signal: AbortSignal,
	visit: (filePath: string, relativePath: string) => void): Promise<void> {
	let canonicalRoot = path.resolve(root);
	try { canonicalRoot = realpathSync(root); } catch { /* Preserve unavailable roots for the search error. */ }
	const worktrees = worktreeRoots.map((tree) => {
		try { tree = realpathSync(tree); } catch { /* Keep the supplied path. */ }
		return path.relative(canonicalRoot, tree).split(path.sep).join('/');
	}).filter((relative) => relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative));
	const excluded = (relative: string) => {
		const parts = relative.split('/');
		return parts.some((part) => EXCLUDED_DIRS.has(part)) || (!includeWorktrees && (
			WORKTREE_PATHS.some((pattern) => parts.some((_, i) => parts.slice(i, i + pattern.split('/').length).join('/') === pattern))
			|| worktrees.some((tree) => relative === tree || relative.startsWith(`${tree}/`))));
	};
	const args = ['--files', '--hidden', '--no-ignore', '--null'];
	for (const dir of EXCLUDED_DIRS) args.push('--glob', `!**/${dir}`, '--glob', `!**/${dir}/**`);
	if (!includeWorktrees) {
		for (const tree of WORKTREE_PATHS) args.push('--glob', `!**/${tree}`, '--glob', `!**/${tree}/**`);
		for (const tree of worktrees) args.push('--glob', `!${tree}`, '--glob', `!${tree}/**`);
	}
	try {
		await streamRipgrep([...args, '--', root], signal, (file) => {
			if (!file) return;
			const fullPath = path.resolve(root, file);
			let relative = path.relative(root, fullPath).split(path.sep).join('/');
			if (relative.startsWith('../')) relative = path.relative(canonicalRoot, fullPath).split(path.sep).join('/');
			if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || excluded(relative)) return;
			visit(path.join(root, relative), relative);
		}, '\0');
	} catch (error) {
		if (signal.aborted || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		let directories = [root];
		while (directories.length) {
			if (signal.aborted) throw new Error('Search cancelled');
			const next: string[] = [];
			for (const dir of directories) {
				const entries = await fs.readdir(dir, { withFileTypes: true });
				for (const child of entries) {
					if (signal.aborted) throw new Error('Search cancelled');
					const file = path.join(dir, child.name), relative = path.relative(root, file).split(path.sep).join('/');
					if (child.isSymbolicLink() || excluded(relative)) continue;
					if (child.isDirectory()) next.push(file);
					else if (child.isFile()) visit(file, relative);
				}
			}
			directories = next;
		}
	}
}
