import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { editorHarness } from './helpers/editorHarness.mjs';

const harness = await editorHarness();
test.after(() => harness.dispose());
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
 const root = await mkdtemp(path.join(os.tmpdir(), 'so-document-contract-')), file = path.join(root, 'note.ts');
 await writeFile(file, 'export const value = "😀";\r\n');
 const pane = new harness.CodePane(harness.container(), 15, 'obsidian', () => {}), saved = [], failures = [];
 pane.setSaveHandlers({ saved: file => saved.push(file), failed: (file, error) => failures.push({ file, error }), conflict: async () => false });
 t.after(async () => { await pane.destroy(); await rm(root, { recursive: true, force: true }); });
 await pane.open(file);
 return { root, file, pane, saved, failures, edit(text) { const editor = pane.getEditor(); editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } }); } };
}

test('public editor saves exact BOM/CRLF/Unicode text once and subsequent save is idle', async t => {
 const f = await fixture(t), text = '\uFEFFexport const value = "данные 😀";\r\n';
 f.edit(text); await f.pane.save();
 assert.equal(await readFile(f.file, 'utf8'), text);
 await f.pane.save(); assert.deepEqual(f.saved, [f.file]);
});

test('public editor reports IO failure without replacing its current text', async t => {
 const f = await fixture(t); f.edit('unsaved');
 await rm(f.file); await mkdir(f.file); await f.pane.save();
 assert.equal(f.failures.length, 1); assert.equal(f.failures[0].file, f.file);
 assert.equal(f.pane.getEditor().state.doc.toString(), 'unsaved'); assert.deepEqual(f.saved, []);
});

test('one pending conflict asks once and explicit overwrite uses the latest buffer', async t => {
 const f = await fixture(t); let resolve, questions = 0;
 const decision = new Promise(done => { resolve = done; });
 f.pane.setSaveHandlers({ saved: file => f.saved.push(file), failed() {}, conflict: () => { questions++; return decision; } });
 f.edit('mine'); await writeFile(f.file, 'external');
 const saving = f.pane.save(); void f.pane.save();
 assert.equal(questions, 1); assert.equal(await readFile(f.file, 'utf8'), 'external');
 f.edit('latest'); resolve(true); await saving; await tick();
 assert.equal(await readFile(f.file, 'utf8'), 'latest');
});

test('external reload preserves a dirty buffer and a successful suspend flushes it', async t => {
 const f = await fixture(t); f.edit('local'); await writeFile(f.file, 'external');
 await f.pane.reloadIfChanged(); assert.equal(f.pane.getEditor().state.doc.toString(), 'local');
 // Put the loaded baseline back so suspension exercises its successful path.
 await writeFile(f.file, 'export const value = "😀";\r\n');
 await f.pane.suspend(); assert.equal(await readFile(f.file, 'utf8'), 'local'); assert.equal(f.pane.getEditor(), null);
});

test('discarding a conflict reloads disk and Unicode locations use one-based UTF-16 columns', async t => {
 const f = await fixture(t); f.edit('local'); await writeFile(f.file, '😀hello\nsecond');
 await f.pane.save(); await tick(); await tick();
 await f.pane.openAt(f.file, 1, 4);
 assert.equal(f.pane.captureLocation().column, 4);
 assert.equal(f.pane.getEditor().state.selection.main.head, 3);
 assert.equal(f.pane.getEditor().state.doc.toString(), '😀hello\nsecond');
});

test('forgetting a trashed document cancels its scheduled save', async t => {
 const f = await fixture(t); f.edit('must not return'); await rm(f.file);
 f.pane.forgetFile(f.file); await f.pane.save();
 assert.equal(f.pane.getCurrentFile(), null); assert.equal(f.pane.getEditor(), null);
 await assert.rejects(readFile(f.file), { code: 'ENOENT' });
});

