import * as path from 'path';
import { promises as fsp } from 'fs';
import { runGitCommand as runGit, parseGitStatus } from './GitRepositoryStore.ts';
import type { ChangedFile } from './GitRepositoryStore.ts';
export type { ChangedFile } from './GitRepositoryStore.ts';

/** Returns true when `repoPath` is inside a git working tree. */
export async function isGitRepo(repoPath: string): Promise<boolean> {
	const { stdout } = await runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
	return stdout.trim() === 'true';
}

/** Finds the owning working tree, including nested repositories and worktrees. */
export async function getGitRoot(target: string, isDirectory: boolean): Promise<string | null> {
	const { stdout } = await runGit(isDirectory ? target : path.dirname(target), ['rev-parse', '--show-toplevel']);
	return stdout.trim() ? path.resolve(stdout.trim()) : null;
}

/**
 * Returns all changed files in the repo according to `git status --porcelain -z`.
 * The NUL-separated format avoids quoting of non-ASCII/whitespace paths, and
 * for renames the destination path is used as `file`.
 */
export async function getChangedFiles(repoPath: string): Promise<ChangedFile[]> {
	const { stdout } = await runGit(repoPath, ['status', '--porcelain=v1', '-z', '-u']);
	return parseGitStatus(stdout);
}

/**
 * Returns a unified diff string for `filePath` relative to `repoPath`.
 * Falls back to `git diff --cached` for staged-only files, and to a
 * synthetic all-additions diff for untracked files.
 */
export async function getFileDiff(repoPath: string, filePath: string): Promise<string> {
	const rel = path.relative(repoPath, filePath) || filePath;

	const { stdout: diffHead } = await runGit(repoPath, ['diff', 'HEAD', '--', rel]);
	if (diffHead.trim()) return diffHead;

	const { stdout: diffCached } = await runGit(repoPath, ['diff', '--cached', '--', rel]);
	if (diffCached.trim()) return diffCached;

	// Untracked / new file — render entire content as additions
	try {
		const content = await fsp.readFile(filePath, 'utf-8');
		const lines = content.split('\n');
		const header = `diff --git a/${rel} b/${rel}\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n`;
		return header + lines.map((l) => '+' + l).join('\n');
	} catch {
		return '';
	}
}
