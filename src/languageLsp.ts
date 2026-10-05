import { spawn, type ChildProcess } from 'child_process';
import * as fsp from 'fs/promises';
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
import type { LspAdapter } from './lspAdapter';
import {
	ViewerWorkspace, toLspSymbols, dispatchDefinitionLocation, type LspSymbol, type Position, type Range,
	type LspLocation, type DocumentSymbol, type SymbolInformation,
} from './lspWorkspace';
export type { LspSymbol } from './lspWorkspace';

const REQUEST_TIMEOUT_MS = 20000;
export interface LanguageLspOptions {
	app: App;
	adapter: LspAdapter;
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

function toFilePath(uri: string): string | null {
	try { return fileURLToPath(uri); } catch { return null; }
}

/** Shared read-only navigation and process lifecycle for one language adapter. */
export class LanguageLsp {
	private disposed = false;
	private servers = new Map<string, Server>();
	private failed = new Set<string>();
	private workspaceRootsCache = new Map<string, string[]>();
	private workspaceRoot: string | null = null;
	private activeRoot: string | null = null;
	private editorExtension: Extension;

	constructor(private opts: LanguageLspOptions) {
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
		if (normalizedRoot !== this.workspaceRoot) {
			this.workspaceRootsCache.clear();
			this.activeRoot = null;
		}
		this.workspaceRoot = normalizedRoot;
	}

	/** Attach only documents supported by this adapter. */
	extensionFor(filePath: string): Extension {
		const languageId = this.opts.adapter.languageId(filePath);
		if (!languageId) return [];
		const root = this.rootFor(filePath);
		const server = root ? this.serverFor(root) : null;
		if (server) this.activeRoot = root;
		return server ? server.client.plugin(pathToFileURL(path.resolve(filePath)).href, languageId) : [];
	}

	private rootFor(filePath: string): string | null {
		if (this.opts.adapter.externalFilesUseActiveRoot && this.activeRoot && this.workspaceRoot && !isWithin(filePath, this.workspaceRoot)) {
			return this.activeRoot;
		}
		return this.opts.adapter.projectRoot(filePath) ?? (this.workspaceRoot && isWithin(filePath, this.workspaceRoot) ? this.workspaceRoot : null);
	}

	/**
	 * Fetch symbols for a document when `filePath` is supplied, or workspace
	 * symbols for the configured root (optionally filtered by `query`).
	 */
	async symbols(query?: string, filePath?: string): Promise<LspSymbol[]> {
		if (this.disposed) return [];
		if (filePath) {
			if (!this.opts.adapter.languageId(filePath)) return [];
			const root = this.rootFor(filePath);
			if (!root) return [];
			const server = this.serverFor(root);
			if (!server) return [];
			try {
				await server.client.initializing;
				if (this.disposed) return [];
				return await this.requestDocumentSymbols(server, path.resolve(filePath));
			} catch (error) {
				if (!this.failed.has(root)) this.showFailure(root, `Could not load ${this.opts.adapter.name} symbols`, error);
				return [];
			}
		}

		const workspaceRoot = this.workspaceRoot;
		if (!workspaceRoot) return [];
		try {
			let roots = this.workspaceRootsCache.get(workspaceRoot);
			if (!roots) {
				roots = await this.opts.adapter.workspaceRoots(workspaceRoot, this.opts.includeWorktrees ?? false);
				if (this.disposed) return [];
				this.workspaceRootsCache.set(workspaceRoot, roots);
			}
			const projects = roots.length ? roots : [...this.servers.keys()];
			const results = await Promise.all(projects.map(async (root) => {
				const server = this.serverFor(root);
				if (!server) return [];
				try {
					await server.client.initializing;
					if (this.disposed) return [];
					server.client.sync();
					const result = await server.client.request<{ query: string }, SymbolInformation[] | null>(
						'workspace/symbol', { query: query ?? '' },
					);
					return this.disposed ? [] : toLspSymbols(result, '');
				} catch (error) {
					if (!this.failed.has(root)) this.showFailure(root, `Could not load ${this.opts.adapter.name} symbols`, error);
					return [];
				}
			}));
			return results.flat();
		} catch (error) {
			if (!this.failed.has(workspaceRoot)) this.showFailure(workspaceRoot, `Could not load ${this.opts.adapter.name} symbols`, error);
			return [];
		}
	}

	async workspaceSymbols(query = ''): Promise<LspSymbol[]> { return this.symbols(query); }
	async documentSymbols(filePath: string): Promise<LspSymbol[]> { return this.symbols(undefined, filePath); }

	/** Navigate to the definition at the current cursor. Suitable as a command callback. */
	jumpToDefinition(view: EditorView): boolean { return this.jump(view); }

	/** Show references for the symbol at the current cursor. */
	findReferences(view: EditorView): boolean { return this.references(view); }

