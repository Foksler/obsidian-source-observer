import { promises as fsp } from 'fs';
import * as path from 'path';
import { getChangedFiles, getGitRoot } from './gitDiff';

export type TreeGitKind = 'untracked' | 'added' | 'renamed' | 'deleted' | 'modified' | 'conflict';
export interface TreeGitStatus { kind: TreeGitKind; badge: string; label: string }

const priority: Record<TreeGitKind, number> = { untracked: 0, added: 1, renamed: 2, deleted: 3, modified: 4, conflict: 5 };

export function treeGitStatus(code: string): TreeGitStatus | null {
	if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code)) return { kind: 'conflict', badge: '!', label: 'Conflict' };
	if (/[MT]/.test(code)) return { kind: 'modified', badge: 'M', label: 'Modified' };
	if (code.includes('D')) return { kind: 'deleted', badge: 'D', label: 'Deleted' };
	if (code.includes('R')) return { kind: 'renamed', badge: 'R', label: 'Renamed' };
	if (/[AC]/.test(code)) return { kind: 'added', badge: 'A', label: 'Added' };
	if (code === '??') return { kind: 'untracked', badge: 'U', label: 'Untracked' };
	return null;
}

function contains(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** Only inspect directories already loaded by the lazy tree, never walk unopened branches. */
export async function getTreeGitStatuses(root: string, directories: readonly string[]): Promise<Map<string, TreeGitStatus>> {
	const [owner, canonicalRoot, nested] = await Promise.all([
		getGitRoot(root, true),
		fsp.realpath(root).catch(() => root),
		Promise.all(directories.filter((dir) => dir !== root).map(async (dir) =>
			await fsp.stat(path.join(dir, '.git')).then(() => dir, () => null))),
	]);
	// Keep Git's canonical paths separate from the tree's spelling (a symlink may select a subfolder).
	const repos = [
		...(owner ? [{ directory: root, gitRoot: owner, sourceRoot: canonicalRoot }] : []),
		...[...new Set(nested.filter((dir): dir is string => dir !== null))]
			.map((dir) => ({ directory: dir, gitRoot: dir, sourceRoot: dir })),
	];
	const snapshots = await Promise.all(repos.map(async (repo) => ({ repo, changes: await getChangedFiles(repo.gitRoot) })));
	const statuses = new Map<string, TreeGitStatus>();
	for (const { repo, changes } of snapshots) {
		for (const change of changes) {
			const file = path.resolve(repo.directory, path.relative(repo.sourceRoot, path.resolve(repo.gitRoot, change.file)));
			if (!contains(root, file)) continue;
			// A nested repo/worktree owns its contents, even when its parent reports it as untracked.
			if (repos.some((other) => other !== repo && contains(repo.directory, other.directory) && contains(other.directory, file)
				&& (file !== other.directory || change.code === '??'))) continue;
			const status = treeGitStatus(change.code);
			if (!status) continue;
			let current = file;
			while (contains(root, current)) {
				const previous = statuses.get(current);
				if (!previous || priority[status.kind] > priority[previous.kind]) statuses.set(current, status);
				if (current === root) break;
				current = path.dirname(current);
			}
		}
	}
	return statuses;
}
