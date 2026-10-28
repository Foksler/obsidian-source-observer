import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Text, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LSPClient, LSPPlugin } from '@codemirror/lsp-client';
import { editorHarness } from './helpers/editorHarness.mjs';

const temp = await mkdtemp(path.join(process.cwd(), 'tests', '.lsp-adapters-'));
const bundle = path.join(temp, 'adapters.mjs');
await build({
	stdin: { contents: `export * from './src/ui/lspNavigation.ts'; export * from './src/desktop/goAdapter.ts'; export * from './src/desktop/phpAdapter.ts'; export * from './src/ui/lspWorkspace.ts'; export * from './src/language/Symbols.ts'; export {createTestLanguageRuntime} from './tests/helpers/languageRuntime.ts';`, resolveDir: process.cwd() },
	bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: bundle,
	plugins: [{ name: 'obsidian-shim', setup(api) {
		api.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
		api.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: `
			export class App {} export class Component {} export const MarkdownRenderer = {};
			export const Platform = { isMacOS: true }; export class SuggestModal {}
			export class Notice { constructor(message) { globalThis.__lspNotices?.push(message); } hide() {} }
		` }));
	} }],
});
const { LspNavigation, phpAdapter, goAdapter, findGoRoot, goLanguageId, createGoplsSettings,
	ViewerWorkspace, createTestLanguageRuntime, detectGo, detectGopls, navigationAdapters } = await import(pathToFileURL(bundle).href);
test.after(() => rm(temp, { recursive: true, force: true }));
const options = { app: {}, display: async () => null, beforeJump() {} };
const goPath = process.env.SOURCE_OBSERVER_GO || detectGo();
const goplsPath = process.env.SOURCE_OBSERVER_GOPLS || detectGopls();
const intelephense = path.resolve('node_modules/intelephense/lib/intelephense.js');
const hasGo = existsSync(goPath) && existsSync(goplsPath);
const fixtures = async (name) => {
	const root = path.join(temp, name);
	await mkdir(root, { recursive: true });
	return root;
};

test('Go roots prefer go.work, discover nested modules and exclude worktrees', async () => {
	const root = await fixtures('roots');
	const app = path.join(root, 'app');
	const worktree = path.join(root, 'worktrees', 'copy');
	await mkdir(app, { recursive: true });
	await mkdir(worktree, { recursive: true });
	await writeFile(path.join(app, 'go.mod'), 'module example.invalid/app\ngo 1.21\n');
	await writeFile(path.join(worktree, 'go.mod'), 'module example.invalid/copy\ngo 1.21\n');
	const adapter = goAdapter('', '');
	assert.equal(findGoRoot(path.join(app, 'main.go')), app);
	assert.deepEqual(await adapter.workspaceRoots(root, false), [app]);
	assert.deepEqual((await adapter.workspaceRoots(root, true)).sort(), [app, worktree].sort());
	await writeFile(path.join(root, 'go.work'), 'go 1.21\nuse ./app\n');
	assert.equal(findGoRoot(path.join(app, 'main.go')), root);
	assert.deepEqual(await adapter.workspaceRoots(root, false), [root]);
	assert.ok((await createGoplsSettings(root)).directoryFilters.includes('-**/worktrees'));
	assert.ok(!(await createGoplsSettings(root, true)).directoryFilters.includes('-**/worktrees'));
	assert.equal(goLanguageId('main.go'), 'go');
	assert.equal(goLanguageId('go.mod'), 'gomod');
	assert.equal(goLanguageId('go.work'), 'gowork');
	assert.equal(goLanguageId('go.work.sum'), 'gosum');
	assert.equal(goLanguageId('main.php'), null);
});

test('read-only reference snapshots retain Go language identifiers', async () => {
	const root = await fixtures('snapshots');
	const file = path.join(root, 'main.go');
	await writeFile(file, 'package main\n');
	const workspace = new ViewerWorkspace({}, async () => null, goLanguageId, async uri => (await import('node:fs/promises')).readFile(fileURLToPath(uri),'utf8'));
	const snapshot = await workspace.requestFile(pathToFileURL(file).href);
	assert.equal(snapshot.languageId, 'go');
	assert.equal(snapshot.doc.toString(), 'package main\n');
});

test('disabled languages are absent and unsupported documents never spawn a server', () => {
	const settings = { phpLsp: true, goLsp: false, nodePath: process.execPath, intelephensePath: intelephense, intelephenseLicence: '', goPath: '', goplsPath: '' };
	const runtime=createTestLanguageRuntime();
 const navigation = new LspNavigation({...options,runtime}, navigationAdapters(settings));
	assert.equal(navigation.supports('main.go'), false);
	assert.equal(navigation.supports('index.php'), true);
	assert.deepEqual(navigation.extensionFor('main.rs'), []);
	assert.equal(runtime.diagnostics().running,0);
	navigation.dispose();
});

