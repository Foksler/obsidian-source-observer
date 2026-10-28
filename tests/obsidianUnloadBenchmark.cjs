// Installed-runtime teardown proof. Owns only a disposable project and restores the exact UI/data session.
exports.start=async function(app,tools){
 const fs=require('fs'),path=require('path'),child=require('child_process');
 delete require.cache[require.resolve('./helpers/installedSession.cjs')];
 await require('./helpers/installedSession.cjs')(app,'capture');await require('./helpers/installedSession.cjs')(app,'restore');
 const view=app.workspace.getLeavesOfType('source-observer')[0].view,plugin=app.plugins.plugins['source-observer'];
 const root=fs.mkdtempSync('/private/tmp/so-unload-'),spawn=child.spawn,children=[];
 const probe=app.__soUnloadProbe={root,children,plugin,view,spawn,stopped:false};
 child.spawn=function(...args){const proc=spawn.apply(this,args);if(args[2]?.cwd===root&&(args[0]===tools.gopls||args[1]?.some(value=>String(value).endsWith('/intelephense.js')))){const record={closed:false};children.push(record);proc.once('close',()=>record.closed=true);}return proc;};
 try{
  fs.writeFileSync(path.join(root,'composer.json'),'{}');fs.writeFileSync(path.join(root,'go.mod'),'module example.invalid/unload\ngo 1.21\n');
  fs.writeFileSync(path.join(root,'Fixture.php'),'<?php\nclass UnloadFixture {}\n');fs.writeFileSync(path.join(root,'fixture.go'),'package fixture\nfunc UnloadFixture() {}\n');
  await view.activateFolder('');plugin.settings.phpLsp=true;plugin.settings.goLsp=true;plugin.settings.goPath=tools.go;plugin.settings.goplsPath=tools.gopls;view.syncNavigation();
  await view.searchSymbols('UnloadFixture',root);
  probe.before=plugin.languages.diagnostics();if(children.length!==2||children.some(c=>c.closed)||probe.before.running!==2)throw Error('Expected two live servers before unload');
  await app.__soMigrationSession.leaf.setViewState({type:'empty'});
  fs.writeFileSync(path.join(app.vault.adapter.getBasePath(),app.vault.configDir,'plugins/source-observer/data.json'),app.__soMigrationSession.data);
  return JSON.stringify({childrenAlive:children.length,registry:probe.before});
 }finally{child.spawn=spawn;}
};
exports.finish=async function(app,output){
 const fs=require('fs'),path=require('path'),crypto=require('crypto'),probe=app.__soUnloadProbe;if(!probe)throw Error('Missing unload probe');
 const old=probe.plugin,deadline=performance.now()+6000;
 while(probe.children.some(c=>!c.closed)||old.languages.diagnostics().closing||old.repositories.diagnostics().activeCommands||old.worktrees.diagnostics().activeScans||old.search.diagnostics().pendingBuilds||old.documents.opening.size){if(performance.now()>deadline)throw Error('Old plugin resources did not stop');await new Promise(r=>setTimeout(r,10));}
 const documents={stopped:old.documents.stopped,identities:old.documents.documents.size,leases:old.documents.leases.size,opening:old.documents.opening.size,observers:old.documents.observers.size,bindings:old.documents.bindings.size};
 const result={before:probe.before,after:{files:old.observations.diagnostics(),git:old.repositories.diagnostics(),worktrees:old.worktrees.diagnostics(),search:old.search.diagnostics(),language:old.languages.diagnostics(),documents},childrenStarted:probe.children.length,childrenAlive:probe.children.filter(c=>!c.closed).length};
 if(result.childrenAlive||Object.entries(result.after.language).some(([key,value])=>key!=='stopped'&&value!==0)||!result.after.language.stopped)throw Error('Language resources remain');
 for(const [owner,fields]of Object.entries({files:['scopes','watchers','timers','polls'],git:['repositories','discoveries','contexts','activeCommands'],worktrees:['roots','activeScans'],search:['indexes','canonicalPaths','sessions','pendingBuilds'],documents:['identities','leases','opening','observers','bindings']}))for(const field of fields)if(result.after[owner][field]!==0)throw Error(owner+'/'+field+' remains');
 await require('./helpers/installedSession.cjs')(app,'restore');
 fs.rmSync(probe.root,{recursive:true});result.fixtureRemoved=!fs.existsSync(probe.root);
 const data=fs.readFileSync(path.join(app.vault.adapter.getBasePath(),app.vault.configDir,'plugins/source-observer/data.json'));
 result.settingsRestored=data.equals(app.__soMigrationSession.data);
 const installed=path.join(app.vault.adapter.getBasePath(),app.vault.configDir,'plugins/source-observer/main.js');result.installedSha256=crypto.createHash('sha256').update(fs.readFileSync(installed)).digest('hex');
 fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');delete app.__soUnloadProbe;return JSON.stringify(result);
};
