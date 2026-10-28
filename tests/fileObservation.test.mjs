import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileScope } from '../src/files/FileScope.ts';
import { FileObservation,FileObservationRuntime } from '../src/files/FileObservation.ts';
import { GitRepositoryStore } from '../src/git/GitRepositoryStore.ts';
const scope=root=>new FileScope(root,{showHidden:false,includeWorktrees:false,excludedFiles:['skip/**'],worktreeRoots:[]});
const repository={root:'/project',gitDir:'/repository/.git/worktrees/project',commonDir:'/repository/.git'};
function fixture(unavailable=false,folder='/project') {
 let now=0,next=0;const tasks=new Map(),watches=[],calls={paths:0,contents:0,git:0,poll:0,invalidations:[]};
 const schedule=(run,delay,repeat)=>{const id=++next;tasks.set(id,{run,time:now+delay,repeat});return ()=>tasks.delete(id);};
 const environment={watch(target,recursive,changed,failed){if(unavailable)throw Error('unsupported');const watch={target,recursive,changed,failed,closed:false,close(){this.closed=true;}};watches.push(watch);return watch;},
  after:(run,delay)=>schedule(run,delay,0),every:(run,delay)=>schedule(run,delay,delay)};
 const callbacks={pathsChanged(){calls.paths++;},currentFile:()=>'/project/current.ts',contentChanged(){calls.contents++;},gitChanged(){calls.git++;},invalidateGit(target,topology){calls.invalidations.push({target,topology});},poll(){calls.poll++;}};
 const observation=new FileObservation(scope(folder),callbacks,environment);
 const advance=delta=>{const until=now+delta;while(true){const ready=[...tasks].filter(([,task])=>task.time<=until).sort((a,b)=>a[1].time-b[1].time)[0];if(!ready)break;const [id,task]=ready;now=task.time;tasks.delete(id);if(task.repeat)tasks.set(id,{...task,time:now+task.repeat});task.run();}now=until;};
 return {observation,environment,callbacks,watches,calls,advance,tasks};
}

test('path/content/Git bursts coalesce with existing delays and independent coverage',()=>{
 const f=fixture(),watch=f.watches[0];watch.changed('rename','new.ts');watch.changed('rename','new.ts');watch.changed('change','current.ts');
 f.advance(79);assert.equal(f.calls.paths,0);f.advance(1);assert.equal(f.calls.paths,1);f.advance(20);assert.equal(f.calls.contents,1);f.advance(700);assert.equal(f.calls.git,1);
 watch.changed('rename','skip/hidden.ts');watch.changed('rename','node_modules/new.ts');f.advance(800);assert.equal(f.calls.paths,1);
 watch.changed('rename','.hidden.ts');f.advance(80);assert.equal(f.calls.paths,2,'hidden files still invalidate filename inventory');f.observation.dispose();assert.equal(f.tasks.size,0);
});

test('metadata uses actual gitDir/commonDir and recursive refs, with deduplication and stale guards',()=>{
 const f=fixture();f.observation.setRepositories([repository,repository]);assert.equal(f.observation.watchers.length,4);
 assert.ok(f.watches.some(watch=>watch.target===repository.gitDir));assert.ok(f.watches.some(watch=>watch.target===path.join(repository.commonDir,'refs') && watch.recursive));
 const old=f.watches.find(watch=>watch.target===repository.gitDir);old.changed('change','HEAD');f.advance(800);assert.equal(f.calls.git,1);
 f.observation.setRepositories([]);assert.equal(old.closed,true);f.observation.setRepositories([repository]);const current=f.watches.filter(watch=>watch.target===repository.gitDir).at(-1);
 old.failed();old.changed('change','index');assert.equal(current.closed,false);f.advance(800);assert.equal(f.calls.git,1);f.observation.dispose();assert.equal(f.observation.watchers.length,0);
});

