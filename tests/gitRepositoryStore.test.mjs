import { WorktreeDiscovery } from '../src/git/WorktreeDiscovery.ts';
import { getTreeGitStatuses } from '../src/git/treeGitStatus.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,writeFile,rm,symlink,realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitRepositoryStore,parseGitStatus } from '../src/git/GitRepositoryStore.ts';
const context={root:'/repo',gitDir:'/repo/.git',commonDir:'/repo/.git'};
const ready=stdout=>({ok:true,stdout,stderr:''});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('concurrent tree and Changes reads share one status; unchanged snapshots keep identity',async()=>{
 let calls=0,now=0;const answer=deferred(),store=new GitRepositoryStore(async()=>{calls++;return calls===1?answer.promise:ready(' M file.ts\0');},()=>now);
 const tree=store.read(context),changes=store.read(context);assert.equal(tree,changes);assert.equal(calls,1);
 answer.resolve(ready(' M file.ts\0'));const first=await tree;assert.equal((await changes).changes[0].file,'file.ts');
 assert.equal(await store.read(context),first);assert.equal(calls,1);
 now=101;assert.equal(await store.read(context),first);assert.equal(calls,2);store.dispose();
});

test('Git error is distinct from a clean result and retains the last valid snapshot',async()=>{
 let result=ready('?? new.ts\0');const store=new GitRepositoryStore(async()=>result);
 const first=await store.read(context);result={ok:false,stdout:'',stderr:'index unreadable'};store.invalidate(context.root);
 const failed=await store.read(context);assert.equal(failed.state,'error');assert.equal(failed.lastGood,first);assert.equal(failed.error,'index unreadable');
 result=ready('');store.invalidate(context.root);const clean=await store.read(context);
 assert.equal(clean.state,'ready');assert.deepEqual(clean.changes,[]);assert.equal(clean.revision,2);store.dispose();
});

test('invalidation during status rejects stale output and coalesces the replacement read',async()=>{
 const answer=deferred();let calls=0;const store=new GitRepositoryStore(async()=>++calls===1?answer.promise:ready(' M latest.ts\0'));
 const old=store.read(context);store.invalidate(context.root);const current=store.read(context);answer.resolve(ready('?? stale.ts\0'));
 const [one,two]=await Promise.all([old,current]);assert.equal(one,two);assert.equal(one.changes[0].file,'latest.ts');assert.equal(calls,2);store.dispose();
});

test('runtime disposal prevents a pending read from publishing a successful snapshot',async()=>{
 const answer=deferred(),store=new GitRepositoryStore(()=>answer.promise);const pending=store.read(context);store.dispose();answer.resolve(ready('?? late.ts\0'));
 assert.equal((await pending).state,'error');assert.equal((await store.resolve('/repo',true)).state,'error');
});

test('different repository metadata at the same displayed root has a separate snapshot identity',async()=>{
 let calls=0;const store=new GitRepositoryStore(async()=>ready(`?? ${++calls}.ts\0`));
 const one=await store.read(context),two=await store.read({...context,commonDir:'/another/.git'});
 assert.notEqual(one,two);assert.equal(calls,2);store.dispose();
});

test('porcelain keeps destination names, Unicode, whitespace and newlines literally',()=>{
 assert.deepEqual(parseGitStatus('R  новое имя\n.ts\0old.ts\0?? tail space \0'),[{code:'R ',file:'новое имя\n.ts'},{code:'??',file:'tail space '}]);
});

test('discovery distinguishes outside repositories from IO/command failures',async()=>{
 const outside=new GitRepositoryStore(async()=>({ok:false,stdout:'',stderr:'fatal: not a git repository (or any parent)'}));
 assert.equal((await outside.resolve('/no-repo',true)).state,'outside');outside.dispose();
 const failed=new GitRepositoryStore(async()=>{throw Error('spawn EACCES');});const result=await failed.resolve('/no-repo',true);
 assert.equal(result.state,'error');assert.match(result.error,/EACCES/);failed.dispose();
});

