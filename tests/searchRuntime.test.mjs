import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SearchRuntime } from '../src/search/SearchRuntime.ts';
import { createFilePathIndex } from './helpers/legacyFileIndex.ts';
import { searchEverywhere } from '../src/search/searchEverywhere.ts';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t) {
 const root = await mkdtemp(path.join(os.tmpdir(), 'source-observer-search-runtime-'));
 t.after(() => rm(root, {recursive: true, force: true})); return root;
}

test('two consumers borrow one build; aborting one leaves the other and the warm index intact', async () => {
 const gate = deferred(), entered = deferred(); let builds = 0;
 const index = createFilePathIndex({collect: async () => { builds++; entered.resolve(); await gate.promise; return {paths:['one.ts'],truncated:false}; }, scan: async () => {}});
 const runtime = new SearchRuntime(async () => [], index);
 const abort = new AbortController();
 const a = runtime.files('/project', 'one', {signal:abort.signal});
 const b = runtime.files('/project', 'one');
 await entered.promise;
 abort.abort(); await assert.rejects(a, /cancelled/);
 assert.equal(runtime.diagnostics().pendingBuilds, 1);
 gate.resolve(); assert.equal((await b).files[0], '/project/one.ts');
 assert.equal((await runtime.files('/project', 'one')).files.length, 1);
 assert.equal(builds, 1); assert.equal(runtime.diagnostics().sessions, 0);
 runtime.dispose();
});

test('request options, exclusions and revision remain captured across pending discovery and settings changes', async t => {
 const root = await fixture(t); await writeFile(path.join(root,'keep.txt'),'needle'); await writeFile(path.join(root,'skip.txt'),'needle');
 const gate = deferred(); const runtime = new SearchRuntime(async () => gate.promise); t.after(() => runtime.dispose());
 runtime.setExcludedFiles(['skip.txt']);
 const options = {query:'needle', includeGlob:'*.txt'};
 const session = runtime.begin(root,options); const old = session.page();
 options.query = 'absent'; options.includeGlob = '*.php'; runtime.setExcludedFiles(['keep.txt']);
 gate.resolve([]);
 const result = await old; assert.equal(result.totalKind,'exact'); assert.equal(result.totalMatches,1);
 assert.equal(path.basename(result.matches[0].filePath),'keep.txt'); assert.equal(session.options.query,'needle');
 assert.equal(session.revision,1); session.dispose();
 const next = await runtime.page(root,{query:'needle'},new AbortController().signal);
 assert.equal(path.basename(next.matches[0].filePath),'skip.txt');
});

test('index keys distinguish topology and exclusions without relying on hidden UI settings', async t => {
 const root = await fixture(t); await mkdir(path.join(root,'linked')); await writeFile(path.join(root,'linked','one.txt'),''); await writeFile(path.join(root,'one.txt'),'');
 let roots = []; const runtime = new SearchRuntime(async () => roots); t.after(() => runtime.dispose());
 assert.equal((await runtime.files(root,'one')).files.length,2);
 roots = [path.join(root,'linked')]; assert.equal((await runtime.files(root,'one')).files.length,1);
 runtime.setExcludedFiles(['one.txt']); assert.equal((await runtime.files(root,'one')).files.length,0);
 runtime.setExcludedFiles([]); assert.equal((await runtime.files(root,'one',{includeWorktrees:true})).files.length,2);
});

test('bounded inventory overflow searches beyond 250k with exact fuzzy totals and stable ranking', async () => {
 const paths = Array.from({length:250001}, (_,i) => `${String(i).padStart(6,'0')}-file.ts`);
 const index = createFilePathIndex({collect:async (_r,_w,_roots,_s,limit) => ({paths:paths.slice(0,limit),truncated:paths.length>limit}),
  scan:async (root,_w,_roots,signal,visit) => { for (const p of paths) { if(signal.aborted) throw Error('Search cancelled'); visit(path.join(root,p),p); } }});
 const last = await index.searchFilePathIndex('/project','250000-file',{matchMode:'fuzzy',limit:1});
 assert.equal(last.indexedFiles,250000); assert.equal(last.total,1); assert.equal(last.totalKind,'exact'); assert.deepEqual(last.files,['/project/250000-file.ts']);
 const capped = await index.searchFilePathIndex('/project','file',{matchMode:'fuzzy',limit:2});
 assert.equal(capped.total,250001); assert.equal(capped.truncated,true); assert.equal(capped.totalKind,'exact'); index.dispose();
});