test('shared client runs PHP and Go, merges symbols and stops every server', { timeout: 45000, skip: !hasGo || !existsSync(intelephense) }, async () => {
	const root = await fixtures('mixed');
	const phpFile = path.join(root, 'FixtureExample.php');
	const goFile = path.join(root, 'main.go');
	const targetFile = path.join(root, 'service.go');
	const goSource = 'package main\n\nfunc main() { FixtureGreet() }\n';
	const targetSource = 'package main\n\n// FixtureGreet says hello.\nfunc FixtureGreet() string { return "hello" }\n';
	await writeFile(path.join(root, 'composer.json'), '{"name":"fixture/project"}');
	await writeFile(path.join(root, 'go.mod'), 'module example.invalid/fixture\ngo 1.21\n');
	await writeFile(phpFile, '<?php\nclass FixtureExample {}\n');
	await writeFile(goFile, goSource);
	await writeFile(targetFile, targetSource);
	const runtime=createTestLanguageRuntime();
 const phpAdapterInstance=phpAdapter(process.execPath,intelephense,''),goAdapterInstance=goAdapter(goPath,goplsPath);
 const navigation = new LspNavigation({...options,runtime}, [phpAdapterInstance,goAdapterInstance]);
	navigation.setWorkspaceRoot(root);
	let probe;
	try {
		const goSymbols = await navigation.symbols(undefined, targetFile);
		assert.ok(goSymbols.some((symbol) => symbol.name === 'FixtureGreet'));
		assert.equal(runtime.diagnostics().running,1,'Go documents must not start PHP');
		const phpSymbols = await navigation.symbols(undefined, phpFile);
		assert.ok(phpSymbols.some((symbol) => symbol.name === 'FixtureExample'));
		assert.equal(runtime.diagnostics().running,2);
  probe=runtime.acquire(goAdapterInstance,root,false,'query');
  const server=probe.value;
		const client = server.endpoint.client;
		const uri = pathToFileURL(goFile).href;
		const targetUri = pathToFileURL(targetFile).href;
		client.didOpen({ uri, languageId: 'go', version: 1, doc: Text.of(goSource.split('\n')), getView: () => null });
		const params = { textDocument: { uri }, position: { line: 2, character: goSource.split('\n')[2].indexOf('FixtureGreet') } };
		const definition = await client.request('textDocument/definition', params);
		assert.equal(definition[0].uri ?? definition[0].targetUri, targetUri);
		const hover = await client.request('textDocument/hover', params);
		assert.match(JSON.stringify(hover), /FixtureGreet/);
		const references = await client.request('textDocument/references', { ...params, context: { includeDeclaration: true } });
		assert.ok(references.some((reference) => reference.uri === uri));
		assert.ok(references.some((reference) => reference.uri === targetUri));
		const symbols = await navigation.workspaceSymbols('Fixture');
		assert.ok(symbols.some((symbol) => symbol.name === 'FixtureExample'));
		assert.ok(symbols.some((symbol) => symbol.name === 'FixtureGreet'));
 } finally {
  probe?.release();navigation.dispose();await runtime.dispose();
 }
 assert.equal(runtime.diagnostics().running,0);

});

test('a missing PHP binary does not suppress Go workspace symbols', { timeout: 30000, skip: !hasGo }, async () => {
	const root = await fixtures('missing-php');
	await writeFile(path.join(root, 'composer.json'), '{}');
	await writeFile(path.join(root, 'go.mod'), 'module example.invalid/fixture\ngo 1.21\n');
	await writeFile(path.join(root, 'service.go'), 'package fixture\nfunc FixtureGreet() string { return "hello" }\n');
	const runtime=createTestLanguageRuntime();
 const navigation = new LspNavigation({...options,runtime}, [phpAdapter('', '', ''), goAdapter(goPath, goplsPath)]);
	navigation.setWorkspaceRoot(root);
	try {
		const symbols = await navigation.workspaceSymbols('FixtureGreet');
		assert.ok(symbols.some((symbol) => symbol.name === 'FixtureGreet'));
	} finally { navigation.dispose();await runtime.dispose(); }
});

