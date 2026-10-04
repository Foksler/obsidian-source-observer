import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { searchEverywhere, symbolResults } from '../src/searchEverywhere.ts';
import { normalizeSearchMode, DoubleShiftGesture } from '../src/searchMode.ts';
import { searchContent, searchContentFallback } from '../src/searchEngine.ts';

async function fixture(t) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'source-observer-everywhere-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, 'src'));
	await writeFile(path.join(root, 'src', 'DashboardController.php'), '<?php\nDashboard needle\n');
	await writeFile(path.join(root, 'src', 'DashboardStatsController.php'), 'Dashboard needle');
	await writeFile(path.join(root, '.hidden.php'), 'needle');
	await mkdir(path.join(root, 'worktrees'));
	await writeFile(path.join(root, 'worktrees', 'DashboardWorktree.php'), 'needle');
	return { root, includeWorktrees: false, showHidden: true, recentFiles: [], actions: [] };
}

async function batches(context, tab, query, options = {}) {
	const results = new Map();
	await searchEverywhere(context, tab, query, options, new AbortController().signal, (batch) => results.set(batch.category, batch));
	return results;
}

function symbol(root, name, kind, line = 0) {
	return { name, kind, uri: pathToFileURL(path.join(root, 'src', 'DashboardController.php')).href,
		range: { start: { line, character: 0 }, end: { line, character: 10 } },
		selectionRange: { start: { line, character: 6 }, end: { line, character: 10 } } };
}

test('settings migration keeps VS Code as default and rejects unknown mode values', () => {
	for (const value of [undefined, null, '', 'vscode', 'other', {}, 1]) assert.equal(normalizeSearchMode(value), 'vscode');
	assert.equal(normalizeSearchMode('phpstorm'), 'phpstorm');
});

test('double Shift requires two plain taps and resets after typing or a modified shortcut', () => {
	const gesture = new DoubleShiftGesture();
	const shift = { key: 'Shift', repeat: false, ctrlKey: false, metaKey: false, altKey: false };
	gesture.keydown(shift);
	assert.equal(gesture.keyup(shift, 0), false);
	gesture.keydown(shift);
	assert.equal(gesture.keyup(shift, 200), true);
	gesture.keydown(shift);
	assert.equal(gesture.keyup(shift, 600), false);
	gesture.keydown(shift);
	assert.equal(gesture.keyup(shift, 1100), false);
	gesture.keydown({ ...shift, key: 'A' });
	gesture.keydown(shift);
	assert.equal(gesture.keyup(shift, 1200), false);
	gesture.keydown({ ...shift, metaKey: true });
	assert.equal(gesture.keyup({ ...shift, metaKey: true }, 1300), false);
	gesture.keydown({ ...shift, repeat: true });
	assert.equal(gesture.keyup(shift, 1350), false);
});

test('Files uses fuzzy ranking and excludes worktrees until explicitly enabled', async (t) => {
	const context = await fixture(t);
	const result = (await batches(context, 'files', 'DashboardController')).get('files');
	assert.deepEqual(result.results.map((item) => item.name), ['DashboardController.php', 'DashboardStatsController.php']);
	assert.equal((await batches(context, 'files', 'DashboardWorktree')).get('files').results.length, 0);
	context.includeWorktrees = true;
	assert.equal((await batches(context, 'files', 'DashboardWorktree')).get('files').results.length, 1);
});

test('empty All query shows valid recent files in recency order and does not start symbol or text scans', async (t) => {
	const context = await fixture(t);
	let symbolCalls = 0;
	context.symbols = async () => { symbolCalls++; return []; };
	const main = path.join(context.root, 'src', 'DashboardController.php');
	context.showHidden = false;
	context.recentFiles = [path.join(context.root, '.hidden.php'), main, main,
		path.join(context.root, 'worktrees', 'DashboardWorktree.php'), '/outside/missing.php'];
	const result = await batches(context, 'all', '');
	assert.deepEqual([...result.keys()], ['files']);
	assert.deepEqual(result.get('files').results.map((item) => item.filePath), [main]);
	assert.equal(symbolCalls, 0);
});

test('Classes excludes methods while Symbols flattens declarations and returns selection coordinates', () => {
	const root = '/project';
	const cls = symbol(root, 'Dashboard', 5, 4);
	cls.children = [symbol(root, 'dashboardMethod', 6, 8)];
	const input = [cls, symbol(root, 'DashboardInterface', 11), symbol(root, 'DashboardEnum', 10), symbol(root, 'Dashboard', 5, 4)];
	const classes = symbolResults(root, input, 'dashboard', true);
	assert.deepEqual(classes.map((item) => item.name), ['Dashboard', 'DashboardEnum', 'DashboardInterface']);
	assert.equal(classes[0].line, 5);
	assert.equal(classes[0].column, 7);
	assert.equal(symbolResults(root, input, 'dashboard', false).length, 4);
});

test('file results publish before a slow language-server response', async (t) => {
	const context = await fixture(t);
	let resolveSymbols;
	context.symbols = () => new Promise((resolve) => { resolveSymbols = resolve; });
	let filesReady;
	const ready = new Promise((resolve) => { filesReady = resolve; });
	const delivered = [];
	const pending = searchEverywhere(context, 'all', 'Dashboard', {}, new AbortController().signal, (batch) => {
		delivered.push(batch.category);
		if (batch.category === 'files') filesReady(batch.results);
	});
	const files = await ready;
	assert.ok(files.length > 0);
	assert.ok(!delivered.includes('symbols'));
	resolveSymbols([symbol(context.root, 'Dashboard', 5)]);
	await pending;
	assert.ok(delivered.includes('symbols'));
});

