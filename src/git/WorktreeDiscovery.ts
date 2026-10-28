import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { FILE_POLICY_PROFILES, pathIdentity } from '../files/index.ts';
const execFileAsync = promisify(execFile);
const DEFAULT_IGNORES: readonly string[] = FILE_POLICY_PROFILES.content.excludedDirectories;
const canonicalPath = (target: string) => pathIdentity(target).canonical;
function isWithin(parent: string, candidate: string) { const relative = path.relative(parent, candidate); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }

/** Search/tree topology keeps its historical bounded traversal profile. Language discovery is separate. */
export class WorktreeDiscovery {
	private cache = new Map<string, { expiresAt: number; roots: string[] }>();
	private generation = 0;
 private scans=0;
 private stopped=false;
	clear() { this.generation++; this.cache.clear(); }
	async roots(root: string): Promise<string[]> {
  if(this.stopped)return [];
  this.scans++;
  try {
		const generation = this.generation;
		const canonicalRoot = canonicalPath(root);
		const cached = this.cache.get(canonicalRoot);
		if (cached && cached.expiresAt > Date.now()) return cached.roots;

		const roots = new Set<string>();
		try {
			const { stdout } = await execFileAsync('git', ['--no-optional-locks', '-C', root, 'worktree', 'list', '--porcelain'], {
				encoding: 'utf8', timeout: 1500, maxBuffer: 1024 * 1024,
			});
			for (const line of stdout.split(/\r?\n/)) {
				if (!line.startsWith('worktree ')) continue;
				const worktree = canonicalPath(line.slice('worktree '.length));
				if (worktree !== canonicalRoot && isWithin(canonicalRoot, worktree)) roots.add(worktree);
			}
		} catch { /* Selected root may be a plain directory or non-Git container. */ }
  if(this.stopped)return [];
  if(generation!==this.generation)return await this.roots(root);
		for (const worktree of await findNestedWorktrees(canonicalRoot)) {
			if (worktree !== canonicalRoot) roots.add(worktree);
		}
  if(this.stopped)return [];
  if(generation!==this.generation)return await this.roots(root);
		const result = [...roots];
		if (generation === this.generation) this.cache.set(canonicalRoot, { expiresAt: Date.now() + 10_000, roots: result });
  while(this.cache.size>32)this.cache.delete(this.cache.keys().next().value!);
		return result;
  } finally {this.scans--;}
	}
 diagnostics() {return {roots:this.cache.size,activeScans:this.scans,disposed:this.stopped};}
 dispose() {this.stopped=true;this.clear();}
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

const defaultDiscovery = new WorktreeDiscovery();
export const getRegisteredWorktrees = (root: string) => defaultDiscovery.roots(root);
export const clearWorktreeCaches = () => defaultDiscovery.clear();

// Language-root discovery intentionally has different coverage and limits from filename/tree topology.
const EXCLUDED_DIRECTORY_NAMES = new Set<string>(FILE_POLICY_PROFILES.languageRoots.excludedDirectories);
const MAX_DIRECTORIES = 5000, MAX_DEPTH = 8;
export async function findLanguageWorktrees(root: string): Promise<string[]> {
	const found = new Set<string>();
	try {
		const { stdout } = await execFileAsync('git', ['--no-optional-locks', '-C', root, 'worktree', 'list', '--porcelain'], {
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
