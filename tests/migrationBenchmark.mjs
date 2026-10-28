// Read-only baseline of real plugin engines. Project paths and queries live in a local JSON config.
// Usage: node tests/migrationBenchmark.mjs CONFIG OUTPUT_DIR [SOURCE_ROOT_OR_FROZEN_BUNDLE]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const percentile = (samples, q) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * q) - 1];
const summarize = samples => ({ p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95), samplesMs: samples });
const git = (root, args) => { try { return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim(); } catch { return null; } };
const [configPath, outputArg, sourceArg] = process.argv.slice(2);
if (!configPath || !outputArg) throw new Error('Usage: node tests/migrationBenchmark.mjs CONFIG OUTPUT_DIR [SOURCE_ROOT_OR_FROZEN_BUNDLE]');
const config = JSON.parse(await readFile(configPath, 'utf8'));
assert.ok(Number.isInteger(config.rounds) && config.rounds >= 20);
const output = path.resolve(outputArg), source = path.resolve(sourceArg ?? path.join(import.meta.dirname, '..'));
await mkdir(output, { recursive: true });
const bundlePath = path.join(output, 'engine-bundle.mjs');
if (source.endsWith('.mjs')) await writeFile(bundlePath, await readFile(source));
else {
 const paths={filePathIndex:'tests/helpers/legacyFileIndex.ts',searchEngine:'tests/helpers/legacySearchEngine.ts',contentSearchPage:'src/search/contentSearchPage.ts',gitDiff:'src/git/gitDiff.ts',treeGitStatus:'src/git/treeGitStatus.ts',sourceFile:'src/files/sourceFile.ts',fileExclusions:'src/files/fileExclusions.ts',rgRunner:'src/files/rgRunner.ts'};
 const entry=Object.entries(paths).map(([name,file])=>`export * as ${name} from ${JSON.stringify(path.join(source,file))};`).join('\n');
 await build({ stdin: { contents: entry, resolveDir: source, loader: 'ts' }, outfile: bundlePath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
}
const api = await import(pathToFileURL(bundlePath).href);
api.fileExclusions.setExcludedFiles(config.excludedFiles);
const rg = await api.rgRunner.resolveRgExecutable();
assert.ok(rg, 'This profile requires ripgrep; fallback must be benchmarked separately');
const environment = { node: process.version, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model,
 cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), osRelease: os.release(), rg,
 rgVersion: execFileSync(rg, ['--version'], { encoding: 'utf8' }).split('\n')[0],
 gitVersion: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
 sourceCommit: source.endsWith('.mjs') ? null : git(source, ['rev-parse', 'HEAD']),
 engineSha256: hash(await readFile(bundlePath)), harnessSha256: hash(await readFile(import.meta.filename)), configSha256: hash(await readFile(configPath)) };
const reports = [];
for (const project of config.projects) {
 const root = project.root, metrics = {}, checks = {};
 api.searchEngine.clearSearchCaches();
 const worktrees = await api.searchEngine.getRegisteredWorktrees(root);
 const options = { worktreeRoots: worktrees, limit: 500, showHidden: false, matchMode: 'fuzzy' };
 const inventory = async () => {
  api.filePathIndex.invalidateFilePathIndex(root);
  const result = await api.filePathIndex.searchFilePathIndex(root, '', { ...options, limit: Number.MAX_SAFE_INTEGER, showHidden: true });
  assert.ok(result.indexedFiles > 0 && !result.truncated, 'Corpus must fit full inventory profile');
  return result.files.map(file => path.relative(root, file)).sort();
 };
 const firstStart = performance.now();
 const paths = await inventory();
 metrics.firstInventory = { elapsedMs: performance.now() - firstStart, samples: 1, meaning: 'First index in this process for this project, OS cache uncontrolled' };
 const corpus = async () => {
  const digests = [], metadata = []; let bytes = 0;
  for (const relative of paths) {
   const file = path.join(root, relative), info = await stat(file);
   bytes += info.size;
   metadata.push([relative, info.size, info.mtimeMs]);
   digests.push([relative, hash(await readFile(file))]);
  }
  return { files: paths.length, bytes, pathsSha256: hash(paths), metadataSha256: hash(metadata), contentsSha256: hash(digests) };
 };
 const before = await corpus();
 const measure = async (name, run, normalize = value => value) => {
  const samples = [], cpuMs = [], rssBytes = []; let signature, expected;
  for (let i = -config.warmups; i < config.rounds; i++) {
   const cpu = process.cpuUsage(), start = performance.now();
   const result = await run();
   const elapsed = performance.now() - start, usage = process.cpuUsage(cpu);
   const normalized = normalize(result), actual = hash(normalized);
   signature ??= actual; expected ??= normalized;
   assert.equal(actual, signature, `${project.id}/${name}: unstable results; rerun on a quiet corpus`);
   if (i >= 0) { samples.push(elapsed); cpuMs.push((usage.user + usage.system) / 1000); rssBytes.push(process.memoryUsage().rss); }
  }
  metrics[name] = { ...summarize(samples), processCpuMs: cpuMs, rssBytes, resultSha256: signature };
  checks[name] = expected;
 };
 await measure('forcedIndexBuild', async () => { api.filePathIndex.invalidateFilePathIndex(root); await api.filePathIndex.warmFileIndex(root, false, worktrees); return api.filePathIndex.getFilePathIndexStats(root).indexedFiles; });
 for (const mode of ['fuzzy', 'substring']) await measure(mode + 'QueryBatch', async () => {
  const results = [];
  for (const query of project.fileQueries) {
   const result = await api.filePathIndex.searchFilePathIndex(root, query, { ...options, matchMode: mode });
   results.push({ query, total: result.total, truncated: result.truncated, pathsSha256: hash(result.files.map(file => path.relative(root, file))) });
  }
  return results;
 });
 for (let i = 0; i < project.textQueries.length; i++) await measure('textQuery' + i, () => api.contentSearchPage.searchContentPage(root,
  { query: project.textQueries[i], showHidden: false, regex: false, includeWorktrees: false }, new AbortController().signal, 100),
  result => ({ totalMatches: result.totalMatches, totalFiles: result.totalFiles, pageSha256: hash(result.matches.map(match => ({ ...match, filePath: path.relative(root, match.filePath) }))) }));
 const directories = [root];
 for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory() && !entry.name.startsWith('.')) directories.push(path.join(root, entry.name));
 await measure('gitStatus', () => api.gitDiff.getChangedFiles(root));
 await measure('treeGitProjection', () => api.treeGitStatus.getTreeGitStatuses(root, directories), result => [...result].map(([key, value]) => [path.relative(root, key), value]).sort());
 await measure('sourceRead', () => api.sourceFile.readSourceText(path.join(root, project.sampleFile)), result => { assert.ok(result); return { editable: result.editable, textSha256: hash(result.content) }; });
 const after = await corpus(), afterPaths = await inventory();
 assert.deepEqual(after, before, `${project.id}: corpus changed during measurements`);
 assert.deepEqual(afterPaths, paths, `${project.id}: inventory changed during measurements`);
 const report = { schema: 1, project, measuredAt: new Date().toISOString(), rounds: config.rounds, warmups: config.warmups,
  environment, corpus: before, gitHead: git(root, ['rev-parse', 'HEAD']), gitStatusSha256: hash(git(root, ['status', '--porcelain=v1', '-z', '-u']) ?? ''),
  worktreeCount: worktrees.length, scope: 'Engine calls in Node, no Obsidian render; OS page cache not flushed; CPU excludes child processes; RSS is process-level, not operation allocation', metrics, checks };
 await writeFile(path.join(output, project.id + '.json'), JSON.stringify(report, null, 2) + '\n');
 reports.push(report);
 console.log(JSON.stringify({ project: project.id, files: before.files, p50: Object.fromEntries(Object.entries(metrics).filter(([, metric]) => metric.p50Ms !== undefined).map(([name, metric]) => [name, Number(metric.p50Ms.toFixed(2))])) }));
}
await writeFile(path.join(output, 'summary.json'), JSON.stringify({ environment, config, reports: reports.map(report => ({ project: report.project.id, corpus: report.corpus, metrics: report.metrics })) }, null, 2) + '\n');
