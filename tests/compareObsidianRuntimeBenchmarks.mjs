import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [beforeFile,afterFile]=process.argv.slice(2);
const before=JSON.parse(await readFile(beforeFile,'utf8')),after=JSON.parse(await readFile(afterFile,'utf8'));
for(const key of ['rounds','warmups']) assert.equal(before[key],after[key],key);
for(const key of ['node','electron','chrome','appVersion','configSha256','harnessSha256','settings']) assert.deepEqual(before.environment[key],after.environment[key],key);
assert.equal(before.settingsRestored,true);assert.equal(after.settingsRestored,true);
const findings=[], rows=[];
for(const project of before.projects) {
 const candidate=after.projects.find(item=>item.id===project.id);assert.ok(candidate,project.id);assert.equal(candidate.root,project.root);
 for(const [name,metric] of Object.entries(project.metrics)) {
  const next=candidate.metrics[name];assert.ok(next,`${project.id}/${name}`);
  if(metric.skipped) {assert.equal(next.skipped,metric.skipped);continue;}
  assert.deepEqual(next.output,metric.output,`${project.id}/${name} output`);
  rows.push({project:project.id,metric:name,beforeP50:metric.p50Ms,afterP50:next.p50Ms,beforeP95:metric.p95Ms,afterP95:next.p95Ms});
  for(const [statistic,ratio,noise] of [['p50Ms',.1,8],['p95Ms',.2,16]]) {
   const allowance=Math.max(noise,metric[statistic]*ratio),delta=next[statistic]-metric[statistic];
   if(delta>allowance)findings.push({project:project.id,metric:name,statistic,beforeMs:metric[statistic],afterMs:next[statistic],deltaMs:delta,allowanceMs:allowance});
  }
 }
}
console.log(JSON.stringify({passed:!findings.length,findings,rows,interpretation:'Local runtime budget including paint fence. Flags require three alternating paired batches; corpus equality must be established separately.'},null,2));
process.exitCode=findings.length?1:0;
