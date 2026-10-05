import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

test('a filename beyond the bounded shared index is still found and ranked before loading more', async (t) => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'source-observer-index-overflow-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const bundle = path.join(dir, 'index.mjs');
	await build({ entryPoints: ['src/filePathIndex.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle,
		plugins: [{ name: 'large-inventory', setup(api) {
			api.onResolve({ filter: /rgRunner\.ts$/ }, () => ({ path: 'rg', namespace: 'inventory' }));
			api.onLoad({ filter: /.*/, namespace: 'inventory' }, () => ({ contents: `
				export async function streamRipgrep(args, signal, visit) {
					for (let i = 0; i < 250001; i++) if (visit('/project/early/F' + i + '.php') === false) return;
					visit('/project/z/AuthController.php');
					visit('/project/a/AuthController/Other.php');
				}
			`, loader: 'js' }));
		} }] });
	const { searchFilePathIndex } = await import(pathToFileURL(bundle).href);
	const first = await searchFilePathIndex('/project', 'AuthController', { matchMode: 'fuzzy', limit: 1 });
	assert.equal(first.indexedFiles, 250000);
	assert.deepEqual(first.files, ['/project/z/AuthController.php']);
	assert.equal(first.total, 2);
	assert.equal(first.truncated, true);
	const expanded = await searchFilePathIndex('/project', 'AuthController', { matchMode: 'fuzzy', limit: 3 });
	assert.equal(expanded.files.length, 2);
	assert.equal(expanded.truncated, false);
});
