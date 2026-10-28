// Official CLI eval. Read-only folder switching; plugin-owned resources only, no heap-leak inference.
module.exports=async function(app,configPath,outputPath){
 const fs=require('fs'),path=require('path'),crypto=require('crypto'),config=JSON.parse(fs.readFileSync(configPath,'utf8'));
 const leaves=app.workspace.getLeavesOfType('source-observer');if(leaves.length!==1)throw Error('Use one Source Observer view for this resource profile');
 const view=require('./helpers/installedViewAccess.cjs')(leaves[0].view),plugin=app.plugins.plugins['source-observer'];if(view.codePane.dirty || view.codePane.conflictPath)throw Error('Resolve the current document first');
 const dataPath=path.join(app.vault.adapter.getBasePath(),app.vault.configDir,'plugins/source-observer/data.json'),bytes=fs.readFileSync(dataPath);
 const original={settings:JSON.parse(JSON.stringify(plugin.settings)),folder:view.repoPath,folders:[...view.folderPaths],sessions:new Map(view.folderSessions),editor:view.codePane.captureSession(),tabs:view.editorTabs.captureState(),search:view.searchPanel.captureState(),treeQuery:view.treeSearchInput.value,changesQuery:view.changesQuery,previews:new Set(view.previewFiles),recent:[...view.recentFiles]};
 const result={schema:1,profile:'Read-only repeated activate/close; PHP/Go disabled temporarily. Candidate counters are plugin-owned resources; renderer heap is a whole-process observation.',rounds:20,samples:[],harnessSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')};
 const snapshot=()=>({files:plugin.observations?.diagnostics()??{watchers:view.watchers.length,polls:view.pollTimer===null?0:1},git:plugin.repositories?.diagnostics()??null,topology:plugin.worktrees?.diagnostics()??null,search:plugin.search?.diagnostics()??null,documents:plugin.documents?{identities:plugin.documents.documents.size,leases:plugin.documents.leases.size,opening:plugin.documents.opening.size,observers:plugin.documents.observers.size,bindings:plugin.documents.bindings.size,recoveries:plugin.documents.recoveries().length}:null,language:plugin.languages?.diagnostics()??null,heapBytes:performance.memory?.usedJSHeapSize??null});
 const settle=async()=>{const start=performance.now();while(plugin.repositories?.diagnostics().activeCommands || plugin.worktrees?.diagnostics().activeScans || plugin.search?.diagnostics().pendingBuilds || plugin.documents?.opening.size){if(performance.now()-start>5000)throw Error('Git commands did not settle');await new Promise(resolve=>setTimeout(resolve,10));}return performance.now()-start;};
 try {
  plugin.settings.phpLsp=false;plugin.settings.goLsp=false;view.syncNavigation();
  for(let round=0;round<result.rounds;round++)for(const project of config.projects){
   await view.activateFolder(project.root);const active=snapshot();await view.activateFolder('');const settledMs=await settle(),closed=snapshot();
   if(closed.files.watchers!==0 || closed.files.polls!==0 || (closed.files.scopes??0)!==0 || (closed.files.timers??0)!==0)throw Error('Folder resources remain after close');
   if(closed.git && (closed.git.repositories>32 || closed.git.discoveries>128 || closed.git.contexts>32))throw Error('Git caches exceeded their bounds');
   if(closed.search && (closed.search.sessions!==0 || closed.search.indexes>4 || closed.search.canonicalPaths>128 || closed.search.pendingBuilds!==0))throw Error('Search resources did not settle or exceeded cache bounds');
   if(closed.documents&&(closed.documents.leases||closed.documents.opening||closed.documents.observers||closed.documents.bindings||closed.documents.identities>closed.documents.recoveries))throw Error('Detached clean document resources remain after folder close');
   result.samples.push({round,project:project.id,active,closed,settledMs});
  }
 } finally {
  await view.activateFolder('');plugin.settings=original.settings;view.folderPaths=original.folders;view.folderSessions=original.sessions;view.previewFiles=original.previews;
  if(original.folder)view.folderSessions.set(original.folder,{editor:original.editor,tabs:original.tabs,search:original.search,treeQuery:original.treeQuery,changesQuery:original.changesQuery});
  await view.activateFolder(original.folder);view.recentFiles=original.recent;plugin.settings=original.settings;fs.writeFileSync(dataPath,bytes);
  result.settingsRestored=fs.readFileSync(dataPath).equals(bytes);fs.writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n');
 }
 return JSON.stringify({samples:result.samples.length,settingsRestored:result.settingsRestored,allClosed:result.samples.every(sample=>sample.closed.files.watchers===0&&sample.closed.files.polls===0)});
};
