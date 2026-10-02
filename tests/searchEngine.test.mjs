import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { searchContent, searchContentFallback, listFiles, listFilesDetailed, resolveRgExecutable } from '../src/searchEngine.ts';

const execFileAsync = promisify(execFile);

async function fixture(t) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'source-observer-search-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await execFileAsync('git', ['init', '-q'], { cwd: root });
	return root;
}

test('search groups multiple matches and applies case, whole-word, include and exclude filters', async (t) => {
	const root = await fixture(t);
	await mkdir(path.join(root, 'src'), { recursive: true });
	await writeFile(path.join(root, 'src', 'main.ts'), 'Alpha alphabet alpha\nalpha');
	await writeFile(path.join(root, 'src', 'other.js'), 'ALPHA alpha');
	await writeFile(path.join(root, 'notes.md'), 'alpha');
	const result = await searchContent(root, {
		query: 'alpha', wholeWord: true, includeGlob: '**/*.ts,**/*.js', excludeGlob: '**/other.js', limit: 20,
	}, new AbortController().signal);
	assert.equal(result.length, 1);
	assert.equal(path.basename(result[0].filePath), 'main.ts');
	assert.deepEqual(result[0].matches.map((match) => [match.line, match.column]), [[1, 1], [1, 16], [2, 1]]);
	const caseSensitive = await searchContent(root, { query: 'Alpha', caseSensitive: true }, new AbortController().signal);
	assert.equal(caseSensitive.length, 1);
	assert.equal(caseSensitive[0].matches.length, 1);
});

test('content search preserves whitespace-only queries', async (t) => {
	const root = await fixture(t);
	await writeFile(path.join(root, 'spaces.txt'), 'left right');
	const result = await searchContent(root, { query: ' ' }, new AbortController().signal);
	assert.equal(result[0].matches[0].column, 5);
});

test('content result limit is capped within a single grouped file and marks truncation', async (t) => {
	const root = await fixture(t);
	await writeFile(path.join(root, 'many.txt'), Array.from({ length: 40 }, () => 'needle').join('\n'));
	const result = await searchContent(root, { query: 'needle', limit: 10 }, new AbortController().signal);
	assert.equal(result[0].matches.length, 10);
	assert.equal(result.truncated, true);
});

test('ripgrep executable discovery is cached for GUI environments with a limited PATH', async () => {
	assert.equal(resolveRgExecutable(), resolveRgExecutable());
	const executable = await resolveRgExecutable();
	if (executable) assert.equal(path.basename(executable), 'rg');
});

test('regex mode returns line and column links and excludes ignored and binary files', async (t) => {
	const root = await fixture(t);
	await mkdir(path.join(root, 'ignored'), { recursive: true });
	await writeFile(path.join(root, '.gitignore'), 'ignored/\n*.bin\n');
	await writeFile(path.join(root, 'src.txt'), 'value=42\nvalue=7');
	await writeFile(path.join(root, 'unicode.txt'), '猫value=9');
	await writeFile(path.join(root, 'emoji.txt'), '😀value=1');
	await writeFile(path.join(root, 'ignored', 'skip.txt'), 'value=42');
	await writeFile(path.join(root, 'asset.bin'), Buffer.from([0, 1, 2, 0]));
	const result = await searchContent(root, { query: 'value=\\d+', regex: true }, new AbortController().signal);
	assert.equal(result.length, 3);
	const source = result.find((group) => group.filePath.endsWith('src.txt'));
	const unicode = result.find((group) => group.filePath.endsWith('unicode.txt'));
	const emoji = result.find((group) => group.filePath.endsWith('emoji.txt'));
	assert.deepEqual(source.matches.map((match) => [match.line, match.column]), [[1, 1], [2, 1]]);
	assert.equal(unicode.matches[0].column, 2);
	assert.equal(emoji.matches[0].column, 3);
});

