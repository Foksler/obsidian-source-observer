import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/git/treeGitStatus.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { getTreeGitStatuses, treeGitStatus } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const exec = promisify(execFile);
const git = (root, ...args) => exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args]);
async function fixture(t) {
 const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'so-tree-git-')));
 t.after(() => rm(root, { recursive: true, force: true }));
 return root;
}
async function init(root) {
 await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
 await git(root, 'init', '--quiet');
 for (const file of ['src/nested/change.ts', 'src/deleted.ts', 'src/renamed.ts', 'stable.ts']) await writeFile(path.join(root, file), 'base\n');
 await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
 await commit(root);
}
async function commit(root) { await git(root, 'add', '.'); await git(root, 'commit', '--quiet', '-m', 'fixture'); }

test('real Git changes decorate collapsed ancestors, handle unusual paths and disappear after commit', async (t) => {
 const root = await fixture(t); await init(root);
 await writeFile(path.join(root, 'src', 'nested', 'change.ts'), 'modified\n');
 await rm(path.join(root, 'src', 'deleted.ts'));
 await git(root, 'mv', 'src/renamed.ts', 'src/renamed new.ts');
 await writeFile(path.join(root, 'staged.ts'), 'new\n'); await git(root, 'add', 'staged.ts');
 const unusual = 'новый файл\n.ts'; await writeFile(path.join(root, unusual), 'new\n');
 await writeFile(path.join(root, 'ignored.txt'), 'ignored\n');
 const statuses = await getTreeGitStatuses(root, [root, path.join(root, 'src')]);
 const kind = file => statuses.get(path.join(root, file))?.kind;
 assert.equal(kind('src/nested/change.ts'), 'modified');
 assert.equal(kind('src/nested'), 'modified');
 assert.equal(kind('src'), 'modified');
 assert.equal(kind(''), 'modified');
 assert.equal(kind('src/deleted.ts'), 'deleted');
 assert.equal(kind('src/renamed new.ts'), 'renamed');
 assert.equal(kind('staged.ts'), 'added');
 assert.equal(kind(unusual), 'untracked');
 assert.equal(kind('stable.ts'), undefined);
 assert.equal(kind('ignored.txt'), undefined);
 await commit(root);
 assert.equal((await getTreeGitStatuses(root, [root])).size, 0);
});

test('a selected subfolder and a symlinked root use tree paths and exclude changes outside the root', async (t) => {
 const parent = await fixture(t), root = path.join(parent, 'repo'); await init(root);
 await writeFile(path.join(root, 'src/nested/change.ts'), 'changed');
 await writeFile(path.join(root, 'stable.ts'), 'outside selection');
 const src = path.join(root, 'src');
 const statuses = await getTreeGitStatuses(src, [src]);
 assert.ok(statuses.has(src));
 assert.ok(!statuses.has(root));
 assert.ok(!statuses.has(path.join(root, 'stable.ts')));
 const alias = path.join(parent, 'alias'); await symlink(src, alias);
 const aliased = await getTreeGitStatuses(alias, [alias]);
 assert.ok(aliased.has(path.join(alias, 'nested/change.ts')));
 assert.ok(!aliased.has(path.join(src, 'nested/change.ts')));
});

test('non-Git workspace discovers collapsed child repositories and worktrees, keeping their statuses separate', async (t) => {
 const parent = await fixture(t), repo = path.join(parent, 'repo'); await init(repo);
 const worktree = path.join(parent, 'worktree'); await git(repo, 'worktree', 'add', '--quiet', '--detach', worktree);
 await writeFile(path.join(repo, 'src/nested/change.ts'), 'modified');
 await writeFile(path.join(worktree, 'new.ts'), 'untracked');
 const statuses = await getTreeGitStatuses(parent, [parent, repo, worktree]);
 assert.equal(statuses.get(repo)?.kind, 'modified');
 assert.equal(statuses.get(worktree)?.kind, 'untracked');
 assert.equal(statuses.get(path.join(worktree, 'src/nested/change.ts')), undefined);
 assert.equal(statuses.get(parent)?.kind, 'modified');
});

test('a nested repository owns its status instead of inheriting its parent untracked directory status', async (t) => {
 const root = await fixture(t); await init(root);
 const nested = path.join(root, 'nested'); await init(nested);
 const dirs = [root, nested];
 assert.equal((await getTreeGitStatuses(root, dirs)).size, 0);
 await writeFile(path.join(nested, 'stable.ts'), 'modified');
 const statuses = await getTreeGitStatuses(root, dirs);
 assert.equal(statuses.get(nested)?.kind, 'modified');
 assert.equal(statuses.get(root)?.kind, 'modified');
 await git(nested, 'restore', 'stable.ts');
 assert.equal((await getTreeGitStatuses(root, dirs)).size, 0);
});

test('merge conflicts take priority over other changes in ancestor folders', async (t) => {
 const root = await fixture(t); await init(root);
 const branch = (await git(root, 'branch', '--show-current')).stdout.trim();
 await git(root, 'checkout', '--quiet', '-b', 'other');
 await writeFile(path.join(root, 'stable.ts'), 'other\n'); await commit(root);
 await git(root, 'checkout', '--quiet', branch);
 await writeFile(path.join(root, 'stable.ts'), 'ours\n'); await commit(root);
 await assert.rejects(git(root, 'merge', 'other'));
 await writeFile(path.join(root, 'src/nested/change.ts'), 'modified');
 const statuses = await getTreeGitStatuses(root, [root]);
 assert.equal(statuses.get(path.join(root, 'stable.ts'))?.kind, 'conflict');
 assert.equal(statuses.get(root)?.kind, 'conflict');
 for (const code of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) assert.equal(treeGitStatus(code)?.kind, 'conflict');
});