test('gopls uses go.work across modules and keeps standard-library jumps on the same server', { timeout: 45000, skip: !hasGo }, async () => {
	const root = await fixtures('workspace');
	const app = path.join(root, 'app');
	const lib = path.join(root, 'lib');
	await mkdir(app); await mkdir(lib);
	await writeFile(path.join(root, 'go.work'), 'go 1.21\nuse (\n ./app\n ./lib\n)\n');
	await writeFile(path.join(app, 'go.mod'), 'module example.invalid/app\ngo 1.21\n');
	await writeFile(path.join(lib, 'go.mod'), 'module example.invalid/lib\ngo 1.21\n');
	const file = path.join(app, 'main.go');
	const target = path.join(lib, 'lib.go');
	const source = 'package main\nimport ("example.invalid/lib"; "fmt")\nfunc main() { fmt.Println(lib.FixtureMessage()) }\n';
	await writeFile(file, source);
	await writeFile(target, 'package lib\nfunc FixtureMessage() string { return "hello" }\n');
	const runtime=createTestLanguageRuntime(),adapter=goAdapter(goPath,goplsPath);
 const navigation = new LspNavigation({...options,runtime}, [adapter]);
	navigation.setWorkspaceRoot(root);
	let probe;
	try {
		navigation.extensionFor(file);
		await navigation.symbols(undefined, file);
		assert.equal(runtime.diagnostics().running,1);
  probe=runtime.acquire(adapter,root,false,'query');
  const server=probe.value;
		const client = server.endpoint.client;
		const uri = pathToFileURL(file).href;
		client.didOpen({ uri, languageId: 'go', version: 1, doc: Text.of(source.split('\n')), getView: () => null });
		const definitionAt = (name) => client.request('textDocument/definition', { textDocument: { uri }, position: { line: 2, character: source.split('\n')[2].indexOf(name) } });
		const definition = await definitionAt('FixtureMessage');
		assert.equal(definition[0].uri ?? definition[0].targetUri, pathToFileURL(target).href);
		const stdlib = await definitionAt('Println');
		const stdlibUri = stdlib[0].uri ?? stdlib[0].targetUri;
		assert.match(stdlibUri, /fmt\/print.go$/);
		navigation.extensionFor(fileURLToPath(stdlibUri));
		assert.equal(runtime.diagnostics().running,1,'stdlib keeps the original workspace context');
		assert.ok((await navigation.workspaceSymbols('FixtureMessage')).some((symbol) => symbol.name === 'FixtureMessage'));
	} finally {
		probe?.release();navigation.dispose();await runtime.dispose();
	}
});

for(const language of ['php','go'])test(`real ${language} background-first and editor share client/live buffer; background release preserves navigation`,{timeout:30000,skip:language==='go'&&!hasGo},async()=>{
 const dom=await editorHarness(),root=await fixtures(`sharing-${language}`),runtime=createTestLanguageRuntime();
 const adapter=language==='go'?goAdapter(goPath,goplsPath):phpAdapter(process.execPath,intelephense,'');
 const file=path.join(root,language==='go'?'service.go':'Example.php');
 const before=language==='go'?'package fixture\nfunc FixtureBefore() int { return 1 }\nfunc Call() int { return FixtureBefore() }\n':'<?php\nclass FixtureBefore {}\nfunction make() { return new FixtureBefore(); }\n';
 await writeFile(file,before);await writeFile(path.join(root,language==='go'?'go.mod':'composer.json'),language==='go'?'module example.invalid/shared\ngo 1.21\n':'{}');
 const background=new LspNavigation({...options,runtime},[adapter]),foreground=new LspNavigation({...options,runtime},[adapter]);
 background.setWorkspaceRoot(root);foreground.setWorkspaceRoot(root);let editor,probe;
 try{
  assert.ok((await background.symbols(undefined,file)).some(s=>s.name==='FixtureBefore'));
  assert.equal(runtime.diagnostics().running,1);
  editor=new EditorView({parent:dom.container(),state:EditorState.create({doc:before,extensions:[foreground.extensionFor(file)]})});
  probe=runtime.acquire(adapter,root,false,'query');await probe.ready;
  assert.equal(LSPPlugin.get(editor).client,probe.value.endpoint.client);assert.equal(runtime.diagnostics().running,1);
  editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:before.replaceAll('FixtureBefore','FixtureAfter')}});
  const symbols=await background.symbols(undefined,file);assert.ok(symbols.some(s=>s.name==='FixtureAfter'));assert.ok(!symbols.some(s=>s.name==='FixtureBefore'));
  background.dispose();assert.equal(runtime.diagnostics().running,1);
  assert.ok((await foreground.symbols(undefined,file)).some(s=>s.name==='FixtureAfter'));
  assert.equal(probe.value.endpoint.workspace.getFile(pathToFileURL(file).href).doc.toString(),editor.state.doc.toString());
 }finally{editor?.destroy();probe?.release();background.dispose();foreground.dispose();await runtime.dispose();await dom.dispose();}
 assert.equal(runtime.diagnostics().running,0);assert.equal(runtime.diagnostics().leases,0);
});

