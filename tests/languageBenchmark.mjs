// Process-cold and warm real-server profile, independent of the Obsidian renderer.
// node tests/languageBenchmark.mjs OUTPUT_DIR [FROZEN_BUNDLE]
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir,rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire,syncBuiltinESMExports } from 'node:module';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const [outputArg,frozenBundle]=process.argv.slice(2);if(!outputArg)throw Error('Usage: languageBenchmark.mjs OUTPUT_DIR [FROZEN_BUNDLE]');
const output=path.resolve(outputArg);await mkdir(output,{recursive:true});
const bundle=path.join(output,'language-bundle.mjs'),hash=value=>createHash('sha256').update(value).digest('hex');
if(frozenBundle)await writeFile(bundle,await readFile(frozenBundle));
else await build({stdin:{contents:"export {LspNavigation,phpAdapter,goAdapter} from './tests/helpers/languageBenchmarkAdapter.ts';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:bundle,
 plugins:[{name:'host',setup(api){api.onResolve({filter:/^obsidian$/},()=>({path:'host',namespace:'host'}));api.onLoad({filter:/.*/,namespace:'host'},()=>({contents:'export class App {} export class Component {} export const MarkdownRenderer = {}; export const Platform = {isMacOS:true}; export class SuggestModal {} export class Notice {hide(){}} export class Modal {}',loader:'js'}));}}]});
const child=createRequire(import.meta.url)('node:child_process'),originalSpawn=child.spawn,children=[];
let peakAlive=0;
child.spawn=function(...args){const proc=originalSpawn(...args);const entry={proc,closed:false,done:new Promise(resolve=>proc.once('close',()=>{entry.closed=true;resolve();}))};children.push(entry);peakAlive=Math.max(peakAlive,children.filter(entry=>!entry.closed).length);return proc;};syncBuiltinESMExports();
globalThis.window={setTimeout,clearTimeout};
const {LspNavigation,phpAdapter,goAdapter}=await import(pathToFileURL(bundle).href);
const go=process.env.SOURCE_OBSERVER_GO,gopls=process.env.SOURCE_OBSERVER_GOPLS;assert.ok(go&&gopls,'Both real Go tools are required');
const result={schema:1,rounds:20,warmups:2,profile:'Real process-cold document symbols; 20 warm workspace-symbol requests per server; OS and compiler caches uncontrolled. No renderer or installed-plugin claims.',
 environment:{node:process.version,goVersion:execFileSync(go,['version'],{encoding:'utf8'}).trim(),goplsVersion:execFileSync(gopls,['version'],{encoding:'utf8'}).trim(),intelephenseVersion:JSON.parse(await readFile('node_modules/intelephense/package.json','utf8')).version,harnessSha256:hash(await readFile(import.meta.filename)),bundleSha256:hash(await readFile(bundle))},languages:{}};
const summarize=samples=>{const sorted=[...samples].sort((a,b)=>a-b);return {p50Ms:sorted[Math.ceil(samples.length*.5)-1],p95Ms:sorted[Math.ceil(samples.length*.95)-1],samplesMs:samples};};
const signature=rows=>hash(JSON.stringify(rows.map(row=>({name:row.name,kind:row.kind,file:path.basename(fileURLToPath(row.uri)),range:row.range})).sort((a,b)=>a.name.localeCompare(b.name))));
try {
 for(const language of ['php','go']) {
  const root=path.join(output,'fixtures',language);await mkdir(root,{recursive:true});
  const source=language==='go'?'package fixture\n'+Array.from({length:50},(_,i)=>`func Fixture${String(i).padStart(3,'0')}() int { return ${i} }`).join('\n')+'\n':'<?php\n'+Array.from({length:50},(_,i)=>`class Fixture${String(i).padStart(3,'0')} {}`).join('\n')+'\n';
  const file=path.join(root,language==='go'?'service.go':'Fixture.php');await writeFile(file,source);await writeFile(path.join(root,language==='go'?'go.mod':'composer.json'),language==='go'?'module example.invalid/fixture\ngo 1.21\n':'{"name":"fixture/profile"}');
  const first=[],warm=[],childRssKiB=[],processCounts=[];let firstSignature,warmSignature;
  for(let round=-result.warmups;round<result.rounds;round++) {
   const adapter=language==='go'?goAdapter(go,gopls):phpAdapter(process.execPath,path.resolve('node_modules/intelephense/lib/intelephense.js'),'');
   if(language==='php')adapter.initializationOptions=()=>({storagePath:path.join(output,'cache/php/workspace'),globalStoragePath:path.join(output,'cache/php/global')});
   const startIndex=children.length,navigation=new LspNavigation({app:{},display:async()=>null,beforeJump(){}},[adapter]);navigation.setWorkspaceRoot(root);
   try {
    const start=performance.now(),symbols=await navigation.symbols(undefined,file),elapsed=performance.now()-start;
    assert.equal(symbols.length,50);const actual=signature(symbols);firstSignature??=actual;assert.equal(actual,firstSignature);
    if(round>=0)first.push(elapsed);
    const instances=children.slice(startIndex);assert.equal(instances.length,1);if(round>=0){processCounts.push(instances.length);const rss=execFileSync('ps',['-o','rss=','-p',String(instances[0].proc.pid)],{encoding:'utf8'}).trim();childRssKiB.push(Number(rss));}
    for(let index=0;index<20;index++) {
     const start=performance.now(),rows=await navigation.workspaceSymbols('Fixture'),elapsed=performance.now()-start;
     assert.equal(rows.length,50);const actual=signature(rows);warmSignature??=actual;assert.equal(actual,warmSignature);if(round>=0)warm.push(elapsed);
    }
   } finally {
    navigation.dispose();const closed=Promise.all(children.slice(startIndex).map(entry=>entry.done));let timer;
    try {await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Language process did not close')),5000);})]);}finally{clearTimeout(timer);}
   }
  }
  assert.equal(await readFile(file,'utf8'),source);
  result.languages[language]={fixtureSha256:hash(source),documentSymbolsSha256:firstSignature,workspaceSymbolsSha256:warmSignature,firstProcessRequest:summarize(first),warmWorkspaceRequests:summarize(warm),processCounts,childRssKiB};
 }
 result.lifecycle={spawned:children.length,peakAlive,aliveAfter:children.filter(entry=>!entry.closed).length};assert.equal(result.lifecycle.aliveAfter,0);
 await writeFile(path.join(output,'summary.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({languages:Object.fromEntries(Object.entries(result.languages).map(([key,value])=>[key,{first:value.firstProcessRequest.p50Ms,warm:value.warmWorkspaceRequests.p50Ms}])),lifecycle:result.lifecycle}));
} finally {
 child.spawn=originalSpawn;syncBuiltinESMExports();for(const entry of children)if(!entry.closed)entry.proc.kill();await rm(path.join(output,'fixtures'),{recursive:true,force:true});
}
