import { execFile } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', '.svn', '.hg', 'CVS', 'node_modules', 'bower_components', 'vendor']);
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

export async function findRegisteredWorktrees(root: string): Promise<string[]> {
	const found = new Set<string>();
	try {
		const { stdout } = await execFileAsync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
			encoding: 'utf8', timeout: 1500, maxBuffer: 1024 * 1024,
		});
		const rootPath = canonicalPath(root);
		for (const worktree of stdout.split(/\r?\n/)
			.filter((line) => line.startsWith('worktree '))
			.map((line) => canonicalPath(line.slice('worktree '.length)))
			.filter((worktree) => worktree !== rootPath)) found.add(worktree);
	} catch { /* The selected folder may be a container for multiple repositories. */ }

	// A vault/project parent may not itself be a Git repository. Walk only
	// repository metadata markers to find nested linked worktrees in that case.
	let visited = 0;
	const inspect = async (directory: string, depth: number): Promise<void> => {
		if (visited >= MAX_DIRECTORIES || depth > MAX_DEPTH) return;
		visited++;
		try {
			const marker = await fsp.readFile(path.join(directory, '.git'), 'utf8');
			const gitDirMatch = /^gitdir:\s*(.+)\s*$/im.exec(marker);
			if (gitDirMatch?.[1]) {
				const gitDir = path.resolve(directory, gitDirMatch[1]);
				if (/(?:^|[\\/])\.git[\\/]worktrees[\\/][^\\/]+$/i.test(gitDir)) {
					found.add(canonicalPath(directory));
					return;
				}
			}
		} catch { /* Directory has no linked-worktree marker. */ }
		let entries;
		try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const entryPath = path.join(directory, entry.name);
			if (!entry.isDirectory() || entry.isSymbolicLink() || EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
			await inspect(entryPath, depth + 1);
			if (visited >= MAX_DIRECTORIES) break;
		}
	};
	await inspect(path.resolve(root), 0);
	return [...found];
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
export async function findWorkspaceComposerRoots(root: string, includeWorktrees = false): Promise<string[]> {
	const workspaceRoot = path.resolve(root);
	if (existsSync(path.join(workspaceRoot, 'composer.json'))) return [workspaceRoot];
	const registered = includeWorktrees ? [] : await findRegisteredWorktrees(workspaceRoot);
	const results: string[] = [];
	let visited = 0;

	const walk = async (directory: string, depth: number): Promise<void> => {
		if (visited >= MAX_DIRECTORIES || results.length >= MAX_PROJECTS || depth > MAX_DEPTH) return;
		if (!includeWorktrees && registered.some((worktree) => isWithin(workspaceRoot, worktree) && isWithin(worktree, directory))) return;
		visited++;
		let entries;
		try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
		if (entries.some((entry) => entry.isFile() && entry.name === 'composer.json')) {
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
	return results;
}