test('canonical aliases share inventory and preserve each consumer display paths', async t => {
 const parent = await fixture(t), root = path.join(parent,'real'), alias = path.join(parent,'alias');
 await mkdir(root); await writeFile(path.join(root,'one.txt'),''); await symlink(root,alias);
 const runtime = new SearchRuntime(async () => []); t.after(() => runtime.dispose());
 assert.deepEqual((await runtime.files(root,'one')).files,[path.join(root,'one.txt')]);
 assert.deepEqual((await runtime.files(alias,'one')).files,[path.join(alias,'one.txt')]);
 assert.equal(runtime.diagnostics().indexes,1);
});

test('cancel/dispose while discovery is pending releases requests promptly and never starts an index later', async () => {
 const gate = deferred(); const runtime = new SearchRuntime(async () => gate.promise);
 const pending = runtime.files('/project','one'); runtime.dispose();
 await assert.rejects(pending,/cancelled/); assert.equal(runtime.diagnostics().sessions,0);
 gate.resolve([]); await new Promise(r=>setImmediate(r)); assert.equal(runtime.diagnostics().pendingBuilds,0);
 await assert.rejects(runtime.warm('/project'), /disposed/); assert.throws(()=>runtime.begin('/project',{query:'x'}),/disposed/);
});

test('files and actions publish before a blocked language provider and keep exact text totals', async t => {
 const root = await fixture(t); await writeFile(path.join(root,'needle.txt'),'😀 needle needle');
 const runtime = new SearchRuntime(async () => []); t.after(()=>runtime.dispose());
 const gate = deferred(), published = deferred(), batches = [];
 const pending = searchEverywhere({root,search:runtime,includeWorktrees:false,showHidden:true,recentFiles:[],actions:[{id:'needle',name:'needle',run(){}}],symbols:()=>gate.promise},
  'all','needle',{},new AbortController().signal,b=>{batches.push(b);if(batches.some(b=>b.category==='files')&&batches.some(b=>b.category==='text'))published.resolve();});
 await published.promise; assert.ok(batches.some(b=>b.category==='actions')); assert.equal(batches.find(b=>b.category==='text').total,2);
 gate.resolve([]); await pending; assert.equal(runtime.diagnostics().sessions,0);
});

test('substring caps declare unknown totals while complete and fuzzy inventories are exact', async t => {
 const root = await fixture(t); for(let i=0;i<3;i++) await writeFile(path.join(root,`needle${i}.txt`),'needle');
 const runtime = new SearchRuntime(async()=>[]); t.after(()=>runtime.dispose());
 assert.equal((await runtime.files(root,'needle',{limit:1})).totalKind,'unknown');
 assert.equal((await runtime.files(root,'needle',{limit:1,matchMode:'fuzzy'})).total,3);
 assert.equal((await runtime.content(root,{query:'needle',limit:1},new AbortController().signal)).totalKind,'unknown');
 assert.equal((await runtime.page(root,{query:'needle'},new AbortController().signal,1)).totalMatches,3);
});

test('runtime streams more than 8 MiB and preserves Unicode coordinates and exact totals with bounded previews', async t => {
 const root = await fixture(t); await writeFile(path.join(root,'large.txt'),`${'😀'.repeat(150000)} needle\n`.repeat(16));
 const runtime = new SearchRuntime(async()=>[]); t.after(()=>runtime.dispose());
 const page = await runtime.page(root,{query:'needle'},new AbortController().signal,2,14);
 assert.equal(page.totalKind,'exact'); assert.equal(page.totalMatches,16);
 assert.deepEqual(page.matches.map(m=>[m.line,m.column]),[[15,300002],[16,300002]]);
 assert.ok(page.matches.every(m=>m.text.length<=242));
});
