// Exit 1 means incompatible evidence or a regression requiring a repeated paired run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const [beforeDir, afterDir] = process.argv.slice(2);
if (!beforeDir || !afterDir) throw new Error('Usage: node tests/compareMigrationBenchmarks.mjs BASELINE_ENGINE_DIR CANDIDATE_ENGINE_DIR');
const before = JSON.parse(await readFile(path.join(beforeDir, 'summary.json'), 'utf8'));
const after = JSON.parse(await readFile(path.join(afterDir, 'summary.json'), 'utf8'));
const findings = [];
assert.deepEqual(before.config, after.config, 'Scenario config differs');
assert.equal(before.environment.harnessSha256, after.environment.harnessSha256, 'Use the same measurement harness for both candidates');
for (const field of ['node', 'platform', 'arch', 'cpu', 'rgVersion', 'gitVersion']) assert.equal(before.environment[field], after.environment[field], `Environment differs: ${field}`);
for (const project of before.reports) {
 const candidate = after.reports.find(item => item.project === project.project);
 assert.ok(candidate, `Missing project ${project.project}`);
 assert.deepEqual(candidate.corpus, project.corpus, `${project.project}: corpus drift; rerun frozen baseline and candidate against one unchanged corpus`);
 for (const [name, metric] of Object.entries(project.metrics)) {
  if (metric.p50Ms === undefined) continue;
  const next = candidate.metrics[name];
  assert.ok(next, `Missing metric ${project.project}/${name}`);
  assert.equal(next.resultSha256, metric.resultSha256, `${project.project}/${name}: result/count/order differs`);
  for (const [statistic, ratio, noiseMs] of [['p50Ms', .10, 2], ['p95Ms', .20, 5]]) {
   const delta = next[statistic] - metric[statistic], allowance = Math.max(noiseMs, metric[statistic] * ratio);
   if (delta > allowance) findings.push({ project: project.project, metric: name, statistic, beforeMs: metric[statistic], afterMs: next[statistic], deltaMs: delta, allowanceMs: allowance });
  }
 }
}
console.log(JSON.stringify({ passed: !findings.length, findings, interpretation: 'A regression flag requires three alternating paired batches on the same corpus; this is a local budget, not a statistical proof.' }, null, 2));
process.exitCode = findings.length ? 1 : 0;
