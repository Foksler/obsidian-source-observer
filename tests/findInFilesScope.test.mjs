import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initialFindState, findModules, moduleForPath, searchFindInFiles } from '../src/findInFilesScope.ts';

async function fixture(t) {
	const parent = await mkdtemp(path.join(os.tmpdir(), 'source-observer-find-'));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = path.join(parent, 'active');
	await mkdir(path.join(root, 'module-a', 'src', 'nested'), { recursive: true });
	await mkdir(path.join(root, 'module-b'), { recursive: true });
	await mkdir(path.join(parent, 'inactive'));
	await writeFile(path.join(root, 'module-a', 'composer.json'), '{}');
	await writeFile(path.join(root, 'module-b', 'composer.json'), '{}');
	await writeFile(path.join(root, 'module-a', 'src', 'main.php'), 'needle needle\n');
	await writeFile(path.join(root, 'module-a', 'src', 'nested', 'extra.php'), 'needle');
	await writeFile(path.join(root, 'module-a', 'src', 'notes.md'), 'needle');
	await writeFile(path.join(root, 'module-b', 'other.php'), 'needle');
	await writeFile(path.join(parent, 'inactive', 'other.php'), 'needle');
	return { root, treeFocused: false, selectedPath: null, currentFile: path.join(root, 'module-a', 'src', 'main.php'),
		openFiles: [path.join(root, 'module-a', 'src', 'main.php'), path.join(parent, 'inactive', 'other.php')],
		includeWorktrees: false, showHidden: true };
}

const search = (context, state, limit) => searchFindInFiles(context, state, new AbortController().signal, limit);

test('Project searches only the active folder; masks intersect path filters and keep exact totals before paging', async (t) => {
	const context = await fixture(t);
	const state = { ...initialFindState(context), query: 'needle' };
	assert.equal((await search(context, state)).totalMatches, 5);
	const filtered = { ...state, maskEnabled: true, fileMask: '*.php', options: { includeGlob: 'module-a/**' } };
	const page = await search(context, filtered, 1);
	assert.equal(page.totalMatches, 3); assert.equal(page.totalFiles, 2); assert.equal(page.matches.length, 1);
	assert.equal((await search(context, filtered, 200)).matches.length, 3);
});

test('Directory takes the keyboard or mouse tree selection, using a selected file parent and respecting recursion', async (t) => {
	const context = await fixture(t);
	context.treeFocused = true;
	context.selectedPath = { path: context.currentFile, isDirectory: false };
	const state = initialFindState(context);
	assert.equal(state.area, 'directory');
	assert.equal(state.directory, path.dirname(context.currentFile));
	state.query = 'needle';
	assert.equal((await search(context, state)).totalMatches, 4);
	state.recursive = false;
	assert.equal((await search(context, state)).totalMatches, 3);
	context.selectedPath = { path: path.join(context.root, 'module-b'), isDirectory: true };
	assert.equal(initialFindState(context, state).directory, context.selectedPath.path);
});

test('Module discovers nested Composer projects and selects the module owning the tree location', async (t) => {
	const context = await fixture(t);
	const modules = await findModules(context);
	assert.deepEqual(modules.sort(), [path.join(context.root, 'module-a'), path.join(context.root, 'module-b')]);
	const module = moduleForPath(modules, context.currentFile);
	assert.equal(module, path.join(context.root, 'module-a'));
	assert.equal((await search(context, { ...initialFindState(context), area: 'module', module, query: 'needle' })).totalMatches, 4);
});

test('Scope searches open or current files without counting other files; custom scopes apply path globs', async (t) => {
	const context = await fixture(t);
	const state = { ...initialFindState(context), area: 'scope', query: 'needle', options: { includeGlob: 'module-b/**' } };
	for (const namedScope of ['open', 'current']) {
		const page = await search(context, { ...state, namedScope });
		assert.equal(page.totalMatches, 2); assert.equal(page.totalFiles, 1);
	}
	assert.equal((await search(context, { ...state, namedScope: 'custom' })).totalMatches, 1);
});

test('Directory cannot escape the active folder through a relative path or symlink and invalid regex is visible', async (t) => {
	const context = await fixture(t);
	const state = { ...initialFindState(context), area: 'directory', query: 'needle' };
	await assert.rejects(search(context, { ...state, directory: '../inactive' }), /inside the active folder/);
	await symlink(path.join(context.root, '..', 'inactive'), path.join(context.root, 'external'), 'dir');
	await assert.rejects(search(context, { ...state, directory: 'external' }), /inside the active folder/);
	await assert.rejects(search(context, { ...state, directory: context.root, query: '[', options: { regex: true } }), /regex|parse/);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(searchFindInFiles(context, state, controller.signal), /cancelled/);
});
