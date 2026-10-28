import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LSPClient } from '@codemirror/lsp-client';
import { ViewerWorkspace } from '../src/ui/lspWorkspace.ts';
const languageRead=uri=>readFile(new URL(uri),'utf8');
import { stdioTransport } from '../src/desktop/lspTransport.ts';
import { editorHarness } from './helpers/editorHarness.mjs';

const harness = await editorHarness();
test.after(() => harness.dispose());

test('live buffers emit versioned didChange exactly once per revision', async () => {
 let receive; const sent = [];
 const client = new LSPClient({ workspace: current => new ViewerWorkspace(current, async () => null,()=> 'plaintext',languageRead) });
 client.connect({ subscribe(listener) { receive = listener; }, unsubscribe() {}, send(message) {
  const data = JSON.parse(message); sent.push(data);
  if (data.method === 'initialize') queueMicrotask(() => receive(JSON.stringify({ jsonrpc: '2.0', id: data.id,
   result: { capabilities: { textDocumentSync: 2, positionEncoding: 'utf-16' } } })));
 } });
 await client.initializing;
 const uri = 'file:///fixture.php', editor = new EditorView({ parent: harness.container(),
  state: EditorState.create({ doc: '<?php\nclass Before {}', extensions: [client.plugin(uri, 'php')] }) });
 try {
  editor.dispatch({ changes: { from: 12, to: 18, insert: 'After😀' } }); client.sync();
  await Promise.resolve();
  const changes = sent.filter(message => message.method === 'textDocument/didChange');
  assert.equal(changes.length, 1); assert.equal(changes[0].params.textDocument.version, 2);
  assert.ok(changes[0].params.contentChanges.some(change => change.text.includes('After😀')));
  assert.equal(client.workspace.getFile(uri).doc.toString(), editor.state.doc.toString());
  client.sync(); await Promise.resolve(); assert.equal(sent.filter(message => message.method === 'textDocument/didChange').length, 1);
  editor.dispatch({ changes: { from: editor.state.doc.length, insert: '\n' } }); client.sync();
  await Promise.resolve();
  assert.equal(sent.filter(message => message.method === 'textDocument/didChange').at(-1).params.textDocument.version, 3);
 } finally { editor.destroy(); client.disconnect(); }
});

test('real Intelephense sees unsaved renamed symbols, definitions and references', { timeout: 30000 }, async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'so-lsp-edits-')), file = path.join(root, 'Example.php');
 const before = '<?php\nclass BeforeExample {}\nfunction make() { return new BeforeExample(); }\n';
 await writeFile(file, before);
 const proc = spawn(process.execPath, [path.resolve('node_modules/intelephense/lib/intelephense.js'), '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
 proc.stderr.on('data', () => {});
 const client = new LSPClient({ rootUri: pathToFileURL(root).href, timeout: 15000,
  initializationOptions: { storagePath: path.join(root, '.cache') },
  workspace: current => new ViewerWorkspace(current, async () => null, () => 'php',languageRead) });
 const uri = pathToFileURL(file).href; let editor;
 try {
  client.connect(stdioTransport(proc, async () => ({ telemetry: { enabled: false } })));
  await client.initializing;
  editor = new EditorView({ parent: harness.container(), state: EditorState.create({ doc: before, extensions: [client.plugin(uri, 'php')] }) });
  const first = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
  assert.ok(first.some(symbol => symbol.name === 'BeforeExample'));
  const after = before.replaceAll('BeforeExample', 'ChangedExample');
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: after } }); client.sync();
  const symbols = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
  assert.ok(symbols.some(symbol => symbol.name === 'ChangedExample'));
  assert.ok(!symbols.some(symbol => symbol.name === 'BeforeExample'));
  const definition = await client.request('textDocument/definition', { textDocument: { uri },
   position: { line: 2, character: after.split('\n')[2].indexOf('ChangedExample') + 2 } });
  assert.equal((Array.isArray(definition) ? definition[0] : definition).range.start.line, 1);
  const references = await client.request('textDocument/references', { textDocument: { uri }, position: { line: 1, character: 8 }, context: { includeDeclaration: true } });
  assert.ok(references.length >= 2);
  assert.equal(await readFile(file, 'utf8'), before, 'LSP must receive edits before any disk save');
 } finally {
  editor?.destroy(); client.disconnect();
  if (proc.exitCode === null) { const closed = once(proc, 'close'); proc.kill(); await closed; }
  await rm(root, { recursive: true, force: true });
 }
});

function recordedClient(){
 let receive;const sent=[];
 const client=new LSPClient({workspace:current=>new ViewerWorkspace(current,async()=>null,()=> 'plaintext',languageRead)});
 const connect=()=>{client.connect({subscribe(listener){receive=listener;},unsubscribe(){},send(message){
  const data=JSON.parse(message);sent.push(data);if(data.method==='initialize')queueMicrotask(()=>receive(JSON.stringify({jsonrpc:'2.0',id:data.id,result:{capabilities:{textDocumentSync:2}}})));
 }});return client.initializing;};
 return {client,sent,connect};
}

