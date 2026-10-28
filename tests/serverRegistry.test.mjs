import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerRegistry } from '../src/language/ServerRegistry.ts';
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const tick=()=>new Promise(r=>setImmediate(r));
function identity(root='/project',configuration='one'){return {language:'php',root,configuration};}
function launcher(){const gate=deferred();return {gate,starts:0,stops:0,start(){this.starts++;return gate.promise;},async stop(){this.stops++;}};}

test('editor and background acquire one connection; releasing background preserves editor and idle timer is owned',async()=>{
 const registry=new ServerRegistry({idleMs:10000}),resource=launcher();let creates=0;
 const create=()=>{creates++;return resource;};
 const a=registry.acquire(identity(),'query',create),b=registry.acquire(identity(),'editor',create);
 await tick();assert.equal(creates,1);assert.equal(resource.starts,1);assert.equal(a.value,b.value);
 resource.gate.resolve();await Promise.all([a.ready,b.ready]);a.release();assert.equal(resource.stops,0);
 assert.equal(registry.diagnostics().leases,1);b.release();assert.equal(registry.diagnostics().idleTimers,1);
 await registry.dispose();assert.equal(resource.stops,1);assert.deepEqual(registry.diagnostics(),{running:0,initializing:0,queued:0,entries:0,leases:0,idleTimers:0,closing:0,shutdownFailures:0,stopped:true});
});

test('process/init bounds, editor priority and pressure eviction apply to queued work',async()=>{
 const registry=new ServerRegistry({maxRunning:2,maxInitializing:1,idleMs:10000});const resources=Array.from({length:4},launcher);
 const a=registry.acquire(identity('/a'),'editor',()=>resources[0]);const b=registry.acquire(identity('/b'),'query',()=>resources[1]);
 const c=registry.acquire(identity('/c'),'query',()=>resources[2]);const d=registry.acquire(identity('/d'),'editor',()=>resources[3]);
 await tick();assert.equal(registry.diagnostics().running,1);assert.equal(registry.diagnostics().initializing,1);
 resources[0].gate.resolve();await a.ready;await tick();assert.equal(resources[3].starts,1);assert.equal(resources[1].starts,0);
 resources[3].gate.resolve();await d.ready;await tick();assert.equal(registry.diagnostics().running,2);
 a.release();await tick();assert.equal(resources[0].stops,1);assert.equal(resources[1].starts,1);
 resources[1].gate.resolve();await b.ready;c.release();b.release();d.release();await registry.dispose();assert.equal(resources[2].starts,0);
});

test('configuration/root keys isolate servers; disposed/queued consumers never spawn later',async()=>{
 const registry=new ServerRegistry({maxInitializing:1,maxRunning:1});const aResource=launcher(),bResource=launcher();
 const a=registry.acquire(identity(),'editor',()=>aResource);const b=registry.acquire(identity('/project','two'),'query',()=>bResource);
 await tick();assert.equal(registry.diagnostics().queued,1);b.release();await assert.rejects(b.ready,/released/);
 await registry.dispose();await assert.rejects(a.ready,/released/);aResource.gate.resolve();await tick();assert.equal(bResource.starts,0);assert.equal(a.current,false);
 assert.throws(()=>registry.acquire(identity(),'query',launcher),/disposed/);assert.equal(registry.diagnostics().initializing,0);
});

test('initialization failure retires entry and a fresh acquire can retry without reusing failed client',async()=>{
 const registry=new ServerRegistry(),resource=launcher();const lease=registry.acquire(identity(),'query',()=>resource);
 await tick();resource.gate.reject(Error('failed init'));await assert.rejects(lease.ready,/failed init/);await tick();assert.equal(lease.current,false);
 const replacement=launcher(),next=registry.acquire(identity(),'query',()=>replacement);replacement.gate.resolve();await next.ready;
 assert.notEqual(next.value,lease.value);await registry.dispose();
});


test('failed process termination remains visible and is not reported as a clean shutdown',async()=>{
 const registry=new ServerRegistry();const lease=registry.acquire(identity(),'editor',()=>({async start(){},async stop(){throw Error('process still alive');}}));
 await lease.ready;await assert.rejects(registry.dispose(),/shutdown incomplete/);
 assert.equal(registry.diagnostics().running,1);assert.equal(registry.diagnostics().shutdownFailures,1);
});

test('releasing one initializing lease cancels its waiter while a shared editor continues',async()=>{
 const registry=new ServerRegistry(),resource=launcher();
 const a=registry.acquire(identity(),'query',()=>resource),b=registry.acquire(identity(),'editor',()=>resource);
 await tick();a.release();await assert.rejects(a.ready,/lease released/);assert.equal(resource.stops,0);
 resource.gate.resolve();await b.ready;assert.equal(b.current,true);await registry.dispose();
});
