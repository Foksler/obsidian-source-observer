import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	DEFAULT_EXCLUDED_FILES, createExcludedFileMatcher, excludedFileRgGlobs, normalizeExcludedFiles, setExcludedFiles,
} from '../src/fileExclusions.ts';
import { inventoryFilePaths } from '../src/fileInventory.ts';
import { listFilesDetailed, searchContent } from '../src/searchEngine.ts';

test('exclusions match names at any depth, slash patterns from the folder root, and everything inside a folder', () => {
	const excluded = createExcludedFileMatcher(['.DS_Store', '*.log', '/build/', 'docs/generated', '**/tmp']);
	for (const relative of ['.DS_Store', 'src/.DS_Store', 'debug.log', 'a/b/trace.log', 'build', 'build/out.js',
		'docs/generated/api.md', 'tmp', 'a/tmp/b.ts']) assert.equal(excluded(relative), true, relative);
	for (const relative of ['DS_Store', 'src/.DS_Store.bak', 'log', 'src/build/out.js', 'other/docs/generated/api.md',
		'tmpfile']) assert.equal(excluded(relative), false, relative);
	assert.equal(createExcludedFileMatcher([])('anything'), false);
});

test('ripgrep globs mirror the matcher', () => {
	assert.deepEqual(excludedFileRgGlobs(['.DS_Store', '/build/', './docs/generated']), [
		'!**/.DS_Store', '!**/.DS_Store/**', '!/build', '!/build/**', '!/docs/generated', '!/docs/generated/**',
	]);
});

test('saved exclusions are trimmed and invalid data restores the defaults', () => {
	assert.deepEqual(normalizeExcludedFiles([' .DS_Store ', '', 3, 'build']), ['.DS_Store', 'build']);
	assert.deepEqual(normalizeExcludedFiles(undefined), DEFAULT_EXCLUDED_FILES);
	assert.deepEqual(normalizeExcludedFiles([]), []);
});

test('plugin exclusions apply to the filename inventory, quick open and content search', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'source-observer-exclusions-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const name of ['.DS_Store', 'src/.DS_Store', 'src/app.ts', 'out/main.js', 'src/out/gen.ts']) {
		await mkdir(path.dirname(path.join(root, name)), { recursive: true });
		await writeFile(path.join(root, name), 'needle');
	}
	assert.equal(setExcludedFiles(['.DS_Store', '/out']), true);
	t.after(() => setExcludedFiles([]));
	const expected = ['src/app.ts', 'src/out/gen.ts'];
	const signal = new AbortController().signal;
	const inventory = [];
	await inventoryFilePaths(root, false, [], signal, (_file, relative) => inventory.push(relative));
	assert.deepEqual(inventory.sort(), expected);
	const { files } = await listFilesDetailed(root, '', signal);
	assert.deepEqual(files.map((file) => path.relative(root, file)).sort(), expected);
	const groups = await searchContent(root, { query: 'needle' }, signal);
	assert.deepEqual(groups.map((group) => path.relative(root, group.filePath)).sort(), expected);
});