test('two editors of one URI share didOpen/didChange and only final detach closes it',async()=>{
 const {client,sent,connect}=recordedClient();await connect();const uri='file:///shared.php';
 const create=()=>new EditorView({parent:harness.container(),state:EditorState.create({doc:'before',extensions:[client.plugin(uri,'php')]})});
 const a=create(),b=create();
 try{
  await Promise.resolve();assert.equal(sent.filter(m=>m.method==='textDocument/didOpen').length,1);
  for(const view of [a,b])view.dispatch({changes:{from:0,to:6,insert:'after'}});
  client.sync();await Promise.resolve();assert.equal(sent.filter(m=>m.method==='textDocument/didChange').length,1);
  client.sync();await Promise.resolve();assert.equal(sent.filter(m=>m.method==='textDocument/didChange').length,1);
  a.destroy();assert.ok(client.workspace.getFile(uri));assert.equal(client.workspace.getFile(uri).getView(),b);
  b.dispatch({changes:{from:5,insert:'!'}});client.sync();await Promise.resolve();
  assert.equal(sent.filter(m=>m.method==='textDocument/didChange').at(-1).params.textDocument.version,3);
 }finally{b.destroy();client.workspace.dispose();client.disconnect();}
 await Promise.resolve();assert.equal(sent.filter(m=>m.method==='textDocument/didClose').length,1);
});

test('queued editor attach/detach before connect emits exactly one didOpen for surviving URI',async()=>{
 const {client,sent,connect}=recordedClient(),uri='file:///queued.php';
 const dead=new EditorView({parent:harness.container(),state:EditorState.create({doc:'dead',extensions:[client.plugin('file:///closed.php','php')]})});dead.destroy();
 const live=new EditorView({parent:harness.container(),state:EditorState.create({doc:'live',extensions:[client.plugin(uri,'php')]})});
 try{
  assert.equal(sent.length,0);await connect();await Promise.resolve();
  const opens=sent.filter(m=>m.method==='textDocument/didOpen');assert.equal(opens.length,1);assert.equal(opens[0].params.textDocument.uri,uri);
  assert.equal(sent.filter(m=>m.method==='textDocument/didClose').length,0);
 }finally{live.destroy();client.workspace.dispose();client.disconnect();}
});

test('overlapping temporary document requests retain a live URI until its final editor/request release',async()=>{
 const {client,sent,connect}=recordedClient();await connect();const uri='file:///live-request.php';
 const editor=new EditorView({parent:harness.container(),state:EditorState.create({doc:'unsaved',extensions:[client.plugin(uri,'php')]})});
 let releaseA,releaseB;const aGate=new Promise(r=>releaseA=r),bGate=new Promise(r=>releaseB=r);
 const a=client.workspace.withDocument(uri,async()=>{await aGate;return client.workspace.getFile(uri).doc.toString();});
 const b=client.workspace.withDocument(uri,async()=>{await bGate;return client.workspace.getFile(uri).doc.toString();});
 editor.destroy();releaseA();assert.equal(await a,'unsaved');assert.ok(client.workspace.getFile(uri));releaseB();assert.equal(await b,'unsaved');
 await Promise.resolve();assert.equal(sent.filter(m=>m.method==='textDocument/didClose').length,1);
 client.workspace.dispose();client.disconnect();
});

test('concurrent readonly reference scopes do not evict each other and teardown cancels cache timers',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'so-reference-scopes-')),file=path.join(root,'one.php');await writeFile(file,'<?php');
 const {client,connect}=recordedClient();await connect();const workspace=client.workspace,uri=pathToFileURL(file).href;
 try{
  const [a,b]=await Promise.all([workspace.primeReferenceFiles([uri]),workspace.primeReferenceFiles([uri])]);
  a();assert.ok(workspace.getFile(uri));b();assert.equal(workspace.getFile(uri),null);
  assert.equal((await workspace.requestFile(uri)).doc.toString(),'<?php');
  workspace.dispose();assert.equal(await workspace.requestFile(uri),null);
 }finally{workspace.dispose();client.disconnect();await rm(root,{recursive:true,force:true});}
});

test('shared workspace routes source-less reference display by focused owner and releases closed UI bindings',async()=>{
 const {client,connect}=recordedClient();await connect();const calls=[];
 const a=new EditorView({parent:harness.container(),state:EditorState.create({doc:'one',extensions:[client.plugin('file:///a.php','php')]})});
 const b=new EditorView({parent:harness.container(),state:EditorState.create({doc:'two',extensions:[client.plugin('file:///b.php','php')]})});
 const releaseA=client.workspace.bindDisplay(a,async file=>{calls.push(['a',file]);return null;});
 const releaseB=client.workspace.bindDisplay(b,async file=>{calls.push(['b',file]);return null;});
 try{
  a.focus();await client.workspace.displayFile('file:///target.php');b.focus();await client.workspace.displayFile('file:///target.php');
  assert.deepEqual(calls,[['a','/target.php'],['b','/target.php']]);
  releaseA();a.destroy();await client.workspace.displayFile('file:///target.php');assert.equal(calls.at(-1)[0],'b');
 }finally{releaseA();releaseB();b.destroy();client.workspace.dispose();client.disconnect();}
});
