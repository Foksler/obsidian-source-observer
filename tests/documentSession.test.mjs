import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentSession } from '../src/documents/DocumentSession.ts';

function fixture() {
 const disk = new Map([['/one.ts', 'base']]), timers = new Set(), saved = [], failed = [];
 const io = { async read(path) { return disk.has(path) ? { content: disk.get(path), editable: true } : null; },
  compareAndWrite(path, text, expected) { if (!disk.has(path)) return 'missing'; if (disk.get(path) !== expected) return 'changed'; disk.set(path, text); return 'saved'; },
  write(path, text) { disk.set(path, text); } };
 const session = new DocumentSession('/one.ts', { content: 'base', editable: true }, io, callback => { timers.add(callback); return () => timers.delete(callback); });
 session.setHandlers({ saved: path => saved.push(path), failed: (path, error) => failed.push({ path, error }), conflict: async () => 'cancel' });
 return { disk, timers, saved, failed, io, session };
}
const decision = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('document owns revisions and one autosave timer without an editor', () => {
 const f = fixture(); f.session.edit('one'); f.session.edit('two');
 assert.equal(f.session.snapshot().revision, 3); assert.equal(f.timers.size, 1);
 [...f.timers][0](); assert.equal(f.disk.get('/one.ts'), 'two'); assert.equal(f.session.snapshot().dirty, false);
 assert.equal(f.session.save(), 'ready'); assert.equal(f.saved.length, 1);
});

test('IO failure returns blocked and retains a recoverable buffer until retry succeeds', () => {
 const f = fixture(), error = new Error('disk unavailable'); f.session.edit('unsaved');
 const write = f.io.compareAndWrite; f.io.compareAndWrite = () => { throw error; };
 assert.equal(f.session.save(), 'blocked'); assert.equal(f.session.snapshot().text, 'unsaved');
 assert.deepEqual(f.session.recovery(), { path: '/one.ts', text: 'unsaved', baseline: 'base', revision: 2 });
 f.io.compareAndWrite = write; assert.equal(f.session.save(), 'ready'); assert.equal(f.session.recovery(), null);
});

test('concurrent transitions share a decision; edits during the decision are preserved', async () => {
 const f = fixture(), answer = decision(); let questions = 0;
 f.session.setHandlers({ saved() {}, failed() {}, conflict: () => { questions++; return answer.promise; } });
 f.session.edit('mine'); f.disk.set('/one.ts', 'external');
 const first = f.session.save(), second = f.session.save(); assert.equal(first, second); assert.equal(questions, 1);
 f.session.edit('newer'); answer.resolve('overwrite'); assert.equal(await first, 'ready'); assert.equal(f.disk.get('/one.ts'), 'newer');
});

test('cancel leaves dirty text; explicit discard advances revision and reloads disk', async () => {
 const f = fixture(); f.session.edit('mine'); f.disk.set('/one.ts', 'external');
 assert.equal(await f.session.save(), 'blocked'); assert.equal(f.session.snapshot().text, 'mine');
 f.session.setHandlers({ saved() {}, failed() {}, conflict: async () => 'discard' });
 const revision = f.session.snapshot().revision; assert.equal(await f.session.save(), 'ready');
 assert.equal(f.session.snapshot().text, 'external'); assert.ok(f.session.snapshot().revision > revision);
});

test('Trash revokes a pending overwrite and a save timer, without waiting for the dialog', async () => {
 const f = fixture(), answer = decision(); f.session.setHandlers({ saved() {}, failed() {}, conflict: () => answer.promise });
 f.session.edit('mine'); f.disk.set('/one.ts', 'external'); const pending = f.session.save();
 f.disk.delete('/one.ts'); f.session.revoke(); assert.equal(await pending, 'cancelled');
 answer.resolve('overwrite'); await Promise.resolve(); assert.equal(f.disk.has('/one.ts'), false);
 assert.equal(f.timers.size, 0); assert.equal(f.session.recovery(), null);
});

test('clean reload changes revision; dirty external reload never replaces the buffer', async () => {
 const f = fixture(); f.disk.set('/one.ts', 'external'); await f.session.reloadIfChanged();
 assert.equal(f.session.snapshot().revision, 2); f.session.edit('local');
 f.disk.set('/one.ts', 'new external'); await f.session.reloadIfChanged();
 assert.equal(f.session.snapshot().text, 'local'); f.session.stop();
});

test('edit made during discard IO blocks the transition instead of losing the new revision', async () => {
 const f = fixture(), loaded = decision(); f.session.edit('mine'); f.disk.set('/one.ts', 'external');
 f.session.setHandlers({ saved() {}, failed() {}, conflict: async () => 'discard' });
 f.io.read = () => loaded.promise; const saving = f.session.save();
 await Promise.resolve(); await Promise.resolve(); f.session.edit('newer');
 loaded.resolve({ content: 'external', editable: true }); assert.equal(await saving, 'blocked');
 assert.equal(f.session.snapshot().text, 'newer'); f.session.stop();
});

test('restored unsaved text is not automatically written until an explicit action', () => {
 const f = fixture(); f.session.restore({ path: '/one.ts', text: 'recovered', baseline: 'base', revision: 9 });
 assert.equal(f.timers.size, 0); assert.equal(f.disk.get('/one.ts'), 'base'); assert.equal(f.session.snapshot().revision, 9);
 assert.equal(f.session.save(), 'ready'); assert.equal(f.disk.get('/one.ts'), 'recovered');
});

test('shutdown cancels timers and stale decisions while keeping recovery available', async () => {
 const f = fixture(), answer = decision(); f.session.edit('mine'); f.disk.set('/one.ts', 'external');
 f.session.setHandlers({ saved() {}, failed() {}, conflict: () => answer.promise });
 const pending = f.session.save(); f.session.stop(); answer.resolve('overwrite');
 assert.equal(await pending, 'cancelled'); assert.equal(f.disk.get('/one.ts'), 'external');
 assert.equal(f.session.recovery().text, 'mine'); assert.equal(f.timers.size, 0);
});
