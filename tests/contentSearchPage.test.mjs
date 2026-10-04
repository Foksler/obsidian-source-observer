import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { searchContentPage } from '../src/contentSearchPage.ts';
import { streamRipgrep } from '../src/rgRunner.ts';
import { searchContent, searchContentFallback } from '../src/searchEngine.ts';

async function fixture(t, text) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'source-observer-page-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(path.join(root, 'source.txt'), text);
	return root;
}

test('counts every occurrence beyond 1000, pages through a single file and preserves columns', async (t) => {
	const root = await fixture(t, 'needle needle\n'.repeat(2001));
	const page = await searchContentPage(root, { query: 'needle' }, new AbortController().signal, 3, 1999);
	assert.equal(page.totalMatches, 4002);
	assert.equal(page.totalFiles, 1);
	assert.deepEqual(page.matches.map(({ line, column }) => [line, column]), [[1000, 8], [1001, 1], [1001, 8]]);
});

test('JSON output exceeding the old 8 MiB cap is fully counted while previews remain bounded', async (t) => {
	const root = await fixture(t, `${'x'.repeat(600_000)}needle\n`.repeat(16));
	const page = await searchContentPage(root, { query: 'needle' }, new AbortController().signal, 2, 14);
	assert.equal(page.totalMatches, 16);
	assert.deepEqual(page.matches.map((match) => match.line), [15, 16]);
	assert.ok(page.matches.every((match) => match.column === 600_001 && match.text.length <= 242 && match.text.includes('needle')));
});

test('Unicode coordinates and case, word, regex and glob filters match the original source', async (t) => {
	const root = await fixture(t, '😀 Needles Needle needle\n');
	const search = (options) => searchContentPage(root, options, new AbortController().signal);
	const insensitive = await search({ query: 'needle', wholeWord: true });
	assert.deepEqual(insensitive.matches.map((match) => match.column), [12, 19]);
	assert.equal((await search({ query: 'Needle', caseSensitive: true, wholeWord: true })).totalMatches, 1);
	assert.equal((await search({ query: 'N[a-z]+', regex: true, caseSensitive: true })).totalMatches, 2);
	assert.equal((await search({ query: 'needle', excludeGlob: '**/*.txt' })).totalMatches, 0);
	await assert.rejects(search({ query: '[', regex: true }), /regex|parse/i);
});

test('folder-relative include and exclude globs work outside the host working directory in both search modes', async (t) => {
	const parent = await fixture(t, 'needle outside the selected root');
	const root = path.join(parent, 'project [with spaces]');
	await mkdir(path.join(root, 'app', 'nested'), { recursive: true });
	await mkdir(path.join(root, 'routes'));
	await writeFile(path.join(root, 'app', 'main.php'), 'needle needle');
	await writeFile(path.join(root, 'app', 'nested', 'skip.php'), 'needle');
	await writeFile(path.join(root, 'routes', 'api.php'), 'needle');
	for (const options of [
		{ query: 'needle', includeGlob: 'app/**,routes/**', excludeGlob: 'app/nested/**' },
		{ query: 'needle', excludeGlob: 'app/nested/**' },
	]) {
		const signal = new AbortController().signal;
		const page = await searchContentPage(root, options, signal);
		const expected = [['app/main.php', 1, 1], ['app/main.php', 1, 8], ['routes/api.php', 1, 1]];
		const coordinates = (matches) => matches.map(({ filePath, line, column }) => [path.relative(root, filePath), line, column]).sort();
		assert.equal(page.totalMatches, 3);
		assert.equal(page.totalFiles, 2);
		assert.deepEqual(coordinates(page.matches), expected);
		for (const search of [searchContent, searchContentFallback]) {
			assert.deepEqual(coordinates((await search(root, options, signal)).flatMap((group) => group.matches)), expected);
		}
	}
});

test('aborting a live stream rejects and a consumer error is propagated without escaping the process callback', async (t) => {
	const root = await fixture(t, 'needle\n'.repeat(2001));
	const controller = new AbortController();
	await assert.rejects(streamRipgrep(['--json', 'needle', root], controller.signal, () => controller.abort()), /cancelled/i);
	await assert.rejects(streamRipgrep(['--json', 'needle', root], new AbortController().signal,
		() => { throw new Error('consumer failed'); }), /consumer failed/);
});