test('workspace discovery of more than128 roots visits every project with bounded consumer concurrency',async()=>{
 let active=0,peak=0,visited=0;
 const runtime={acquire(_adapter,root){active++;peak=Math.max(peak,active);let released=false;return {ready:Promise.resolve(),get current(){return !released;},release(){if(!released){released=true;active--;}}
  ,value:{endpoint:{client:{sync(){},async request(){await new Promise(r=>setImmediate(r));visited++;return [{name:path.basename(root),kind:5,location:{uri:pathToFileURL(path.join(root,'main.php')).href,range:{start:{line:0,character:0},end:{line:0,character:1}}}}];}}}}};}};
 const adapter={...phpAdapter('','',''),workspaceRoots:async()=>Array.from({length:137},(_,i)=>`/virtual/root${i}`)};
 const navigation=new LspNavigation({...options,runtime},[adapter]);navigation.setWorkspaceRoot('/virtual');
 try{const symbols=await navigation.workspaceSymbols();assert.equal(symbols.length,137);assert.equal(visited,137);assert.ok(peak<=4);assert.equal(active,0);}finally{navigation.dispose();}
});

test('deferred language-root discovery from an older workspace never starts a server or publishes stale symbols',async()=>{
 let resolveA;const gate=new Promise(r=>resolveA=r),acquired=[];
 const runtime={acquire(_adapter,root){acquired.push(root);return {ready:Promise.resolve(),current:true,release(){},value:{endpoint:{client:{sync(){},async request(){return [];}}}}};}};
 const adapter={...phpAdapter('','',''),workspaceRoots:root=>root==='/workspace/a'?gate:Promise.resolve([root])};
 const navigation=new LspNavigation({...options,runtime},[adapter]);navigation.setWorkspaceRoot('/workspace/a');
 const old=navigation.workspaceSymbols('old');navigation.setWorkspaceRoot('/workspace/b');resolveA(['/workspace/a/project']);
 assert.deepEqual(await old,[]);assert.deepEqual(acquired,[]);await navigation.workspaceSymbols('current');assert.deepEqual(acquired,['/workspace/b']);navigation.dispose();
});

test('shared client background-first never captures F12 display of either editor; root change rejects late navigation',async()=>{
 const dom=await editorHarness(),calls=[],pending=[];let receive;
 const client=new LSPClient({workspace:c=>new ViewerWorkspace(c,async()=>null)});
 client.connect({subscribe(handler){receive=handler;},unsubscribe(){},send(text){
  const message=JSON.parse(text);
  if(message.method==='initialize')queueMicrotask(()=>receive(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{capabilities:{definitionProvider:true,textDocumentSync:2}}})));
  if(message.method==='textDocument/definition')pending.push(()=>receive(JSON.stringify({jsonrpc:'2.0',id:message.id,result:[{uri:'file:///target.php',range:{start:{line:0,character:0},end:{line:0,character:1}}}]})));
 }});await client.initializing;
 const runtime={acquire(){return {value:{endpoint:{client,workspace:client.workspace}},ready:client.initializing,current:true,release(){}};}};
 const adapter={...phpAdapter('','',''),projectRoot:()=>'/fixture',workspaceRoots:async()=>[]};
 const background=new LspNavigation({...options,runtime},[adapter]);background.setWorkspaceRoot('/fixture');await background.workspaceSymbols();
 const make=owner=>new LspNavigation({...options,runtime,display:async file=>{calls.push([owner,file]);return null;}},[adapter]);
 const a=make('a'),b=make('b');a.setWorkspaceRoot('/fixture');b.setWorkspaceRoot('/fixture');
 const editorA=new EditorView({parent:dom.container(),state:EditorState.create({doc:'call',extensions:[a.extensionFor('/fixture/source.php')]})});
 const editorB=new EditorView({parent:dom.container(),state:EditorState.create({doc:'call',extensions:[b.extensionFor('/fixture/source.php')]})});
 const tick=()=>new Promise(r=>setImmediate(r));
 try{
  assert.equal(a.jumpToDefinition(editorA),true);await tick();pending.shift()();await tick();
  assert.equal(b.jumpToDefinition(editorB),true);await tick();pending.shift()();await tick();
  assert.deepEqual(calls,[['a','/target.php'],['b','/target.php']]);
  a.jumpToDefinition(editorA);await tick();a.setWorkspaceRoot('/different');pending.shift()();await tick();assert.equal(calls.length,2);
  b.jumpToDefinition(editorB);await tick();b.dispose();pending.shift()();await tick();assert.equal(calls.length,2);
 }finally{editorA.destroy();editorB.destroy();a.dispose();b.dispose();background.dispose();client.workspace.dispose();client.disconnect();await dom.dispose();}
});
