// Capture and restore an installed plugin session around read-only measurement/reload.
module.exports = async function(app, action) {
 const fs = require('fs'), path = require('path');
 if(action === 'capture') {
  const leaf = app.workspace.getLeavesOfType('source-observer')[0], view=require('./installedViewAccess.cjs')(leaf.view);
  if(view.codePane.dirty || view.codePane.conflictPath) throw Error('Current editor must be clean');
  app.__soMigrationSession = { leaf, folder:view.repoPath, folders:[...view.folderPaths], sessions:new Map(view.folderSessions),
   editor:view.codePane.captureSession(), tabs:view.editorTabs.captureState(), search:view.searchPanel.captureState(),
   treeQuery:view.treeSearchInput.value, changesQuery:view.changesQuery, previews:new Set(view.previewFiles), recent:[...view.recentFiles],
   data:fs.readFileSync(path.join(app.vault.adapter.getBasePath(), app.vault.configDir,'plugins/source-observer/data.json')) };
  await leaf.setViewState({type:'empty'}); return 'captured and detached clean view';
 }
 const s = app.__soMigrationSession; if(!s) throw Error('Missing saved UI session');
 await s.leaf.setViewState({type:'source-observer', active:true});
 const view=require('./installedViewAccess.cjs')(s.leaf.view), plugin=app.plugins.plugins['source-observer'];
 await view.activateFolder(''); view.folderPaths=s.folders; view.folderSessions=s.sessions; view.previewFiles=s.previews;
 if(s.folder) view.folderSessions.set(s.folder,{editor:s.editor,tabs:s.tabs,search:s.search,treeQuery:s.treeQuery,changesQuery:s.changesQuery});
 await view.activateFolder(s.folder); view.recentFiles=s.recent;
 const dataPath=path.join(app.vault.adapter.getBasePath(),app.vault.configDir,'plugins/source-observer/data.json');
 plugin.settings=JSON.parse(s.data.toString('utf8'));fs.writeFileSync(dataPath,s.data);
 return JSON.stringify({ restored:fs.readFileSync(dataPath).equals(s.data), folder:view.repoPath, documents:!!plugin.documents });
};