	private jump(view: EditorView): boolean {
		const plugin = LSPPlugin.get(view);
		const capabilities = plugin?.client.serverCapabilities as unknown as { definitionProvider?: boolean } | null;
		if (this.disposed || !plugin || capabilities?.definitionProvider === false) return false;
		const initialDoc = view.state.doc;
		const initialHead = view.state.selection.main.head;
		const initialPosition = plugin.toPosition(initialHead) as unknown as Position;
		plugin.client.sync();
		void plugin.client.request<unknown, LspLocation | LspLocation[] | LocationLink[] | null>('textDocument/definition', {
			textDocument: { uri: plugin.uri }, position: initialPosition,
		}).then(async (response) => {
			if (this.disposed || LSPPlugin.get(view) !== plugin || view.state.doc !== initialDoc || view.state.selection.main.head !== initialHead) return;
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
			if (this.disposed || LSPPlugin.get(view) !== plugin || view.state.doc !== initialDoc || view.state.selection.main.head !== initialHead || !choice) return;
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
		if (this.disposed || !plugin) return false;
		plugin.client.sync();
		void plugin.client.request<unknown, LspLocation[] | null>('textDocument/references', {
			textDocument: { uri: plugin.uri },
			position: plugin.toPosition(view.state.selection.main.head) as unknown as Position,
			context: { includeDeclaration: true },
		}).then(async (locations) => {
			if (this.disposed || LSPPlugin.get(view) !== plugin) return;
			const workspace = plugin.client.workspace as ViewerWorkspace;
			await workspace.primeReferenceFiles((locations ?? []).map((location) => location.uri));
			try { if (!this.disposed && LSPPlugin.get(view) === plugin) findReferences(view); }
			finally { workspace.releasePrimedReferenceFiles(); }
		}).catch((error: unknown) => this.showFailure(path.dirname(toFilePath(plugin.uri) ?? ''), 'Finding references failed', error));
		return true;
	}

	private async requestDocumentSymbols(server: Server, filePath: string): Promise<LspSymbol[]> {
		const uri = pathToFileURL(filePath).href;
		let openedHere = false;
		if (!server.client.workspace.getFile(uri)) {
			const contents = await fsp.readFile(filePath, 'utf8');
			server.client.didOpen({ uri, languageId: this.opts.adapter.languageId(filePath) ?? 'plaintext', version: 1, doc: Text.of(contents.split(/\r?\n/)), getView: () => null });
			openedHere = true;
		}
		try {
			server.client.sync();
			const result = await server.client.request<unknown, DocumentSymbol[] | SymbolInformation[] | null>(
				'textDocument/documentSymbol', { textDocument: { uri } },
			);
			return toLspSymbols(result, uri);
		} finally {
			if (openedHere) server.client.didClose(uri);
		}
	}

	private serverFor(root: string): Server | null {
		if (this.disposed) return null;
		const normalizedRoot = path.resolve(root);
		const existing = this.servers.get(normalizedRoot);
		if (existing) return existing;
		if (this.failed.has(normalizedRoot)) return null;
		const command = this.opts.adapter.command();
		if (!command) {
			this.failed.add(normalizedRoot);
			new Notice(`Source Observer: ${this.opts.adapter.missingMessage}`);
			return null;
		}

		let proc: ChildProcess;
		try {
			proc = spawn(command.executable, command.args, {
				cwd: normalizedRoot, env: command.env, stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (error) {
			this.failed.add(normalizedRoot);
			this.showFailure(normalizedRoot, `Could not start ${this.opts.adapter.serverName}`, error);
			return null;
		}

		const rootName = path.basename(normalizedRoot);
		let server!: Server;
		const client = new LSPClient({
			rootUri: pathToFileURL(normalizedRoot).href,
			timeout: REQUEST_TIMEOUT_MS,
			initializationOptions: this.opts.adapter.initializationOptions?.(normalizedRoot),
			workspace: (current) => new ViewerWorkspace(current, this.opts.display, this.opts.adapter.languageId),
			notificationHandlers: {
				[this.opts.adapter.indexingNotifications?.start ?? '$/sourceObserver/unusedStart']: () => {
					server.indexingNotice?.hide();
					server.indexingNotice = new Notice(`Indexing ${this.opts.adapter.name} in ${rootName}…`, 0);
					return true;
				},
				[this.opts.adapter.indexingNotifications?.end ?? '$/sourceObserver/unusedEnd']: () => { server.indexingNotice?.hide(); server.indexingNotice = null; return true; },
			},
			extensions: [{
				editorExtension: this.editorExtension,
				clientCapabilities: { workspace: { configuration: true } },
			}],
		});
		server = { client, proc, root: normalizedRoot, indexingNotice: null };
		this.servers.set(normalizedRoot, server);
		proc.stderr?.on('data', () => { /* Drain diagnostic output without logging it. */ });
		proc.on('error', (error) => this.failServer(normalizedRoot, `Could not start ${this.opts.adapter.serverName}`, error));
		proc.on('close', (code) => {
			server.indexingNotice?.hide();
			server.indexingNotice = null;
			if (this.servers.get(normalizedRoot) === server) {
				this.failServer(normalizedRoot, `${this.opts.adapter.serverName} stopped${code === null ? '' : ` (exit ${code})`}`, null);
			}
		});
		let settingsPromise: Promise<unknown> | null = null;
		client.connect(stdioTransport(proc, () => {
			settingsPromise ??= this.opts.adapter.settings(normalizedRoot, this.opts.includeWorktrees ?? false);
			return settingsPromise;
		}, this.opts.adapter.configurationSection));
		void client.initializing.catch((error) => this.failServer(normalizedRoot, `${this.opts.adapter.serverName} initialization failed`, error));
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
		if (this.disposed) return;
		const detail = error instanceof Error ? `: ${error.message}` : '';
		const project = path.basename(root);
		new Notice(`Source Observer: ${reason}${project ? ` in ${project}` : ''}${detail}`);
	}

	/** Stops all language server processes and hides indexing notices on unload. */
	dispose() {
		this.disposed = true;
		for (const [root, { client, proc, indexingNotice }] of this.servers) {
			this.failed.add(root);
			indexingNotice?.hide();
			client.disconnect();
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
