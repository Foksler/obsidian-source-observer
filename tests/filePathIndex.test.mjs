import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { invalidateFilePathIndex, searchFilePathIndex } from '../src/filePathIndex.ts';
import { listFilesDetailed } from '../src/searchEngine.ts';

const execFileAsync = promisify(execFile);

async function fixture(t) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'source-observer-index-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test('shared filename index includes ignored source and vendor files but omits metadata and symlinks', async (t) => {
	const root = await fixture(t);
	await mkdir(path.join(root, 'vendor/laravel/horizon/src'), { recursive: true });
	await mkdir(path.join(root, 'src'), { recursive: true });
	await mkdir(path.join(root, '.git'), { recursive: true });
	await mkdir(path.join(root, '.obsidian'), { recursive: true });
	await writeFile(path.join(root, '.gitignore'), 'vendor/\nsrc/\n');
	await writeFile(path.join(root, 'vendor/laravel/horizon/src/DashboardStatsController.php'), '');
	await writeFile(path.join(root, 'src/StatsController.php'), '');
	await writeFile(path.join(root, '.git/config'), '');
	await writeFile(path.join(root, '.obsidian/StatsController.php'), '');
	try { await (await import('node:fs/promises')).symlink(root, path.join(root, 'src/cycle'), 'dir'); } catch { /* Symlinks may be unavailable on the test host. */ }

	const fromPanel = await listFilesDetailed(root, 'StatsController.php', new AbortController().signal);
	assert.deepEqual(fromPanel.files.map((file) => path.relative(root, file)).sort(), [
		'src/StatsController.php',
		'vendor/laravel/horizon/src/DashboardStatsController.php',
	]);
	const fromIndex = await searchFilePathIndex(root, 'DashboardStatsController.php');
	assert.deepEqual(fromIndex.files.map((file) => path.relative(root, file)), [
		'vendor/laravel/horizon/src/DashboardStatsController.php',
	]);
});

test('shared index applies hidden, include/exclude globs and preserves query whitespace', async (t) => {
	const root = await fixture(t);
	await mkdir(path.join(root, 'src'), { recursive: true });
	await mkdir(path.join(root, '.hidden'), { recursive: true });
	await writeFile(path.join(root, 'src/StatsController.php'), '');
	await writeFile(path.join(root, 'src/Stats Controller.php'), '');
	await writeFile(path.join(root, 'src/OtherStatsController.php'), '');
	await writeFile(path.join(root, '.hidden/StatsController.php'), '');

	const spaced = await searchFilePathIndex(root, 'Stats Controller', { includeGlob: '**/*.php' });
	assert.deepEqual(spaced.files.map((file) => path.relative(root, file)), ['src/Stats Controller.php']);
	const filtered = await searchFilePathIndex(root, 'StatsController', {
		showHidden: false, includeGlob: '**/StatsController.php', excludeGlob: '**/Other*',
	});
	assert.deepEqual(filtered.files.map((file) => path.relative(root, file)), ['src/StatsController.php']);
});

test('registered Git worktrees are excluded by default and searchable when enabled', async (t) => {
	const root = await fixture(t);
	const runGit = (args) => execFileAsync('git', args, { cwd: root, encoding: 'utf8' });
	await runGit(['init', '-q']);
	await runGit(['config', 'user.email', 'test@example.com']);
	await runGit(['config', 'user.name', 'Search test']);
	await writeFile(path.join(root, 'seed.txt'), 'seed');
	await runGit(['add', 'seed.txt']);
	await runGit(['commit', '-qm', 'seed']);
	await runGit(['worktree', 'add', '--detach', 'linked-checkout', 'HEAD']);
	await writeFile(path.join(root, 'linked-checkout/StatsController.php'), '');
	await writeFile(path.join(root, 'StatsController.php'), '');

	const excluded = await listFilesDetailed(root, 'StatsController.php', new AbortController().signal);
	assert.deepEqual(excluded.files.map((file) => path.relative(root, file)), ['StatsController.php']);
	const included = await listFilesDetailed(root, 'StatsController.php', new AbortController().signal, true);
	assert.deepEqual(included.files.map((file) => path.relative(root, file)).sort(), [
		'StatsController.php', 'linked-checkout/StatsController.php',
	]);
});

test('warm filename queries reuse the index and explicit invalidation discovers new files', async (t) => {
	const root = await fixture(t);
	await writeFile(path.join(root, 'BeforeStatsController.php'), '');
	const cold = await searchFilePathIndex(root, 'StatsController');
	const warm = await searchFilePathIndex(root, 'BeforeStatsController.php');
	assert.ok(cold.indexBuildMs >= 0);
	assert.equal(warm.indexBuildMs, cold.indexBuildMs);
	await writeFile(path.join(root, 'AfterStatsController.php'), '');
	assert.deepEqual((await searchFilePathIndex(root, 'AfterStatsController.php')).files, []);
	invalidateFilePathIndex(root);
	assert.equal((await searchFilePathIndex(root, 'AfterStatsController.php')).files.length, 1);
});

test('quick-open and sidebar filename search find gapped names and rank exact names before the result cap', async (t) => {
	const root = await fixture(t);
	await mkdir(path.join(root, 'a/DashboardController'), { recursive: true });
	await mkdir(path.join(root, 'vendor/Http/Controllers'), { recursive: true });
	await mkdir(path.join(root, 'z'), { recursive: true });
	await writeFile(path.join(root, '.gitignore'), 'vendor/\n');
	await Promise.all(Array.from({ length: 110 }, (_, index) =>
		writeFile(path.join(root, `a/DashboardController/Other${index}.ts`), '')));
	await writeFile(path.join(root, 'vendor/Http/Controllers/DashboardStatsController.php'), '');
	await writeFile(path.join(root, 'z/DashboardController.php'), '');

	const quickOpen = await searchFilePathIndex(root, 'dashboardcontroller', { matchMode: 'fuzzy', limit: 2 });
	assert.deepEqual(quickOpen.files.map((file) => path.relative(root, file)), [
		'z/DashboardController.php', 'vendor/Http/Controllers/DashboardStatsController.php',
	]);
	assert.equal(quickOpen.truncated, true);
	const sidebar = await listFilesDetailed(root, 'DashboardController', new AbortController().signal);
	assert.deepEqual(sidebar.files.slice(0, 2), quickOpen.files);
	const terms = await searchFilePathIndex(root, 'controllers DshbrdCtrlr', { matchMode: 'fuzzy' });
	assert.deepEqual(terms.files.map((file) => path.relative(root, file)), ['vendor/Http/Controllers/DashboardStatsController.php']);
});

test('empty quick-open query lists files and fuzzy search retains hidden/glob/worktree filters', async (t) => {
	const root = await fixture(t);
	const names = ['DashboardController.php', '.hidden/DashboardController.php', 'worktrees/branch/DashboardController.php', 'src/DashboardStatsController.ts'];
	await Promise.all(names.map(async (name) => {
		await mkdir(path.dirname(path.join(root, name)), { recursive: true });
		await writeFile(path.join(root, name), '');
	}));
	const options = { matchMode: 'fuzzy', showHidden: false };
	const initial = await searchFilePathIndex(root, '', options);
	assert.deepEqual(initial.files.map((file) => path.relative(root, file)), [names[0], names[3]]);
	const filtered = await searchFilePathIndex(root, 'DshbrdCtrlr', {
		...options, includeWorktrees: true, includeGlob: '**/*.php', excludeGlob: 'DashboardController.php',
	});
	assert.deepEqual(filtered.files.map((file) => path.relative(root, file)), [names[2]]);
});
