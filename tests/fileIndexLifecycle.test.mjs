import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

test('cancelling one index waiter preserves the shared build; invalidated pending builds cannot publish stale paths', async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'source-observer-lifecycle-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const outfile = path.join(directory, 'index.mjs');
	const scans = [];
	globalThis.__indexScans = scans;
	t.after(() => { delete globalThis.__indexScans; });
	await build({ entryPoints: ['src/filePathIndex.ts'], bundle: true, platform: 'node', format: 'esm', outfile,
		plugins: [{ name: 'controlled-inventory', setup(api) {
			api.onResolve({ filter: /rgRunner\.ts$/ }, () => ({ path: 'rg', namespace: 'controlled' }));
			api.onLoad({ filter: /.*/, namespace: 'controlled' }, () => ({ contents: `
				export function streamRipgrep(args, signal, visit) {
					return new Promise((resolve, reject) => {
						const abort = () => reject(new Error('Search cancelled'));
						signal.addEventListener('abort', abort, { once: true });
						globalThis.__indexScans.push(files => {
							signal.removeEventListener('abort', abort);
						for (const file of files) if (visit(file) === false) break;
						resolve();
						});
					});
				}
			`, loader: 'js' }));
		} }] });
	const { searchFilePathIndex, invalidateFilePathIndex, clearFilePathIndexes, getFilePathIndexStats } = await import(pathToFileURL(outfile).href);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(searchFilePathIndex('/project', 'A', { signal: controller.signal }), /cancelled/i);
	assert.equal(scans.length, 0);
	const first = new AbortController();
	const cancelled = searchFilePathIndex('/project', 'A', { signal: first.signal });
	const shared = searchFilePathIndex('/project', 'A');
	assert.equal(scans.length, 1);
	first.abort();
	await assert.rejects(cancelled, /cancelled/i);
	scans[0](['/project/A.php']);
	assert.deepEqual((await shared).files, ['/project/A.php']);
	invalidateFilePathIndex('/project');
	const refreshed = searchFilePathIndex('/project', 'A');
	assert.equal(scans.length, 2);
	invalidateFilePathIndex('/project');
	scans[1](['/project/StaleA.php']);
	for (let turn = 0; turn < 10 && scans.length < 3; turn++) await Promise.resolve();
	assert.equal(scans.length, 3);
	scans[2](['/project/FreshA.php']);
	assert.deepEqual((await refreshed).files, ['/project/FreshA.php']);
	invalidateFilePathIndex('/project');
	const abandoned = searchFilePathIndex('/project', 'A');
	clearFilePathIndexes();
	await assert.rejects(abandoned, /cancelled/i);
	assert.equal(getFilePathIndexStats('/project').indexedFiles, 0);
	const reopened = searchFilePathIndex('/project', 'A');
	assert.equal(scans.length, 5);
	scans[4](['/project/ReopenedA.php']);
	assert.deepEqual((await reopened).files, ['/project/ReopenedA.php']);
});
