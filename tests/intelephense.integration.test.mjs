import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { it } from 'node:test';
import { encodeLspMessage, takeLspMessages } from '../src/lspTransport.ts';
import { dispatchDefinitionLocation } from '../src/lspWorkspace.ts';
import { Text } from '@codemirror/state';

const serverPath = path.resolve('node_modules/intelephense/lib/intelephense.js');

it('starts Intelephense and supports symbols, definitions, hover and references', { timeout: 30000, skip: !existsSync(serverPath) }, async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'source-observer-lsp-'));
	const phpPath = path.join(root, 'src', 'Example.php');
	const targetPath = path.join(root, 'src', 'TargetService.php');
	const source = '<?php\nnamespace Fixture;\nclass Example { public function make(): TargetService { return new TargetService(); } public function greet(): string { return "hello"; } public function run(): string { return $this->greet(); } }\n';
	const targetSource = '<?php\nnamespace Fixture;\nclass TargetService {}\n';
	await mkdir(path.dirname(phpPath), { recursive: true });
	await writeFile(path.join(root, 'composer.json'), '{"name":"fixture/project"}');
	await writeFile(phpPath, source);
	await writeFile(targetPath, targetSource);

	const proc = spawn(process.execPath, [serverPath, '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
	let buffer = Buffer.alloc(0);
	let nextId = 1;
	const pending = new Map();
	const onData = (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		const parsed = takeLspMessages(buffer);
		buffer = parsed.rest;
		for (const raw of parsed.messages) {
			const message = JSON.parse(raw);
			if (message.method === 'workspace/configuration') {
				const items = message.params?.items ?? [];
				proc.stdin.write(encodeLspMessage(JSON.stringify({ jsonrpc: '2.0', id: message.id,
					result: items.map((item) => item.section === 'intelephense' ? { files: { exclude: ['**/vendor/**'] } } : null),
				})));
			} else if (message.id !== undefined && pending.has(message.id)) {
				const { resolve, reject } = pending.get(message.id);
				pending.delete(message.id);
				if (message.error) reject(new Error(message.error.message));
				else resolve(message.result);
			}
		}
	};
	proc.stdout.on('data', onData);
	const request = (method, params = {}) => new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		proc.stdin.write(encodeLspMessage(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
	});
	const notify = (method, params = {}) => proc.stdin.write(encodeLspMessage(JSON.stringify({ jsonrpc: '2.0', method, params })));

	try {
		const initialized = await request('initialize', {
			processId: process.pid,
			rootUri: pathToFileURL(root).href,
			rootPath: root,
			capabilities: { workspace: { configuration: true }, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
			initializationOptions: { storagePath: path.join(root, '.cache'), globalStoragePath: path.join(root, '.cache') },
		});
		assert.ok(initialized.capabilities?.documentSymbolProvider);
		notify('initialized');
		const uri = pathToFileURL(phpPath).href;
		notify('textDocument/didOpen', { textDocument: { uri, languageId: 'php', version: 1,
			text: source } });
		const targetUri = pathToFileURL(targetPath).href;
		notify('textDocument/didOpen', { textDocument: { uri: targetUri, languageId: 'php', version: 1, text: targetSource } });
		const symbols = await request('textDocument/documentSymbol', { textDocument: { uri } });
		assert.ok(symbols.some((symbol) => symbol.name === 'Example'));
		const workspaceSymbols = await request('workspace/symbol', { query: 'Example' });
		assert.ok(workspaceSymbols.some((symbol) => symbol.name === 'Example'));
		const definitionPosition = { line: 2, character: source.split('\n')[2].indexOf('TargetService') };
		const rawDefinition = await request('textDocument/definition', { textDocument: { uri }, position: definitionPosition });
		const definitionResult = Array.isArray(rawDefinition) ? rawDefinition[0] : rawDefinition;
		const definition = 'uri' in definitionResult
			? definitionResult
			: { uri: definitionResult.targetUri, range: definitionResult.targetSelectionRange ?? definitionResult.targetRange };
		assert.equal(definition.uri, targetUri);
		const hover = await request('textDocument/hover', { textDocument: { uri }, position: definitionPosition });
		assert.match(JSON.stringify(hover), /TargetService/);

		const sourceDoc = Text.of(source.split('\n'));
		const targetDoc = Text.of(targetSource.split('\n'));
		const makeView = (doc) => ({
			state: { doc },
			dispatch(spec) { this.lastTransaction = spec; },
			focus() { this.focused = true; },
		});
		const sourceView = makeView(sourceDoc);
		const targetView = makeView(targetDoc);
		let remembered = false;
		const didNavigate = await dispatchDefinitionLocation(
			definition,
			uri,
			sourceView,
			async (targetUriValue) => targetUriValue === definition.uri ? targetView : null,
			() => { remembered = true; },
			(view, position) => view.state.doc.line(position.line + 1).from + position.character,
		);
		assert.equal(didNavigate, true);
		assert.equal(remembered, true);
		assert.equal(targetView.lastTransaction.selection.anchor, targetDoc.line(definition.range.start.line + 1).from + definition.range.start.character);
		assert.equal(targetView.focused, true);

		const references = await request('textDocument/references', {
			textDocument: { uri },
			position: { line: 2, character: source.split('\n')[2].indexOf('greet') },
			context: { includeDeclaration: true },
		});
		assert.ok(references.length >= 2);
	} finally {
		proc.kill();
		await rm(root, { recursive: true, force: true });
	}
});
