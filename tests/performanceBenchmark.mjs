import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { platform, arch, cpus } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Compare the actual plugin entry points, alternating order to reduce cache/order bias.
const [baselinePath, rootPath, roundsArg = '15'] = process.argv.slice(2);
if (!baselinePath || !rootPath) throw new Error('Usage: node tests/performanceBenchmark.mjs BASELINE_SOURCE PROJECT_ROOT [ROUNDS]');
const root = path.resolve(rootPath);
const rounds = Number(roundsArg);
assert.ok(Number.isInteger(rounds) && rounds >= 5);
const load = async (directory) => {
	const from = (file) => import(pathToFileURL(path.resolve(directory, 'src', file)).href);
	return { index: await from('filePathIndex.ts'), engine: await from('searchEngine.ts'), content: await from('contentSearchPage.ts') };
};
const baseline = await load(baselinePath);
const candidate = await load(path.resolve(import.meta.dirname, '..'));
const queries = ['StatsController', 'DshbrdCtrlr', 'controller', 'app service', 'php', 'unlikely-missing-xyz'];
const signature = (result) => createHash('sha256').update(JSON.stringify(result)).digest('hex');
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const measurements = {};
const measure = async (name, run, project = (value) => value, repetitions = 1) => {
	if (process.env.BENCH_CASE && name !== process.env.BENCH_CASE) return;
	const times = { baseline: [], candidate: [] };
	let digest;
	for (let round = -2; round < rounds; round++) {
		for (const key of round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
			const api = key === 'baseline' ? baseline : candidate;
			const start = performance.now();
			let result;
			for (let repeat = 0; repeat < repetitions; repeat++) result = await run(api);
			const elapsed = (performance.now() - start) / repetitions;
			const actual = signature(project(result));
			digest ??= actual;
			assert.equal(actual, digest, `${name}: result/count/order changed (${key}, round ${round})`);
			if (round >= 0) times[key].push(elapsed);
		}
	}
	const summary = (values) => ({ p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), samplesMs: values });
	measurements[name] = { baseline: summary(times.baseline), candidate: summary(times.candidate),
		reductionPercent: (1 - percentile(times.candidate, 0.5) / percentile(times.baseline, 0.5)) * 100, resultSha256: digest };
};
const worktrees = await baseline.engine.getRegisteredWorktrees(root);
const fileOptions = { worktreeRoots: worktrees, limit: 500, showHidden: false };
const inventory = async (api) => {
	const { files, total, truncated, indexedFiles } = await api.index.searchFilePathIndex(root, '',
		{ ...fileOptions, matchMode: 'fuzzy', limit: Number.MAX_SAFE_INTEGER, showHidden: true });
	return { files, total, truncated, indexedFiles };
};
const fullInventory = await inventory(baseline);
assert.ok(fullInventory.indexedFiles > 0, 'Benchmark corpus must contain searchable files');
assert.deepEqual(await inventory(candidate), fullInventory, 'Full inventory/order differs from baseline');
const inventorySha256 = signature(fullInventory);
let indexedFiles;
await measure('forcedIndexBuild', async (api) => {
	api.index.invalidateFilePathIndex(root);
	await api.index.warmFileIndex(root, false, worktrees);
	indexedFiles = api.index.getFilePathIndexStats(root).indexedFiles;
	return { indexedFiles };
});
for (const matchMode of ['fuzzy', 'substring']) {
	await measure(`${matchMode}QueryBatch`, async (api) => {
		const results = [];
		for (const query of queries) {
			const { files, total, truncated } = await api.index.searchFilePathIndex(root, query, { ...fileOptions, matchMode });
			results.push({ query, files, total, truncated });
		}
		return results;
	}, undefined, 3);
}
for (const query of ['StatsController', 'public function']) {
	await measure(`content:${query}`, async (api) => api.content.searchContentPage(root,
		{ query, showHidden: false }, new AbortController().signal, 100));
}
console.log(JSON.stringify({ root, rounds, queries, indexedFiles,
	inventorySha256,
	environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
	method: 'Two warmups, alternating baseline/candidate; median and p95; real filesystem and ripgrep; OS page cache not flushed. Filename query batches contain six distinct queries. Forced builds invalidate the inventory, not disk cache. Result hashes include counts, filters and ordering.',
	measurements }, null, 2));
