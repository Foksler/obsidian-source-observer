// Diagnostic, not a passing regression assertion: stage 1 records defects, stage 2 must remove them.
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { editorHarness } from './helpers/editorHarness.mjs';
const harness = await editorHarness(), root = await mkdtemp(path.join(os.tmpdir(), 'so-transition-probe-'));
const file = path.join(root, 'one.ts'), next = path.join(root, 'two.ts');
const pane = new harness.CodePane(harness.container(), 15, 'obsidian', () => {});
const edit = text => { const view = pane.getEditor(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); };
const report = {};
try {
 await writeFile(file, 'baseline'); await writeFile(next, 'next'); await pane.open(file); edit('unsaved');
 await rm(file); await mkdir(file); await pane.open(next);
 report.saveFailureSwitch = { retainedOriginalEditor: pane.getCurrentFile() === file, retainedText: pane.getEditor()?.state.doc.toString() === 'unsaved' };
 await rm(file, { recursive: true }); await writeFile(file, 'baseline'); await pane.open(file); edit('local');
 await writeFile(file, 'external'); let decide;
 const decision = new Promise(resolve => { decide = resolve; });
 pane.setSaveHandlers({ saved() {}, failed() {}, conflict: () => decision });
 const pending = pane.save(); await rm(file); pane.forgetFile(file); decide(true); await pending;
 await new Promise(resolve => setImmediate(resolve));
 report.lateTrashAnswer = { resurrected: await readFile(file).then(() => true, () => false) };
 console.log(JSON.stringify(report, null, 2));
} finally { await pane.destroy(); await rm(root, { recursive: true, force: true }); await harness.dispose(); }