test('fallback poll survives unavailable watchers; shutdown cancels all timers and refuses new scopes',()=>{
 const f=fixture(true);f.observation.enablePolling();f.observation.enablePolling();f.advance(5000);assert.equal(f.calls.poll,1);assert.equal(f.observation.watchers.length,0);
 f.observation.scheduleGit();f.observation.dispose();f.advance(10000);assert.equal(f.calls.poll,1);assert.equal(f.calls.git,0);assert.equal(f.tasks.size,0);
 const runtime=new FileObservationRuntime(),one=runtime.open(scope('/project'),f.callbacks,f.environment);assert.equal(runtime.diagnostics().scopes,1);runtime.close(one);assert.equal(runtime.diagnostics().scopes,0);
 runtime.dispose();assert.equal(runtime.open(scope('/project'),f.callbacks,f.environment),undefined);
});

test('failed root watcher is reacquired on poll and a late old error cannot close its replacement',()=>{
 const f=fixture(),old=f.watches[0];old.failed();assert.equal(f.observation.watchers.length,0);f.observation.enablePolling();f.advance(5000);
 const current=f.watches.at(-1);assert.notEqual(current,old);old.failed();assert.equal(current.closed,false);f.observation.dispose();
 old.changed('rename','late.ts');f.advance(10000);assert.equal(f.calls.paths,0);
});

test('real linked-worktree HEAD/index/common refs events are observed outside its workspace folder',async t=>{
 const parent=await realpath(await mkdtemp(path.join(os.tmpdir(),'so-observation-')));t.after(()=>rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'repository'),tree=path.join(parent,'worktree');await mkdir(root);
 const exec=promisify(execFile),git=(directory,...args)=>exec('git',['-C',directory,'-c','user.name=Test','-c','user.email=test@example.test',...args]);
 await git(root,'init','--quiet');await writeFile(path.join(root,'file.ts'),'base');await git(root,'add','.');await git(root,'commit','--quiet','-m','fixture');await git(root,'worktree','add','--quiet','--detach',tree);
 const store=new GitRepositoryStore();t.after(()=>store.dispose());const discovered=await store.resolve(tree,true);assert.equal(discovered.state,'ready');const context=discovered.context,events=[];
 const observation=new FileObservation(scope(tree),{pathsChanged(){},currentFile:()=>null,contentChanged(){},gitChanged(){},invalidateGit(target){events.push(target);if(target)store.invalidatePath(target);},poll(){}});t.after(()=>observation.dispose());observation.setRepositories([context]);
 if(process.platform==='darwin')await new Promise(resolve=>setTimeout(resolve,100));
 await writeFile(path.join(context.gitDir,'HEAD'),await readFile(path.join(context.gitDir,'HEAD')));await writeFile(path.join(tree,'new.ts'),'new');await git(tree,'add','new.ts');await git(root,'update-ref','refs/heads/observed','HEAD');
 const deadline=Date.now()+4000;
 const observed=()=>events.includes(path.join(context.gitDir,'HEAD')) && events.includes(path.join(context.gitDir,'index')) && events.some(target=>target?.startsWith(path.join(context.commonDir,'refs')));
 while(!observed() && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
 assert.ok(observed(),JSON.stringify(events));assert.deepEqual((await store.read(context)).changes,[{code:'A ',file:'new.ts'}]);observation.dispose();assert.deepEqual(observation.diagnostics(),{watchers:0,timers:0,polling:false,disposed:true});
});

test('retargeting a displayed root alias releases old handles and pending signals',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'so-observation-alias-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=path.join(root,'first'),second=path.join(root,'second'),alias=path.join(root,'alias');await mkdir(first);await mkdir(second);await symlink(first,alias);
 const f=fixture(false,alias),old=f.watches[0];old.changed('rename','old.ts');
 await rm(alias);await symlink(second,alias);f.observation.updateScope(scope(alias));assert.equal(old.closed,true);assert.notEqual(f.watches.at(-1),old);
 old.changed('rename','late.ts');f.advance(800);assert.equal(f.calls.paths,0);assert.equal(f.calls.git,0);f.observation.dispose();
});
