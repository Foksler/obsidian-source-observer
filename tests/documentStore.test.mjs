import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DocumentStore } from '../src/documents/DocumentStore.ts';
import { DocumentRecoveryJournal } from '../src/obsidian/DocumentRecovery.ts';

const recovery = { path: '/one.ts', text: 'unsaved😀', baseline: 'base', revision: 2 };
function fixture() {
 const io = { async read() { return { content: 'base', editable: true }; }, compareAndWrite() { return 'saved'; }, write() {} };
 return { io, store: new DocumentStore(io) };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('concurrent acquisitions share identity; releasing one consumer keeps the other alive', async () => {
 const { store } = fixture();
 const [one, two] = await Promise.all([store.open('/one.ts'), store.open('/one.ts')]);
 assert.equal(one, two); store.release(one);
 assert.equal(await store.open('/one.ts'), two); store.release(two); store.release(two);
 const fresh = await store.open('/one.ts'); assert.notEqual(fresh, one); store.stop();
});

test('detaching a dirty document retains recovery and reopening the same identity', async () => {
 const { store } = fixture(), one = await store.open('/one.ts'); one.edit(recovery.text); store.release(one);
 assert.deepEqual(store.recoveries(), [recovery]); assert.equal(await store.open('/one.ts'), one);
 store.forget(file => file === '/one.ts'); assert.deepEqual(store.recoveries(), []);
 assert.equal(one.snapshot().state, 'deleted'); store.stop();
});

for (const action of ['trash', 'shutdown']) test(`${action} cancels pending reads without resurrecting a document`, async () => {
 const { io, store } = fixture(), reading = deferred(); io.read = () => reading.promise;
 const pending = store.open('/one.ts');
 if (action === 'trash') store.forget(() => true); else store.stop();
 reading.resolve({ content: 'old read', editable: true }); assert.equal(await pending, null);
 assert.deepEqual(store.recoveries(), []); store.stop();
});

test('restored documents survive a missing disk file without automatic recreation', async () => {
 const { store, io } = fixture(); let writes = 0; io.read = async () => null; io.write = () => { writes++; };
 store.restore([recovery]); const document = await store.open(recovery.path);
 assert.equal(document.snapshot().text, recovery.text); assert.equal(writes, 0);
 assert.deepEqual(store.recoveries(), [recovery]); store.stop();
});

test('recovery journal roundtrips Unicode privately and removes itself only when resolved', () => {
 const dir = mkdtempSync(path.join(tmpdir(), 'so-recovery-')), file = path.join(dir, 'unsaved.json');
 try {
  const journal = new DocumentRecoveryJournal(file); assert.deepEqual(journal.read(), []);
  journal.write([recovery]); assert.deepEqual(new DocumentRecoveryJournal(file).read(), [recovery]);
  assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(existsSync(`${file}.tmp`), false);
  journal.write([]); assert.equal(existsSync(file), false);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const contents of ['{broken', '{}', JSON.stringify([recovery, { path: '/invalid' }])]) test('invalid recovery journal is preserved rather than silently truncated', () => {
 const dir = mkdtempSync(path.join(tmpdir(), 'so-recovery-')), file = path.join(dir, 'unsaved.json');
 try {
  writeFileSync(file, contents); const journal = new DocumentRecoveryJournal(file);
  assert.throws(() => journal.read()); assert.throws(() => journal.write([]));
  assert.equal(readFileSync(file, 'utf8'), contents);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

for(const decision of ['overwrite','discard','cancel','write-failure'])test(`detached pending ${decision} releases renderer handlers and settles through plugin owner`,async t=>{
 let disk='base',fallbackSaved=0,fallbackFailed=0,uiSaved=0,uiFailed=0;const choice=deferred();
 const io={async read(){return {content:disk,editable:true};},compareAndWrite(_path,text,expected){if(disk!==expected)return 'changed';disk=text;return 'saved';},write(_path,text){if(decision==='write-failure')throw Error('denied');disk=text;}};
 const store=new DocumentStore(io,{saved(){fallbackSaved++;},failed(){fallbackFailed++;},conflict:async()=> 'cancel'});t.after(()=>store.stop());
 const document=await store.open('/pending.ts');const detach=store.bindHandlers(document,{saved(){uiSaved++;},failed(){uiFailed++;},conflict:()=>choice.promise});
 document.edit('buffer');disk='external';const pending=document.save();assert.equal(document.hasPendingSave,true);
 detach();store.release(document);assert.equal(store.recoveries().length,1);
 choice.resolve(decision==='write-failure'?'overwrite':decision);const outcome=await pending;
 assert.equal(uiSaved,0);assert.equal(uiFailed,0);assert.equal(document.hasPendingSave,false);
 const reopened=await store.open('/pending.ts');
 if(decision==='overwrite'||decision==='discard'){assert.equal(outcome,'ready');assert.notEqual(reopened,document);assert.deepEqual(store.recoveries(),[]);}
 else{assert.equal(outcome,'blocked');assert.equal(reopened,document);assert.equal(reopened.snapshot().text,'buffer');assert.equal(store.recoveries().length,1);}
 assert.equal(fallbackSaved,decision==='overwrite'?1:0);assert.equal(fallbackFailed,decision==='write-failure'?1:0);
});

test('removing the latest renderer binding restores the surviving consumer handlers',async t=>{
 const {store}=fixture();t.after(()=>store.stop());const first=await store.open('/shared.ts'),second=await store.open('/shared.ts');let one=0,two=0;
 const a=store.bindHandlers(first,{saved(){one++;},failed(){},conflict:async()=> 'cancel'});
 const b=store.bindHandlers(second,{saved(){two++;},failed(){},conflict:async()=> 'cancel'});
 b();store.release(second);first.edit('updated');assert.equal(await first.save(),'ready');assert.equal(one,1);assert.equal(two,0);
 a();store.release(first);assert.notEqual(await store.open('/shared.ts'),first);
});

test('reopening while a conflict is pending preserves identity and late completion uses the new owner',async t=>{
 const choice=deferred();let old=0,current=0,disk='base';
 const io={async read(){return {content:disk,editable:true};},compareAndWrite(){return 'changed';},write(_p,text){disk=text;}};
 const store=new DocumentStore(io);t.after(()=>store.stop());const document=await store.open('/reopen.ts');
 const release=store.bindHandlers(document,{saved(){old++;},failed(){},conflict:()=>choice.promise});document.edit('buffer');const pending=document.save();release();store.release(document);
 const reopened=await store.open('/reopen.ts');assert.equal(reopened,document);
 store.bindHandlers(reopened,{saved(){current++;},failed(){},conflict:async()=> 'cancel'});choice.resolve('overwrite');assert.equal(await pending,'ready');
 assert.equal(old,0);assert.equal(current,1);assert.deepEqual(store.recoveries(),[]);
});

for(const decision of ['discard','overwrite','cancel','write-failure'])test(`persisted recovery follows ${decision} after the renderer detaches`,async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'so-detached-journal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'unsaved.json'),journal=new DocumentRecoveryJournal(file),choice=deferred();let disk='base';
 const io={async read(){return {content:disk,editable:true};},compareAndWrite(){return 'changed';},write(_path,text){if(decision==='write-failure')throw Error('denied');disk=text;}};
 const store=new DocumentStore(io,undefined,()=>journal.write(store.recoveries()));t.after(()=>store.stop());
 const document=await store.open('/pending.ts'),detach=store.bindHandlers(document,{saved(){},failed(){},conflict:()=>choice.promise});
 document.edit('discardable edits');disk='external';const pending=document.save();detach();store.release(document);journal.write(store.recoveries());
 assert.equal(journal.read()[0].text,'discardable edits');choice.resolve(decision==='write-failure'?'overwrite':decision);await pending;
 const persisted=new DocumentRecoveryJournal(file).read();
 assert.equal(persisted.length,decision==='discard'||decision==='overwrite'?0:1);
 if(persisted.length)assert.equal(persisted[0].text,'discardable edits');
});
