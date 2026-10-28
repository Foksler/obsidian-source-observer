export * from '../../src/search/searchEngine.ts';
import {getRegisteredWorktrees,clearWorktreeCaches} from '../../src/git/WorktreeDiscovery.ts';
import {clearFilePathIndexes,invalidateFileIndex as invalidateSharedFileIndex,searchFilePathIndex,warmFileIndex as warmSharedFileIndex} from './legacyFileIndex.ts';
export function clearSearchCaches(){clearFilePathIndexes();clearWorktreeCaches();}
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
		signal,
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

export * from '../../src/search/Contracts.ts';
export {resolveRgExecutable} from '../../src/files/rgRunner.ts';
