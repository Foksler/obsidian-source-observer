import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Text } from '@codemirror/state';

const temp = await mkdtemp(path.join(process.cwd(), 'tests', '.lsp-adapters-'));
const bundle = path.join(temp, 'adapters.mjs');
await build({
	stdin: { contents: `export * from './src/lspNavigation.ts'; export * from './src/goAdapter.ts'; export * from './src/phpAdapter.ts'; export * from './src/lspWorkspace.ts';`, resolveDir: process.cwd() },
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
	ViewerWorkspace, detectGo, detectGopls, navigationAdapters } = await import(pathToFileURL(bundle).href);
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
	const workspace = new ViewerWorkspace({}, async () => null, goLanguageId);
	const snapshot = await workspace.requestFile(pathToFileURL(file).href);
	assert.equal(snapshot.languageId, 'go');
	assert.equal(snapshot.doc.toString(), 'package main\n');
});

test('disabled languages are absent and unsupported documents never spawn a server', () => {
	const settings = { phpLsp: true, goLsp: false, nodePath: process.execPath, intelephensePath: intelephense, intelephenseLicence: '', goPath: '', goplsPath: '' };
	const navigation = new LspNavigation(options, navigationAdapters(settings));
	assert.equal(navigation.supports('main.go'), false);
	assert.equal(navigation.supports('index.php'), true);
	assert.deepEqual(navigation.extensionFor('main.rs'), []);
	assert.equal(navigation.languages[0].lsp.servers.size, 0);
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
	const navigation = new LspNavigation(options, [phpAdapter(process.execPath, intelephense, ''), goAdapter(goPath, goplsPath)]);
	navigation.setWorkspaceRoot(root);
	const [php, go] = navigation.languages.map(({ lsp }) => lsp);
	const processes = [];
	try {
		const goSymbols = await navigation.symbols(undefined, targetFile);
		assert.ok(goSymbols.some((symbol) => symbol.name === 'FixtureGreet'));
		assert.equal(php.servers.size, 0, 'Go documents must not start PHP');
		const phpSymbols = await navigation.symbols(undefined, phpFile);
		assert.ok(phpSymbols.some((symbol) => symbol.name === 'FixtureExample'));
		assert.equal(go.servers.size, 1);
		const server = [...go.servers.values()][0];
		const client = server.client;
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
		for (const language of [php, go]) for (const { proc } of language.servers.values()) processes.push(proc);
		const stopped = processes.map((proc) => once(proc, 'close'));
		navigation.dispose();
		await Promise.all(stopped);
	}
	assert.equal(php.servers.size, 0);
	assert.equal(go.servers.size, 0);
	assert.ok(processes.every((proc) => proc.killed || proc.exitCode !== null));
	assert.deepEqual(await navigation.workspaceSymbols(''), []);
});

test('a missing PHP binary does not suppress Go workspace symbols', { timeout: 30000, skip: !hasGo }, async () => {
	const root = await fixtures('missing-php');
	await writeFile(path.join(root, 'composer.json'), '{}');
	await writeFile(path.join(root, 'go.mod'), 'module example.invalid/fixture\ngo 1.21\n');
	await writeFile(path.join(root, 'service.go'), 'package fixture\nfunc FixtureGreet() string { return "hello" }\n');
	const navigation = new LspNavigation(options, [phpAdapter('', '', ''), goAdapter(goPath, goplsPath)]);
	navigation.setWorkspaceRoot(root);
	try {
		const symbols = await navigation.workspaceSymbols('FixtureGreet');
		assert.ok(symbols.some((symbol) => symbol.name === 'FixtureGreet'));
	} finally { navigation.dispose(); }
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
	const navigation = new LspNavigation(options, [goAdapter(goPath, goplsPath)]);
	navigation.setWorkspaceRoot(root);
	const go = navigation.languages[0].lsp;
	try {
		navigation.extensionFor(file);
		await navigation.symbols(undefined, file);
		assert.equal(go.servers.size, 1);
		const server = go.servers.get(root);
		const client = server.client;
		const uri = pathToFileURL(file).href;
		client.didOpen({ uri, languageId: 'go', version: 1, doc: Text.of(source.split('\n')), getView: () => null });
		const definitionAt = (name) => client.request('textDocument/definition', { textDocument: { uri }, position: { line: 2, character: source.split('\n')[2].indexOf(name) } });
		const definition = await definitionAt('FixtureMessage');
		assert.equal(definition[0].uri ?? definition[0].targetUri, pathToFileURL(target).href);
		const stdlib = await definitionAt('Println');
		const stdlibUri = stdlib[0].uri ?? stdlib[0].targetUri;
		assert.match(stdlibUri, /fmt\/print.go$/);
		navigation.extensionFor(fileURLToPath(stdlibUri));
		assert.equal(go.servers.size, 1, 'stdlib keeps the original workspace context');
		assert.ok((await navigation.workspaceSymbols('FixtureMessage')).some((symbol) => symbol.name === 'FixtureMessage'));
	} finally {
		const stopped = [...go.servers.values()].map(({ proc }) => once(proc, 'close'));
		navigation.dispose(); await Promise.all(stopped);
	}
});