test('quick open includes ignored source files, excludes conventional worktrees, and does not follow symlink cycles', async (t) => {
	const root = await fixture(t);
	await mkdir(path.join(root, '.worktrees', 'branch'), { recursive: true });
	await mkdir(path.join(root, 'worktrees', 'branch'), { recursive: true });
	await mkdir(path.join(root, 'src'), { recursive: true });
	await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
	await mkdir(path.join(root, 'ignored'), { recursive: true });
	await writeFile(path.join(root, 'src', 'visible.ts'), '');
	await writeFile(path.join(root, '.worktrees', 'branch', 'hidden.ts'), '');
	await writeFile(path.join(root, 'worktrees', 'branch', 'also-hidden.ts'), '');
	await writeFile(path.join(root, 'ignored', 'ignored.ts'), '');
	try { await symlink(root, path.join(root, 'src', 'cycle'), 'dir'); } catch { /* Symlinks can be unavailable on restricted hosts. */ }
	const files = await listFiles(root, '.ts', new AbortController().signal);
	assert.deepEqual(files.map((file) => path.relative(root, file)), ['ignored/ignored.ts', 'src/visible.ts']);
	const filtered = await listFilesDetailed(root, '.ts', new AbortController().signal, false, '**/*.ts', '**/visible.ts');
	assert.deepEqual(filtered.files.map((file) => path.relative(root, file)), ['ignored/ignored.ts']);
});

test('filesystem fallback respects nested ignore files and default Cursor exclusions', async (t) => {
	const root = await fixture(t);
	await mkdir(path.join(root, 'nested', 'secret'), { recursive: true });
	await mkdir(path.join(root, 'root-ignored'), { recursive: true });
	await writeFile(path.join(root, '.gitignore'), 'root-ignored/\n*.tmp\n!keep.tmp\n');
	await writeFile(path.join(root, '.cursorignore'), 'private.txt\n');
	await writeFile(path.join(root, 'nested', '.gitignore'), 'secret/\n');
	await writeFile(path.join(root, 'visible.txt'), 'needle');
	await writeFile(path.join(root, 'nested', 'also-visible.txt'), 'needle');
	await writeFile(path.join(root, 'nested', 'secret', 'hidden.txt'), 'needle');
	await writeFile(path.join(root, 'root-ignored', 'hidden.txt'), 'needle');
	await writeFile(path.join(root, 'private.txt'), 'needle');
	await writeFile(path.join(root, 'composer.lock'), 'needle');
	await writeFile(path.join(root, '_ide_helper.php'), 'needle');
	await writeFile(path.join(root, 'keep.tmp'), 'needle');
	await writeFile(path.join(root, 'huge.log'), Buffer.concat([Buffer.from('needle'), Buffer.alloc(5 * 1024 * 1024)]));
	const result = await searchContentFallback(root, { query: 'needle' }, new AbortController().signal);
	assert.deepEqual(result.map((group) => path.relative(root, group.filePath)).sort(), ['keep.tmp', 'nested/also-visible.txt', 'visible.txt']);
});

test('an aborted search rejects instead of returning stale matches', async (t) => {
	const root = await fixture(t);
	await writeFile(path.join(root, 'file.txt'), 'needle');
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(searchContent(root, { query: 'needle' }, controller.signal), /cancelled/i);
});

test('quick open excludes Git-registered worktrees nested under an arbitrary directory', async (t) => {
	const root = await fixture(t);
	const runGit = (args) => execFileAsync('git', args, { cwd: root, encoding: 'utf8' });
	await runGit(['init', '-q']);
	await runGit(['config', 'user.email', 'test@example.com']);
	await runGit(['config', 'user.name', 'Search test']);
	await writeFile(path.join(root, 'seed.txt'), 'seed');
	await runGit(['add', 'seed.txt']);
	await runGit(['commit', '-qm', 'seed']);
	await runGit(['worktree', 'add', '--detach', 'linked-checkout', 'HEAD']);
	await writeFile(path.join(root, 'linked-checkout', 'worktree-only.ts'), '');
	await writeFile(path.join(root, 'linked-checkout', 'worktree-only.ts'), 'worktree-token');
	await writeFile(path.join(root, 'visible.ts'), '');
	const files = await listFiles(root, '.ts', new AbortController().signal);
	assert.deepEqual(files.map((file) => path.relative(root, file)), ['visible.ts']);
	const included = await listFiles(root, '.ts', new AbortController().signal, true);
	assert.deepEqual(included.map((file) => path.relative(root, file)).sort(), ['linked-checkout/worktree-only.ts', 'visible.ts']);
	const searchDefault = await searchContent(root, { query: 'worktree-token' }, new AbortController().signal);
	assert.equal(searchDefault.length, 0);
	const searchIncluded = await searchContent(root, { query: 'worktree-token', includeWorktrees: true }, new AbortController().signal);
	assert.equal(searchIncluded.length, 1);
});

