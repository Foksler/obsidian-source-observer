import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=await mkdtemp(path.join(process.cwd(),'tests','.workspace-contract-'));
const bundle=path.join(root,'workspace.mjs');
await build({stdin:{contents:"export * from './src/workspace/WorkspaceSession.ts'; export * from './src/workspace/NavigationSession.ts'; export * from './src/app/WorkspaceTransitions.ts'; export * from './src/app/WorkspaceController.ts';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:bundle});
const {WorkspaceSession,NavigationSession,WorkspaceTransitions,WorkspaceController}=await import(pathToFileURL(bundle).href);
test.after(()=>rm(root,{recursive:true,force:true}));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('A→B→A cancels stale transitions even when the final path equals the initial path', async()=>{
 const workspace=new WorkspaceSession(), transitions=new WorkspaceTransitions(workspace,()=>false), answer=deferred();
 workspace.activeFolder='/a'; const b=transitions.folder(), preparing=b.prepare(()=>answer.promise);
 const a=transitions.folder(); answer.resolve(true);
 assert.equal(await preparing,false); assert.equal(b.current(),false);assert.equal(a.current(),true);
 assert.equal(workspace.activeFolder,'/a'); assert.equal(workspace.folderEpoch,0,'intent cancellation must not revoke committed resources');
});

test('a blocked transition and a stale content decision do not authorize renderer replacement',async()=>{
 const workspace=new WorkspaceSession();let closed=false;
 const transitions=new WorkspaceTransitions(workspace,()=>closed), first=transitions.content();
 assert.equal(await first.prepare(async()=>false),false);
 const answer=deferred(), pending=first.prepare(()=>answer.promise), latest=transitions.content();answer.resolve(true);
 assert.equal(await pending,false);assert.equal(latest.current(),true);closed=true;assert.equal(latest.current(),false);
});

test('source preview shares a source tab identity while diff has explicit comparison sources',()=>{
 const workspace=new WorkspaceSession(), source={filePath:'/note.md',kind:'code'},diff={filePath:'/note.md',kind:'diff'};
 workspace.tabs.show(source);workspace.previews.add(source.filePath);workspace.tabs.show(diff);
 assert.equal(workspace.tabs.captureState().tabs.length,2);
 assert.deepEqual(workspace.target(source),{kind:'source',filePath:'/note.md',mode:'preview'});
 assert.deepEqual(workspace.target(diff),{kind:'diff',filePath:'/note.md',left:{kind:'git',revision:'HEAD',missing:'empty'},right:{kind:'disk',fallback:'index'}});
});

test('deletion purges inactive folder snapshots and recents without changing another folder',()=>{
 const workspace=new WorkspaceSession(), navigation=new NavigationSession();
 navigation.currentPath='/root/removed/a.ts';navigation.remember({filePath:navigation.currentPath,pos:3,scrollTop:4});
 navigation.fileLocations.set(navigation.currentPath,{filePath:navigation.currentPath,pos:3,scrollTop:4});
 workspace.sessions.set('/root',{editor:navigation.capture(),tabs:{tabs:[{filePath:navigation.currentPath,kind:'code'}],active:{filePath:navigation.currentPath,kind:'code'}},search:{query:'kept'},treeQuery:'a',changesQuery:'b'});
 workspace.activeFolder='/other';workspace.shown('/root/removed/a.ts');workspace.shown('/other/keep.ts');workspace.previews.add('/root/removed/a.ts');
 workspace.forget(file=>file.startsWith('/root/removed/'));
 const saved=workspace.sessions.get('/root');assert.equal(saved.editor.currentPath,null);assert.deepEqual(saved.editor.history,[]);assert.deepEqual(saved.editor.fileLocations,[]);
 assert.deepEqual(saved.tabs,{tabs:[],active:null});assert.equal(saved.search.query,'kept');assert.equal(workspace.activeFolder,'/other');
 assert.deepEqual(workspace.recents,['/other/keep.ts']);assert.equal(workspace.previews.size,0);
});

test('restoring a navigation session invalidates an earlier traversal ticket',()=>{
 const navigation=new NavigationSession(), location={filePath:'/a.ts',pos:1,scrollTop:0};navigation.remember(location);
 const back=navigation.begin('back',{filePath:'/b.ts',pos:2,scrollTop:3});navigation.restore(null);
 assert.equal(back.commit(),false);assert.deepEqual(navigation.capture().history,[]);
});

function controllerFixture() {
 const workspace=new WorkspaceSession(), calls=[];
 const ports={closed:()=>false,async prepareDocument(){return true;},captureFolder(){return {editor:workspace.navigation.capture(),tabs:workspace.tabs.captureState(),search:{query:'kept'},treeQuery:'',changesQuery:''};},
  restoreEditor(session){workspace.navigation.restore(session);return true;},beforeChange(){calls.push('before');},presentFolder(dir){calls.push(`present:${dir}`);},presentFolders(){},async persistFolders(){},
  async loadTree(){},async worktrees(){return [];},applyWorktrees(){},treeQuery(){return "";},async filterTree(){},async refreshGit(){},watch(){calls.push('watch');},async showActive(){calls.push('content');},poll(enabled){calls.push(`poll:${enabled}`);}};
 return {workspace,ports,calls,controller:new WorkspaceController(workspace,ports)};
}

test('workspace controller retains folders and snapshots when renderer commit refuses a close',async()=>{
 const f=controllerFixture();f.workspace.activeFolder='/a';f.workspace.folders=['/a','/b'];f.workspace.sessions.set('/a',{sentinel:true});
 f.ports.restoreEditor=()=>false;await f.controller.close('/a');
 assert.equal(f.workspace.activeFolder,'/a');assert.deepEqual(f.workspace.folders,['/a','/b']);assert.deepEqual(f.workspace.sessions.get('/a'),{sentinel:true});assert.deepEqual(f.calls,[]);
});

test('workspace controller ignores deferred B discovery after an A→B→A request',async()=>{
 const f=controllerFixture(), answer=deferred();f.workspace.activeFolder='/a';f.workspace.folders=['/a','/b'];
 f.ports.worktrees=dir=>dir==='/b'?answer.promise:Promise.resolve([]);
 const b=f.controller.activate('/b');await new Promise(resolve=>setImmediate(resolve));assert.equal(f.workspace.activeFolder,'/b');
 assert.equal(await f.controller.activate('/a'),true);answer.resolve(['/stale']);assert.equal(await b,false);
 assert.equal(f.workspace.activeFolder,'/a');assert.equal(f.calls.filter(call=>call==='watch').length,1);
});

test('closing an inactive folder during a pending active close does not resurrect it',async()=>{
 const f=controllerFixture(), answer=deferred();f.workspace.activeFolder='/a';f.workspace.folders=['/a','/b','/c'];f.ports.prepareDocument=()=>answer.promise;
 const closing=f.controller.close('/a');await f.controller.close('/b');answer.resolve(true);await closing;
 assert.deepEqual(f.workspace.folders,['/c']);assert.equal(f.workspace.activeFolder,'/c');
});

test('a query typed during folder discovery wins over the saved query',async()=>{
 const f=controllerFixture(), answer=deferred();let query='saved';const applied=[];
 f.ports.worktrees=()=>answer.promise;f.ports.treeQuery=()=>query;f.ports.filterTree=async value=>{applied.push(value);};
 const opening=f.controller.activate('/a');await new Promise(resolve=>setImmediate(resolve));
 query='typed while loading';answer.resolve([]);assert.equal(await opening,true);assert.deepEqual(applied,['typed while loading']);
});