test('real repository discovery separates working tree, gitDir and commonDir, including aliases',async t=>{
 const parent=await realpath(await mkdtemp(path.join(os.tmpdir(),'so-repositories-')));t.after(()=>rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'repo with spaces'),tree=path.join(parent,'linked');await mkdir(root);
 const exec=promisify(execFile),git=(...args)=>exec('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.test',...args]);
 await git('init','--quiet');await writeFile(path.join(root,'file.ts'),'base');await git('add','.');await git('commit','--quiet','-m','fixture');await git('worktree','add','--quiet','--detach',tree);
 const alias=path.join(parent,'alias');await symlink(tree,alias);const store=new GitRepositoryStore();t.after(()=>store.dispose());
 const original=await store.resolve(root,true),linked=await store.resolve(path.join(alias,'file.ts'),false);
 assert.equal(original.state,'ready');assert.equal(linked.state,'ready');assert.equal(linked.context.root,tree);assert.notEqual(linked.context.gitDir,original.context.gitDir);assert.equal(linked.context.commonDir,original.context.commonDir);
 await writeFile(path.join(tree,'file.ts'),'changed');assert.deepEqual((await store.read(linked.context)).changes,[{code:' M',file:'file.ts'}]);assert.deepEqual((await store.read(original.context)).changes,[]);
});

test('tree projection and Changes share a command and retain Git errors instead of becoming clean',async()=>{
 const answer=deferred();let statusCalls=0;const store=new GitRepositoryStore(async(cwd,args)=>{
  if(args[0]==='status'){statusCalls++;return answer.promise;}
  return ready((args[1]==='--show-toplevel'?'/repo':'/repo/.git')+'\n');
 });
 const reports=[];
 const tree=getTreeGitStatuses('/repo',['/repo'],{repositories:store,report:(contexts,errors)=>reports.push({contexts,errors})});
 const changes=store.resolve('/repo',true).then(discovery=>store.read(discovery.context));
 while(!statusCalls)await new Promise(resolve=>setImmediate(resolve));answer.resolve(ready(' M current.ts\0'));
 const [projection,snapshot]=await Promise.all([tree,changes]);assert.equal(statusCalls,1);assert.equal(projection.get('/repo/current.ts').kind,'modified');assert.equal(snapshot.changes[0].file,'current.ts');assert.equal(reports[0].contexts[0].gitDir,'/repo/.git');
 store.dispose();
});

test('invalidated repository discovery cannot publish an old owner or restart after shutdown',async()=>{
 const answer=deferred();let roots=0;const store=new GitRepositoryStore(async(cwd,args)=>{
  if(args[1]==='--show-toplevel')return ++roots===1?answer.promise:ready('/new-owner\n');
  return ready('/new-owner/.git\n');
 });
 const pending=store.resolve('/repo',true);while(!roots)await new Promise(resolve=>setImmediate(resolve));
 store.invalidateDiscovery();answer.resolve(ready('/stale-owner\n'));const result=await pending;assert.equal(result.state,'ready');assert.equal(result.context.root,'/new-owner');store.dispose();
 const stoppedAnswer=deferred();let calls=0;const stopped=new GitRepositoryStore(async()=>{calls++;return stoppedAnswer.promise;});const discovery=stopped.resolve('/repo',true);while(!calls)await new Promise(resolve=>setImmediate(resolve));
 stopped.dispose();stoppedAnswer.resolve(ready('/repo\n'));assert.equal((await discovery).state,'error');assert.equal(calls,1);
});

test('topology runtime disposal drains an already-started scan without publishing cached roots',async()=>{
 const discovery=new WorktreeDiscovery(),pending=discovery.roots(path.join(os.tmpdir(),'so-no-such-repository-for-disposal'));
 assert.equal(discovery.diagnostics().activeScans,1);discovery.dispose();assert.deepEqual(await pending,[]);
 assert.deepEqual(discovery.diagnostics(),{roots:0,activeScans:0,disposed:true});assert.deepEqual(await discovery.roots('/unused'),[]);
});
