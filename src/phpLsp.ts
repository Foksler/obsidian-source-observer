import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { App, Notice, Platform, SuggestModal } from 'obsidian';
import { Text, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import {
	LSPClient, LSPPlugin,
	findReferences, closeReferencePanel,
} from '@codemirror/lsp-client';
import { hoverTooltips } from './hoverRendering';
import { stdioTransport } from './lspTransport';
import { isPhpFile } from './phpFiles';
import {
	ViewerWorkspace, toPhpSymbols, dispatchDefinitionLocation, type PhpSymbol, type Position, type Range,
	type LspLocation, type DocumentSymbol, type SymbolInformation,
} from './lspWorkspace';
import { createIntelephenseSettings, findWorkspaceComposerRoots } from './lspWorkspaceRoots';
export type { PhpSymbol } from './lspWorkspace';

const REQUEST_TIMEOUT_MS = 20000;
export interface PhpLspOptions {
	app: App;
	nodePath: string;
	serverPath: string;
	licenceKey: string;
	/** Shows `filePath` in the code pane and resolves with its editor once loaded. */
	display: (filePath: string) => Promise<EditorView | null>;
	/** Called immediately before changing the displayed file during navigation. */
	beforeJump: () => void;
	/** Include duplicate working trees in the language server index. Defaults to false. */
	includeWorktrees?: boolean;
}

interface LocationLink {
	targetUri: string;
	targetRange: Range;
	targetSelectionRange?: Range;
}
interface DefinitionChoice { location: LspLocation; filePath: string }
interface Server { client: LSPClient; proc: ChildProcess; root: string; indexingNotice: Notice | null }

class DefinitionChooser extends SuggestModal<DefinitionChoice> {
	private settled = false;

	constructor(app: App, private choices: DefinitionChoice[], private finish: (choice: DefinitionChoice | null) => void) {
		super(app);
		this.setPlaceholder('Choose a definition');
	}

	getSuggestions(query: string): DefinitionChoice[] {
		const normalized = query.toLocaleLowerCase();
		return this.choices.filter((choice) => choice.filePath.toLocaleLowerCase().includes(normalized));
	}

	renderSuggestion(choice: DefinitionChoice, element: HTMLElement) {
		element.createEl('div', { text: choice.filePath });
		element.createEl('small', { text: `Line ${choice.location.range.start.line + 1}` });
	}

	onChooseSuggestion(choice: DefinitionChoice) { this.settle(choice); }

	onClose() { this.settle(null); }

	private settle(choice: DefinitionChoice | null) {
		if (this.settled) return;
		this.settled = true;
		this.finish(choice);
	}
}

function afterOrEqual(a: Position, b: Position): boolean {
	return a.line > b.line || (a.line === b.line && a.character >= b.character);
}

function contains(range: Range, position: Position): boolean {
	return afterOrEqual(position, range.start) && afterOrEqual(range.end, position);
}

function normalizeLocation(location: LspLocation | LocationLink): LspLocation {
	return 'uri' in location
		? location
		: { uri: location.targetUri, range: location.targetSelectionRange ?? location.targetRange };
}

function firstExisting(candidates: string[]): string {
	return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? '';
}

/** Finds a `node` binary; Obsidian's own Electron refuses ELECTRON_RUN_AS_NODE. */
export function detectNode(): string {
	const home = os.homedir();
	return firstExisting([
		path.join(home, '.local/bin/node'), '/opt/homebrew/bin/node',
		'/usr/local/bin/node', '/usr/bin/node',
	]);
}

/** Finds the newest Intelephense server bundled with Cursor or VS Code. */
export function detectIntelephense(): string {
	const home = os.homedir();
	for (const editorDir of ['.cursor/extensions', '.vscode/extensions']) {
		let entries: string[];
		try { entries = fs.readdirSync(path.join(home, editorDir)); } catch { continue; }
		const ext = entries.filter((entry) => entry.startsWith('bmewburn.vscode-intelephense-client-'))
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
		if (!ext) continue;
		const server = path.join(home, editorDir, ext, 'node_modules/intelephense/lib/intelephense.js');
		if (fs.existsSync(server)) return server;
	}
	return '';
}

/**
 * Nearest Composer folder above a file. Files in vendor belong to the project
 * owning that vendor tree, rather than a package's own composer.json.
 */
export function findComposerRoot(filePath: string): string | null {
	const parts = path.dirname(path.resolve(filePath)).split(path.sep);
	const vendorAt = parts.indexOf('vendor');
	let dir = vendorAt > 0 ? parts.slice(0, vendorAt).join(path.sep) : parts.join(path.sep);
	if (!dir) dir = path.parse(path.resolve(filePath)).root;
	for (;;) {
		if (fs.existsSync(path.join(dir, 'composer.json'))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function toFilePath(uri: string): string | null {
	try { return fileURLToPath(uri); } catch { return null; }
}

/** Runs Intelephense per project and exposes read-only PHP navigation. */
export class PhpLsp {
	private servers = new Map<string, Server>();
	private failed = new Set<string>();
	private workspaceRootsCache = new Map<string, string[]>();
	private workspaceRoot: string | null = null;
	private editorExtension: Extension;

	constructor(private opts: PhpLspOptions) {
		const jump = (view: EditorView) => this.jump(view);
		this.editorExtension = [
			hoverTooltips(this.opts.app),
			keymap.of([
				{ key: 'F12', run: jump, preventDefault: true },
				{ key: 'Shift-F12', run: (view) => this.references(view), preventDefault: true },
				{ key: 'Escape', run: closeReferencePanel },
			]),
			EditorView.domEventHandlers({
				mousedown: (event, view) => {
					const modifier = Platform.isMacOS ? event.metaKey : event.ctrlKey;
					if (!modifier || event.button !== 0) return false;
					const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
					if (position === null) return false;
					event.preventDefault();
					view.dispatch({ selection: { anchor: position } });
					this.jump(view);
					return true;
				},
			}),
		];
	}

	/** Selects the default root used by workspace-symbol queries. */
	setWorkspaceRoot(root: string) {
		const normalizedRoot = root ? path.resolve(root) : null;
		if (normalizedRoot !== this.workspaceRoot) this.workspaceRootsCache.clear();
		this.workspaceRoot = normalizedRoot;
	}

	/** Extension for PHP files belonging to a Composer project. */
	extensionFor(filePath: string): Extension {
		if (!isPhpFile(filePath)) return [];
		const root = findComposerRoot(filePath) ?? (this.workspaceRoot && isWithin(filePath, this.workspaceRoot) ? this.workspaceRoot : null);
		const server = root ? this.serverFor(root) : null;
		return server ? server.client.plugin(pathToFileURL(path.resolve(filePath)).href, 'php') : [];
	}

	/**
	 * Fetch symbols for a document when `filePath` is supplied, or workspace
	 * symbols for the configured root (optionally filtered by `query`).
	 */
	async symbols(query?: string, filePath?: string): Promise<PhpSymbol[]> {
		if (filePath) {
			const root = findComposerRoot(filePath) ?? (this.workspaceRoot && isWithin(filePath, this.workspaceRoot) ? this.workspaceRoot : null);
			if (!root) return [];
			const server = this.serverFor(root);
			if (!server) return [];
			try {
				await server.client.initializing;
				return await this.requestDocumentSymbols(server, path.resolve(filePath));
			} catch (error) {
				if (!this.failed.has(root)) this.showFailure(root, 'Could not load PHP symbols', error);
				return [];
			}
		}

		const workspaceRoot = this.workspaceRoot;
		if (!workspaceRoot) return [];
		try {
			let roots = this.workspaceRootsCache.get(workspaceRoot);
			if (!roots) {
				roots = await findWorkspaceComposerRoots(workspaceRoot, this.opts.includeWorktrees ?? false);
				this.workspaceRootsCache.set(workspaceRoot, roots);
			}
			const projects = roots.length ? roots : [workspaceRoot];
			const results = await Promise.all(projects.map(async (root) => {
				const server = this.serverFor(root);
				if (!server) return [];
				await server.client.initializing;
				server.client.sync();
				const result = await server.client.request<{ query: string }, SymbolInformation[] | null>(
					'workspace/symbol', { query: query ?? '' },
				);
				return toPhpSymbols(result, '');
			}));
			return results.flat();
		} catch (error) {
			if (!this.failed.has(workspaceRoot)) this.showFailure(workspaceRoot, 'Could not load PHP symbols', error);
			return [];
		}
	}

	async workspaceSymbols(query = ''): Promise<PhpSymbol[]> { return this.symbols(query); }
	async documentSymbols(filePath: string): Promise<PhpSymbol[]> { return this.symbols(undefined, filePath); }

	/** Navigate to the definition at the current cursor. Suitable as a command callback. */
	jumpToDefinition(view: EditorView): boolean { return this.jump(view); }

	/** Show references for the symbol at the current cursor. */
	findReferences(view: EditorView): boolean { return this.references(view); }

	private jump(view: EditorView): boolean {
		const plugin = LSPPlugin.get(view);
		const capabilities = plugin?.client.serverCapabilities as unknown as { definitionProvider?: boolean } | null;
		if (!plugin || capabilities?.definitionProvider === false) return false;
		const initialDoc = view.state.doc;
		const initialHead = view.state.selection.main.head;
		const initialPosition = plugin.toPosition(initialHead) as unknown as Position;
		plugin.client.sync();
		void plugin.client.request<unknown, LspLocation | LspLocation[] | LocationLink[] | null>('textDocument/definition', {
			textDocument: { uri: plugin.uri }, position: initialPosition,
		}).then(async (response) => {
			if (view.state.doc !== initialDoc || view.state.selection.main.head !== initialHead) return;
			const rawLocations = response ? (Array.isArray(response) ? response : [response]) : [];
			const locations = rawLocations.map(normalizeLocation)
				.filter((location) => toFilePath(location.uri) !== null)
				.filter((location, index, all) => all.findIndex((other) =>
					other.uri === location.uri && other.range.start.line === location.range.start.line &&
					other.range.start.character === location.range.start.character) === index);
			if (locations.length === 1 && locations[0]?.uri === plugin.uri && contains(locations[0].range, initialPosition)) {
				this.references(view);
				return;
			}
		const choice = await this.chooseDefinition(locations);
			if (view.state.doc !== initialDoc || view.state.selection.main.head !== initialHead || !choice) return;
			const location = choice.location;
			if (!location) return;
			await dispatchDefinitionLocation(
				location,
				plugin.uri,
				view,
				(uri) => plugin.client.workspace.displayFile(uri),
				this.opts.beforeJump,
				(target, position) => {
					const targetPlugin = LSPPlugin.get(target);
					return targetPlugin
						? targetPlugin.fromPosition(position, target.state.doc)
						: positionToOffset(position, target.state.doc);
				},
			);
		}).catch((error: unknown) => this.showFailure(path.dirname(toFilePath(plugin.uri) ?? ''), 'Find definition failed', error));
		return true;
	}

	private chooseDefinition(locations: LspLocation[]): Promise<DefinitionChoice | null> {
		const choices = locations.flatMap((location) => {
			const filePath = toFilePath(location.uri);
			return filePath ? [{ location, filePath }] : [];
		});
		if (choices.length === 1) return Promise.resolve(choices[0] ?? null);
		if (!choices.length) return Promise.resolve(null);
		return new Promise((resolve) => new DefinitionChooser(this.opts.app, choices, resolve).open());
	}

	private references(view: EditorView): boolean {
		const plugin = LSPPlugin.get(view);
		if (!plugin) return false;
		plugin.client.sync();
		void plugin.client.request<unknown, LspLocation[] | null>('textDocument/references', {
			textDocument: { uri: plugin.uri },
			position: plugin.toPosition(view.state.selection.main.head) as unknown as Position,
			context: { includeDeclaration: true },
		}).then(async (locations) => {
			const workspace = plugin.client.workspace as ViewerWorkspace;
			await workspace.primeReferenceFiles((locations ?? []).map((location) => location.uri));
			findReferences(view);
			workspace.releasePrimedReferenceFiles();
		}).catch((error: unknown) => this.showFailure(path.dirname(toFilePath(plugin.uri) ?? ''), 'Finding references failed', error));
		return true;
	}

	private async requestDocumentSymbols(server: Server, filePath: string): Promise<PhpSymbol[]> {
		const uri = pathToFileURL(filePath).href;
		let openedHere = false;
		if (!server.client.workspace.getFile(uri)) {
			const contents = await fsp.readFile(filePath, 'utf8');
			server.client.didOpen({ uri, languageId: 'php', version: 1, doc: Text.of(contents.split(/\r?\n/)), getView: () => null });
			openedHere = true;
		}
		try {
			server.client.sync();
			const result = await server.client.request<unknown, DocumentSymbol[] | SymbolInformation[] | null>(
				'textDocument/documentSymbol', { textDocument: { uri } },
			);
			return toPhpSymbols(result, uri);
		} finally {
			if (openedHere) server.client.didClose(uri);
		}
	}

	private serverFor(root: string): Server | null {
		const normalizedRoot = path.resolve(root);
		const existing = this.servers.get(normalizedRoot);
		if (existing) return existing;
		if (this.failed.has(normalizedRoot)) return null;
		if (!this.opts.nodePath || !this.opts.serverPath) {
			this.failed.add(normalizedRoot);
			new Notice('Source Observer: PHP navigation needs Node.js and Intelephense; set their paths in settings.');
			return null;
		}

		let proc: ChildProcess;
		try {
			proc = spawn(this.opts.nodePath, [this.opts.serverPath, '--stdio'], {
				cwd: normalizedRoot, stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (error) {
			this.failed.add(normalizedRoot);
			this.showFailure(normalizedRoot, 'Could not start Intelephense', error);
			return null;
		}

		const globalStorage = path.join(os.homedir(), '.cache', 'source-observer-intelephense');
		const rootStorage = path.join(globalStorage, createHash('sha256').update(normalizedRoot).digest('hex'));
		const storage = path.join(rootStorage, 'workspace');
		const rootName = path.basename(normalizedRoot);
		let server!: Server;
		const client = new LSPClient({
			rootUri: pathToFileURL(normalizedRoot).href,
			timeout: REQUEST_TIMEOUT_MS,
			initializationOptions: {
				storagePath: storage, globalStoragePath: path.join(rootStorage, 'global'),
				...(this.opts.licenceKey ? { licenceKey: this.opts.licenceKey } : {}),
			},
			workspace: (current) => new ViewerWorkspace(current, this.opts.display),
			notificationHandlers: {
				indexingStarted: () => {
					server.indexingNotice?.hide();
					server.indexingNotice = new Notice(`Indexing PHP in ${rootName}…`, 0);
					return true;
				},
				indexingEnded: () => { server.indexingNotice?.hide(); server.indexingNotice = null; return true; },
			},
			extensions: [{
			editorExtension: this.editorExtension,
			clientCapabilities: { workspace: { configuration: true } },
		}],
		});
		server = { client, proc, root: normalizedRoot, indexingNotice: null };
		this.servers.set(normalizedRoot, server);
		proc.stderr?.on('data', () => { /* Drain diagnostic output without logging it. */ });
		proc.on('error', (error) => this.failServer(normalizedRoot, 'Could not start Intelephense', error));
		proc.on('close', (code) => {
			server.indexingNotice?.hide();
			server.indexingNotice = null;
			if (this.servers.get(normalizedRoot) === server) {
				this.failServer(normalizedRoot, `Intelephense stopped${code === null ? '' : ` (exit ${code})`}`, null);
			}
		});
		let settingsPromise: Promise<unknown> | null = null;
		client.connect(stdioTransport(proc, () => {
			settingsPromise ??= createIntelephenseSettings(normalizedRoot, this.opts.includeWorktrees ?? false);
			return settingsPromise;
		}));
		void client.initializing.catch((error) => this.failServer(normalizedRoot, 'Intelephense initialization failed', error));
		return server;
	}

	private failServer(root: string, reason: string, error: unknown) {
		if (this.failed.has(root)) return;
		this.failed.add(root);
		this.showFailure(root, reason, error);
		const server = this.servers.get(root);
		if (!server) return;
		server.indexingNotice?.hide();
		server.indexingNotice = null;
		this.servers.delete(root);
		server.client.disconnect();
		if (server.proc.exitCode === null) server.proc.kill();
	}

	private showFailure(root: string, reason: string, error: unknown) {
		const detail = error instanceof Error ? `: ${error.message}` : '';
		const project = path.basename(root);
		new Notice(`Source Observer: ${reason}${project ? ` in ${project}` : ''}${detail}`);
	}

	/** Stops all language server processes and hides indexing notices on unload. */
	dispose() {
		for (const [root, { client, proc, indexingNotice }] of this.servers) {
			this.failed.add(root);
			indexingNotice?.hide();
			client.disconnect();
			proc.removeAllListeners('close');
			proc.removeAllListeners('error');
			proc.kill();
		}
		this.servers.clear();
	}
}

function isWithin(filePath: string, root: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(filePath));
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function positionToOffset(position: Position, doc: Text): number {
	const line = Math.max(1, Math.min(position.line + 1, doc.lines));
	const lineInfo = doc.line(line);
	return lineInfo.from + Math.max(0, Math.min(position.character, lineInfo.length));
}