test('aborting suppresses late language-server batches', async (t) => {
	const context = await fixture(t);
	const controller = new AbortController();
	let resolveSymbols;
	context.symbols = () => new Promise((resolve) => { resolveSymbols = resolve; });
	const delivered = [];
	const pending = searchEverywhere(context, 'symbols', 'Dashboard', {}, controller.signal, (batch) => delivered.push(batch));
	controller.abort();
	resolveSymbols([symbol(context.root, 'Dashboard', 5)]);
	await pending;
	assert.deepEqual(delivered, []);
});

test('provider failure is reported independently without losing file matches', async (t) => {
	const context = await fixture(t);
	context.symbols = async () => { throw new Error('language server offline'); };
	const result = await batches(context, 'all', 'Dashboard');
	assert.ok(result.get('files').results.length > 0);
	assert.match(result.get('symbols').error, /language server offline/);
});

test('Text returns exact coordinates, applies globs and keeps hidden files out before the cap', async (t) => {
	const context = await fixture(t);
	context.showHidden = false;
	await writeFile(path.join(context.root, '.hidden.php'), 'needle\n'.repeat(150));
	const result = (await batches(context, 'text', 'needle', { includeGlob: '**/*.php', excludeGlob: '**/DashboardStats*', wholeWord: true })).get('text');
	assert.equal(result.results.length, 1);
	assert.equal(result.results[0].line, 2);
	assert.equal(result.results[0].column, 11);
	assert.equal(result.truncated, false);
	for (const search of [searchContent, searchContentFallback]) {
		const groups = await search(context.root, { query: 'needle', showHidden: false, limit: 5 }, new AbortController().signal);
		assert.equal(groups.length, 2);
		assert.ok(groups.every((group) => !path.basename(group.filePath).startsWith('.')));
	}
});

test('Actions matches plugin actions without calling unrelated providers and does not execute during search', async (t) => {
	const context = await fixture(t);
	let runs = 0;
	context.actions = [{ id: 'search', name: 'Search in files', run: () => runs++ }, { id: 'back', name: 'Go back', run: () => runs++ }];
	context.symbols = async () => { throw new Error('should not be called'); };
	const result = await batches(context, 'actions', 'search');
	assert.deepEqual([...result.keys()], ['actions']);
	assert.equal(result.get('actions').results[0].action.id, 'search');
	assert.equal(runs, 0);
	result.get('actions').results[0].action.run();
	assert.equal(runs, 1);
});

test('All includes files and every text occurrence in a large single file with exact totals and expandable limits', async (t) => {
	const context = await fixture(t);
	await writeFile(path.join(context.root, 'src', 'DashboardBulk.php'), 'Dashboard\n'.repeat(1300));
	const first = await batches(context, 'all', 'Dashboard', { limit: 13 });
	assert.equal(first.get('files').results.length, 3);
	assert.equal(first.get('files').total, 3);
	assert.equal(first.get('text').total, 1302);
	assert.equal(first.get('text').fileCount, 3);
	assert.equal(first.get('text').results.length, 13);
	assert.equal(first.get('text').truncated, true);
	const expanded = (await batches(context, 'all', 'Dashboard', { limit: 1400 })).get('text');
	assert.equal(expanded.results.length, 1302);
	assert.equal(expanded.truncated, false);
	assert.ok(expanded.results.some((result) => result.line === 1300));
});

test('all open folders and explicit single-folder scope produce different, disambiguated results', async (t) => {
	const first = await fixture(t), second = await fixture(t);
	first.roots = [first.root, second.root];
	const all = await batches(first, 'all', 'Dashboard');
	assert.equal(all.get('files').results.length, 4);
	assert.equal(all.get('text').total, 4);
	assert.deepEqual(new Set(all.get('files').results.map((result) => result.rootPath)), new Set(first.roots));
	assert.ok(all.get('text').results.every((result) => result.detail.includes(' / src/')));
	first.roots = [second.root];
	const scoped = await batches(first, 'all', 'Dashboard');
	assert.equal(scoped.get('text').total, 2);
	assert.ok(scoped.get('files').results.every((result) => result.rootPath === second.root));
});

test('PHP symbols from all folders rank exact names first and retain the owning folder for navigation', async (t) => {
	const first = await fixture(t), second = await fixture(t);
	first.roots = [first.root, second.root];
	first.symbols = async (_query, root) => [symbol(root, root === first.root ? 'DashboardStats' : 'Dashboard', 5)];
	const result = (await batches(first, 'symbols', 'Dashboard')).get('symbols');
	assert.deepEqual(result.results.map((item) => item.name), ['Dashboard', 'DashboardStats']);
	assert.equal(result.results[0].rootPath, second.root);
	assert.equal(result.total, 2);
});

test('overlapping folders and symlink aliases do not duplicate file or text results', async (t) => {
	const context = await fixture(t);
	const alias = `${context.root}-alias`;
	await symlink(context.root, alias);
	t.after(() => rm(alias, { force: true }));
	context.roots = [context.root, path.join(context.root, 'src'), alias];
	const result = await batches(context, 'all', 'Dashboard');
	assert.equal(result.get('files').results.length, 2);
	assert.equal(result.get('text').total, 2);
});

test('regex errors preserve matching file results and a failed folder preserves the other folder results', async (t) => {
	const context = await fixture(t);
	const invalid = await batches(context, 'all', '[', { regex: true });
	assert.match(invalid.get('text').error, /regex|regular expression|parse/i);
	assert.equal(invalid.get('files').error, undefined);
	context.roots = [path.join(context.root, 'missing'), context.root];
	const mixed = await batches(context, 'text', 'Dashboard');
	assert.equal(mixed.get('text').results.length, 2);
	assert.match(mixed.get('text').error, /missing/);
});
