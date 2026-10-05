import assert from 'node:assert/strict';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, mock } from 'node:test';
import { searchContentPage } from '../src/contentSearchPage.ts';
import { resolveRgExecutable, streamRipgrep } from '../src/rgRunner.ts';
import { searchContent } from '../src/searchEngine.ts';
import { collectFilePaths, inventoryFilePaths } from '../src/fileInventory.ts';

// Node runs each test file in its own process, keeping discovery's cached result isolated.
before(() => {
	const access = fs.access;
	mock.method(fs, 'access', async (file, mode) => {
		if (mode === constants.X_OK && path.basename(file) === 'rg') {
			throw Object.assign(new Error('ripgrep unavailable in this test'), { code: 'ENOENT' });
		}
		return access(file, mode);
	});
});
after(() => mock.restoreAll());

async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-observer-no-rg-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	assert.equal(await resolveRgExecutable(), null);
	return root;
}

test('missing ripgrep falls back to exact counts and paging with Unicode and path filters', async (t) => {
	const root = await fixture(t);
	await fs.mkdir(path.join(root, 'src'));
	await fs.writeFile(path.join(root, 'src', 'main.txt'), '😀 Needle needle\n'.repeat(1001));
	await fs.writeFile(path.join(root, 'src', 'skip.txt'), 'needle');
	await fs.writeFile(path.join(root, 'outside.txt'), 'needle');
	const options = { query: 'needle', wholeWord: true, includeGlob: 'src/**', excludeGlob: '**/skip.txt' };
	const page = await searchContentPage(root, options, new AbortController().signal, 2, 2000);
	assert.equal(page.totalMatches, 2002);
	assert.equal(page.totalFiles, 1);
	assert.deepEqual(page.matches.map(({ line, column }) => [line, column]), [[1001, 4], [1001, 11]]);
	const groups = await searchContent(root, { ...options, limit: 2 }, new AbortController().signal);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].matches.length, 2);
	assert.equal(groups.truncated, true);
});

test('missing ripgrep reports invalid regex and cancellation through both search entry points', async (t) => {
	const root = await fixture(t);
	await fs.writeFile(path.join(root, 'source.txt'), 'needle');
	for (const search of [searchContent, searchContentPage]) {
		await assert.rejects(search(root, { query: '[', regex: true }, new AbortController().signal),
			{ name: 'SyntaxError', message: /Invalid regular expression/ });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(search(root, { query: 'needle' }, controller.signal), /cancelled/i);
	}
	await assert.rejects(streamRipgrep(['--json', 'needle', root], new AbortController().signal, () => {}),
		{ code: 'ENOENT', message: /ripgrep executable was not found/ });
});

test('fallback keeps its file-size and binary limits while searching readable source files', async (t) => {
	const root = await fixture(t);
	await fs.writeFile(path.join(root, 'large.txt'), 'needle'.padEnd(5 * 1024 * 1024 + 1, 'x'));
	await fs.writeFile(path.join(root, 'binary.txt'), 'needle\0');
	await fs.writeFile(path.join(root, 'source.txt'), 'needle');
	const page = await searchContentPage(root, { query: 'needle' }, new AbortController().signal);
	assert.equal(page.totalMatches, 1);
	assert.equal(page.totalFiles, 1);
	assert.equal(path.basename(page.matches[0].filePath), 'source.txt');
});

test('filename fallback shares exclusions, skips cycles and bounds its parallel enumeration', async (t) => {
	const root = await fixture(t);
	const names = ['src/Alpha.php', 'vendor/Beta.php', '.hidden/Gamma.php', 'worktrees/branch/Skip.php',
		'unusual[branch]/Skip.php', '.git/Skip.php', 'node_modules/Skip.php'];
	for (const name of names) {
		await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
		await fs.writeFile(path.join(root, name), '');
	}
	await fs.symlink(root, path.join(root, 'src/cycle'), 'dir');
	const signal = new AbortController().signal;
	const roots = [path.join(root, 'unusual[branch]')];
	const full = [];
	await inventoryFilePaths(root, false, roots, signal, (_file, relative) => full.push(relative));
	const expected = ['.hidden/Gamma.php', 'src/Alpha.php', 'vendor/Beta.php'];
	assert.deepEqual(full.sort(), expected);
	assert.deepEqual((await collectFilePaths(root, false, roots, signal, 3)).paths.sort(), expected);
	assert.equal((await collectFilePaths(root, false, roots, signal, 3)).truncated, false);
	assert.equal((await collectFilePaths(root, false, roots, signal, 2)).truncated, true);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(collectFilePaths(root, false, roots, controller.signal, 3), /cancelled/i);
});
