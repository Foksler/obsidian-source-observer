// Official CLI eval acceptance, disposable PHP/Go project. Not a latency comparison.
module.exports=async function(app,tools,outputPath){
 const fs=require('fs'),path=require('path'),os=require('os'),child=require('child_process'),crypto=require('crypto');
 const leaves=app.workspace.getLeavesOfType('source-observer');if(leaves.length!==1)throw Error('Use one Source Observer view');
 const view=require('./helpers/installedViewAccess.cjs')(leaves[0].view),plugin=app.plugins.plugins['source-observer'];if(view.codePane.dirty||view.codePane.conflictPath)throw Error('Resolve the current document first');
 const dataPath=path.join(app.vault.adapter.getBasePath(),app.vault.configDir,'plugins/source-observer/data.json'),bytes=fs.readFileSync(dataPath);
 const original={settings:JSON.parse(JSON.stringify(plugin.settings)),folder:view.repoPath,folders:[...view.folderPaths],sessions:new Map(view.folderSessions),editor:view.codePane.captureSession(),tabs:view.editorTabs.captureState(),search:view.searchPanel.captureState(),treeQuery:view.treeSearchInput.value,changesQuery:view.changesQuery,previews:new Set(view.previewFiles),recent:[...view.recentFiles]};
 const root=fs.realpathSync(fs.mkdtempSync(path.join(tools.fixtureParent??os.tmpdir(),'source-observer-language-'))),children=[],spawn=child.spawn;
 const result={schema:1,profile:'Installed background-first then editor reuse, live-buffer symbols and bounded idle shutdown. Disposable project; no latency comparison. Alternating startup probes avoid the pre-existing Intelephense empty-prefix cache; production query behavior is unchanged.',harnessSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),languages:{},success:false};
 const notify=plugin.languages.notify;result.events=[];plugin.languages.notify=function(event){if(event.type==='failed')result.events.push({type:event.type,message:event.error?.message});return notify.call(this,event);};
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));let editor;
 child.spawn=function(...args){const proc=spawn.apply(this,args);if(args[2]?.cwd===root&&(args[0]===tools.gopls||args[1]?.some(value=>typeof value==='string'&&value.endsWith('/intelephense.js')))){const record={executable:args[0],args:args[1],proc,closed:false,stderr:"",server:[],client:[]};let wire=Buffer.alloc(0);proc.stdout?.on('data',chunk=>{wire=Buffer.concat([wire,chunk]);for(;;){const end=wire.indexOf('\r\n\r\n');if(end<0)break;const size=Number(/Content-Length: (\d+)/i.exec(wire.subarray(0,end).toString())?.[1]);if(!size||wire.length<end+4+size)break;try{const m=JSON.parse(wire.subarray(end+4,end+4+size).toString());record.server.push({sections:m.method==='workspace/configuration'?m.params?.items?.map(i=>i.section):undefined,method:m.method,id:m.id,error:m.error?.message,resultShape:Array.isArray(m.result)?m.result.slice(0,2):undefined,message:['window/showMessageRequest','window/logMessage'].includes(m.method)?String(m.params?.message??'').split(plugin.settings.intelephenseLicence||'\0').join('[redacted]'):undefined,actions:m.method==='window/showMessageRequest'?m.params?.actions?.map(a=>a.title):undefined});}catch{}wire=wire.subarray(end+4+size);}});const write=proc.stdin?.write;if(write)proc.stdin.write=function(data,...rest){try{const text=data.toString(),i=text.indexOf('\r\n\r\n'),m=JSON.parse(text.slice(i+4));record.client.push({method:m.method,id:m.id,error:m.error?.message,configuration:Array.isArray(m.result)?m.result.map(v=>({keys:Object.keys(v??{}),files:v?.files,environment:v?.environment})):undefined});}catch{}return write.call(this,data,...rest);};proc.stderr?.on("data",chunk=>{record.stderr=(record.stderr+chunk.toString()).slice(-1000000);});children.push(record);proc.once('close',()=>{record.closed=true;});}return proc;};
 try{
  fs.writeFileSync(path.join(root,'composer.json'),'{"name":"fixture/project"}');fs.writeFileSync(path.join(root,'go.mod'),'module example.invalid/installed\ngo 1.21\n');
  for(const language of ['php','go']){
   await view.activateFolder('');plugin.settings.phpLsp=language==='php';plugin.settings.goLsp=language==='go';plugin.settings.goPath=tools.go;plugin.settings.goplsPath=tools.gopls;plugin.settings.includeWorktrees=false;view.syncNavigation();
   const file=path.join(root,language==='go'?'service.go':'Example.php'),before=language==='go'?'package fixture\nfunc FixtureBefore() int { return 1 }\n':'<?php\nclass FixtureBefore {}\n';fs.writeFileSync(file,before);
   const first=children.length,deadline=performance.now()+5000;
   await view.searchSymbols('Fixture',root);
   const manager=view.searchLsps.get(root);if(!manager)throw Error('Background manager unavailable');
   let startupResets=0;let background=[];do{background=await view.searchSymbols('Fixture',root);if(background.some(s=>s.name==='FixtureBefore'))break;if(performance.now()>deadline){const all=await manager.workspaceSymbols('');result.backgroundDebug={count:background.length,names:background.map(s=>s.name),allNames:all.map(s=>s.name).slice(0,20),registry:plugin.languages.diagnostics(),stderr:children.slice(first).map(c=>c.stderr.split('\n').filter(s=>s.length<500).slice(-12)),protocol:children.slice(first).map(c=>({server:c.server,client:c.client}))};throw Error(language+' background symbols unavailable');}await manager.workspaceSymbols('__SourceObserverResetProbe');startupResets++;await sleep(100);}while(true);
   if(children.length-first!==1)throw Error(language+' background created unexpected processes');
   await view.activateFolder(root);await view.openTab({filePath:file,kind:'code'});editor=await view.codePane.open(file);if(!editor)throw Error('Editor unavailable');
   const initial=await view.languageNavigation.symbols(undefined,file);if(!initial.some(s=>s.name==='FixtureBefore'))throw Error(language+' document symbols unavailable');
   if(children.length-first!==1){result.reuseDebug={children:children.slice(first).map(c=>({executable:c.executable,args:c.args})),registry:plugin.languages.diagnostics(),keys:[...plugin.languages.registry.entries.keys()],activeShared:view.languageNavigation.runtime===plugin.languages,backgroundShared:manager.runtime===plugin.languages,activeIncludes:view.languageNavigation.languages.map(x=>x.lsp.opts.includeWorktrees),backgroundIncludes:manager.languages.map(x=>x.lsp.opts.includeWorktrees)};throw Error(language+' editor did not reuse background server');}
   editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:before.replace('FixtureBefore','FixtureAfter')}});
   const live=await view.languageNavigation.symbols(undefined,file);if(!live.some(s=>s.name==='FixtureAfter')||live.some(s=>s.name==='FixtureBefore'))throw Error(language+' unsaved symbols stale');
   if(fs.readFileSync(file,'utf8')!==before)throw Error(language+' disk changed before live-buffer acceptance');
   result.languages[language]={processesStarted:children.length-first,backgroundFound:true,startupCacheResetProbes:startupResets,editorReused:true,unsavedSymbols:true,diskUnchanged:true};
   editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:before}});await view.codePane.save();editor=null;
  }
  await view.activateFolder('');const deadline=performance.now()+40000;
  while(children.some(c=>!c.closed)){if(performance.now()>deadline)throw Error('Fixture servers did not close under idle policy');await sleep(25);}
  result.lifecycle={spawned:children.length,aliveAfter:children.filter(c=>!c.closed).length};if(children.length!==2)throw Error('Expected exactly one process per language');result.success=true;
 }finally{
  try{
   if(editor&&view.codePane.getCurrentFile()?.startsWith(root+path.sep)){const file=view.codePane.getCurrentFile();editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:fs.readFileSync(file,'utf8')}});await view.codePane.save();}
   await view.activateFolder('');plugin.settings=original.settings;view.folderPaths=original.folders;view.folderSessions=original.sessions;view.previewFiles=original.previews;
   if(original.folder)view.folderSessions.set(original.folder,{editor:original.editor,tabs:original.tabs,search:original.search,treeQuery:original.treeQuery,changesQuery:original.changesQuery});
   await view.activateFolder(original.folder);view.recentFiles=original.recent;plugin.settings=original.settings;fs.writeFileSync(dataPath,bytes);result.settingsRestored=fs.readFileSync(dataPath).equals(bytes);
  }finally{child.spawn=spawn;plugin.languages.notify=notify;fs.rmSync(root,{recursive:true,force:true});result.fixtureRemoved=!fs.existsSync(root);fs.writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n');}
 }
 return JSON.stringify(result);
};
