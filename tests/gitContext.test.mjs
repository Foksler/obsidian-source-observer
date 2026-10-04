import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getGitRoot, getChangedFiles, getFileDiff } from '../src/gitDiff.ts';
const exec = promisify(execFile);

test('Git context resolves nested folders, open files and worktrees without requiring the workspace root to be Git', async () => {
 const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'so-git-context-')));
 try {
  const repo = path.join(parent, 'project'), src = path.join(repo, 'src');
  await mkdir(src, { recursive: true });
  await exec('git', ['init', '--quiet', repo]);
  const file = path.join(src, 'Current.php'); await writeFile(file, '<?php\n');
  assert.equal(await getGitRoot(parent, true), null);
  assert.equal(await getGitRoot(src, true), repo);
  assert.equal(await getGitRoot(file, false), repo);
  assert.ok((await getChangedFiles(repo)).some(change => change.file === 'src/Current.php'));
  assert.match(await getFileDiff(src, file), /\+<\?php/);
  await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
  const worktree = path.join(parent, 'worktree');
  await exec('git', ['-C', repo, 'worktree', 'add', '--quiet', '--detach', worktree]);
  assert.equal(await getGitRoot(worktree, true), worktree);
  assert.equal(await getGitRoot(path.join(worktree, 'Gone.php'), false), worktree);
 } finally { await rm(parent, { recursive: true, force: true }); }
});