test('IO failure blocks open and suspend, retaining the original editor and text', async t => {
 const f = await fixture(t), next = path.join(f.root, 'next.ts'); await writeFile(next, 'next');
 f.edit('retained'); await rm(f.file); await mkdir(f.file);
 assert.equal(await f.pane.open(next), null); assert.equal(f.pane.getCurrentFile(), f.file);
 assert.equal(await f.pane.suspend(), false); assert.equal(f.pane.getEditor().state.doc.toString(), 'retained');
});

test('pending save answer after Trash cannot recreate the file or block a new open', async t => {
 const f = await fixture(t), next = path.join(f.root, 'next.ts'); await writeFile(next, 'next');
 let decide; const decision = new Promise(resolve => { decide = resolve; });
 f.pane.setSaveHandlers({ saved() {}, failed() {}, conflict: () => decision });
 f.edit('local'); await writeFile(f.file, 'external'); const saving = f.pane.save();
 await rm(f.file); f.pane.forgetFile(f.file); await saving;
 await f.pane.open(next); decide(true); await tick();
 await assert.rejects(readFile(f.file), { code: 'ENOENT' }); assert.equal(f.pane.getCurrentFile(), next);
});

test('a read-only preview never schedules writes even after a programmatic edit', async t => {
 const f = await fixture(t), pane = new harness.CodePane(harness.container(), 15, 'obsidian', () => {}, undefined, undefined, { readOnly: true });
 t.after(() => pane.destroy()); await pane.open(f.file);
 const editor = pane.getEditor(); editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'not saved' } });
 await pane.save(); assert.equal(await readFile(f.file, 'utf8'), 'export const value = "😀";\r\n'); assert.equal(pane.dirty, false);
});

test('a pending document decision and buffer survive replacement of the renderer', async t => {
 const { DocumentStore } = await import('../src/documents/DocumentStore.ts');
 let disk = 'base', answer;
 const documents = new DocumentStore({ async read() { return {content: disk, editable: true}; },
  compareAndWrite(file, text, expected) { if(disk !== expected) return 'changed'; disk=text; return 'saved'; }, write(file, text) { disk=text; } });
 const one = new harness.CodePane(harness.container(), 15, 'obsidian', () => {}, undefined, undefined, { documents });
 const two = new harness.CodePane(harness.container(), 15, 'obsidian', () => {}, undefined, undefined, { documents });
 t.after(() => { one.disposeView(); two.disposeView(); documents.stop(); });
 one.setSaveHandlers({saved() {}, failed() {}, conflict: () => new Promise(resolve => {answer=resolve;})});
 await one.open('/shared.ts'); one.getEditor().dispatch({changes:{from:0,to:4,insert:'mine'}}); disk='external';
 const pending=one.save(); one.disposeView();
 await two.open('/shared.ts'); assert.equal(two.getEditor().state.doc.toString(),'mine');
 two.getEditor().dispatch({changes:{from:0,to:4,insert:'newer'}});
 answer('overwrite'); assert.equal(await pending,'ready'); assert.equal(disk,'newer');
 assert.equal(two.dirty,false); assert.deepEqual(documents.recoveries(),[]);
});

test('cancelled back navigation retains history for a later successful retry', async t => {
 const f=await fixture(t), second=path.join(f.root,'other.ts'); await writeFile(second,'other');
 f.pane.rememberPosition(); await f.pane.open(second); f.edit('mine'); await writeFile(second,'external');
 f.pane.setSaveHandlers({saved() {},failed() {},conflict:async()=> 'cancel'});
 const before=f.pane.captureSession(); assert.equal(await f.pane.goBack(),false);
 assert.deepEqual(f.pane.captureSession(),before);
 f.pane.setSaveHandlers({saved() {},failed() {},conflict:async()=> 'overwrite'});
 assert.equal(await f.pane.goBack(),true); assert.equal(f.pane.getCurrentFile(),f.file);
 assert.equal(await f.pane.goForward(),true); assert.equal(f.pane.getCurrentFile(),second);
});