test('a non-Git parent detects registered sibling worktrees through their .git markers', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'source-observer-container-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const main = path.join(root, 'predictions-main');
	await mkdir(main, { recursive: true });
	const runGit = (args) => execFileAsync('git', args, { cwd: main, encoding: 'utf8' });
	await runGit(['init', '-q']);
	await runGit(['config', 'user.email', 'test@example.com']);
	await runGit(['config', 'user.name', 'Search test']);
	await writeFile(path.join(main, 'seed.txt'), 'seed');
	await runGit(['add', 'seed.txt']);
	await runGit(['commit', '-qm', 'seed']);
	const worktree = path.join(root, 'predictions-issue-156');
	await runGit(['worktree', 'add', '--detach', worktree, 'HEAD']);
	await writeFile(path.join(worktree, 'worktree-only.txt'), 'markRunning worktree marker');
	await writeFile(path.join(root, 'visible.txt'), 'markRunning in parent');
	const excluded = await searchContent(root, { query: 'markRunning' }, new AbortController().signal);
	assert.deepEqual(excluded.map((group) => path.relative(root, group.filePath)), ['visible.txt']);
	const included = await searchContent(root, { query: 'markRunning', includeWorktrees: true }, new AbortController().signal);
	assert.deepEqual(included.map((group) => path.relative(root, group.filePath)).sort(), ['predictions-issue-156/worktree-only.txt', 'visible.txt']);
	const quickOpen = await listFiles(root, 'worktree-only', new AbortController().signal);
	assert.deepEqual(quickOpen, []);
});

test('Include worktrees bypasses ignored ancestors but keeps worktree-local ignores', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'source-observer-ignored-parent-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const main = path.join(root, 'predictions-main');
	await mkdir(main, { recursive: true });
	const runGit = (args) => execFileAsync('git', args, { cwd: main, encoding: 'utf8' });
	await runGit(['init', '-q']);
	await runGit(['config', 'user.email', 'test@example.com']);
	await runGit(['config', 'user.name', 'Search test']);
	await writeFile(path.join(main, 'seed.txt'), 'seed');
	await runGit(['add', 'seed.txt']);
	await runGit(['commit', '-qm', 'seed']);
	const worktree = path.join(root, '.claude', 'worktrees', 'predictions-master');
	await mkdir(path.dirname(worktree), { recursive: true });
	await runGit(['worktree', 'add', '--detach', worktree, 'HEAD']);
	await writeFile(path.join(root, '.gitignore'), '.claude/\n');
	await writeFile(path.join(worktree, '.gitignore'), 'local-ignore.txt\n');
	await writeFile(path.join(worktree, 'included.txt'), 'parent-rule-token');
	await writeFile(path.join(worktree, 'local-ignore.txt'), 'parent-rule-token');
	await writeFile(path.join(root, 'visible.txt'), 'parent-rule-token');
	const normal = await searchContent(root, { query: 'parent-rule-token' }, new AbortController().signal);
	assert.deepEqual(normal.map((group) => path.relative(root, group.filePath)), ['visible.txt']);
	const included = await searchContent(root, { query: 'parent-rule-token', includeWorktrees: true }, new AbortController().signal);
	assert.deepEqual(included.map((group) => path.relative(root, group.filePath)).sort(), ['.claude/worktrees/predictions-master/included.txt', 'visible.txt']);
	const quickOpen = await listFiles(root, 'included.txt', new AbortController().signal, true);
	assert.deepEqual(quickOpen.map((file) => path.relative(root, file)), ['.claude/worktrees/predictions-master/included.txt']);
	const fallback = await searchContentFallback(root, { query: 'parent-rule-token', includeWorktrees: true }, new AbortController().signal);
	assert.deepEqual(fallback.map((group) => path.relative(root, group.filePath)).sort(), ['.claude/worktrees/predictions-master/included.txt', 'visible.txt']);
});
