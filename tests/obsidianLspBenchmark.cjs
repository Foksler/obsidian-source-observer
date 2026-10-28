// Official CLI eval: measures the existing PHP workspace-symbol path; never edits project files.
module.exports = async function run(app, configPath, outputPath) {
 const fs = require('fs'), crypto = require('crypto');
 const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
 const view = require('./helpers/installedViewAccess.cjs')(app.workspace.getLeavesOfType('source-observer')[0]?.view);
 const plugin = app.plugins.plugins['source-observer'];
 if (!view || !plugin.settings.phpLsp) throw new Error('Open Source Observer with PHP enabled');
 const project = config.projects.find(item => item.id === 'gloriamin');
 const existing = new Map(view.searchLsps), samples = [], counts = [];
 const query = 'Prediction';
 const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
 const symbolHash=rows=>hash(rows.map(row=>({name:row.name,kind:row.kind,uri:row.uri,range:row.range,selectionRange:row.selectionRange,children:row.children})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
 // Check all regular PHP/PHTML files and Composer manifests, without persisting contents.
 const corpus=()=>{const rows=[],links=[];const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(['.git','.obsidian','node_modules'].includes(entry.name))continue;
  const file=require('path').join(dir,entry.name),relative=require('path').relative(project.root,file);
  if(entry.isSymbolicLink()){links.push([relative,fs.readlinkSync(file)]);continue;}
  if(entry.isDirectory())walk(file);else if(entry.isFile()&&(/\.(php|phtml)$/i.test(entry.name)||/^composer\.(json|lock)$/.test(entry.name)))rows.push([relative,hash(fs.readFileSync(file))]);
 }};walk(project.root);return {files:rows.length,sha256:hash(rows),symlinksSha256:hash(links)};};

 const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
 const result = { schema: 2, project: project.id, root: project.root, query, startedAt: new Date().toISOString(),
  harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  profile: 'PHP background workspace symbols through installed SourceObserverView.searchSymbols; first request includes startup/indexing wait; OS cache uncontrolled; not textDocument/didChange acceptance',
  go: { measured: false, reason: 'Go disabled in current profile; gopls not present on shell PATH' } };
 try {
  result.corpusBefore=corpus();
  const first = performance.now();
  const symbols = await view.searchSymbols(query, project.root);
  result.firstRequest = { elapsedMs: performance.now() - first, symbols: symbols.length, symbolsSha256:symbolHash(symbols) };
  for (let i = -config.warmups; i < config.rounds; i++) {
   const start = performance.now(), rows = await view.searchSymbols(query, project.root);
   if (i >= 0) { samples.push(performance.now() - start); counts.push(rows.length); const signature=symbolHash(rows); if(signature!==result.firstRequest.symbolsSha256)throw Error('Workspace symbol coverage changed during measurement'); }
  }
  result.warmRequests = { p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95), samplesMs: samples, symbolCounts: counts,
   stableNonemptyResults: counts.every(count => count === counts[0]) && counts[0] > 0 };
  result.corpusAfter=corpus();if(JSON.stringify(result.corpusBefore)!==JSON.stringify(result.corpusAfter))throw Error('PHP corpus drift during profile');
 } finally {
  for (const [root, manager] of view.searchLsps) if (!existing.has(root)) { manager.dispose(); view.searchLsps.delete(root); }
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
 }
 return JSON.stringify(result);
};
