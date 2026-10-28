import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { App, Notice, Platform, SuggestModal } from 'obsidian';
import { type Text, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import { LSPPlugin, findReferences, closeReferencePanel, } from '@codemirror/lsp-client';
import { hoverTooltips } from './hoverRendering.ts';
import type {CodeMirrorLanguageRuntime,CodeMirrorLanguageResource} from './CodeMirrorEndpoint.ts';
import type { ServerLease } from '../language/index.ts';
import type { LspAdapter } from '../language/index.ts';
import {ViewerWorkspace,dispatchDefinitionLocation} from './lspWorkspace.ts';
import {toLspSymbols,type LspSymbol,type Position,type Range,type LspLocation,type DocumentSymbol,type SymbolInformation} from '../language/index.ts';
export type {LspSymbol} from '../language/index.ts';
export interface LanguageLspOptions {
    runtime: CodeMirrorLanguageRuntime;
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
interface DefinitionChoice {
    location: LspLocation;
    filePath: string;
}
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
        if (this.settled)
            return;
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
    try {
        return fileURLToPath(uri);
    }
    catch {
        return null;
    }
}
/** Shared read-only navigation and process lifecycle for one language adapter. */
export class LanguageLsp {
    private disposed = false;
    private runtime:CodeMirrorLanguageRuntime;
        private editorLease?: ServerLease<CodeMirrorLanguageResource>;
    private editorRoot: string | null = null;
    private queryLeases = new Set<ServerLease<CodeMirrorLanguageResource>>();
    private generation = 0;
    private failed = new Set<string>();
    private workspaceRootsCache = new Map<string, string[]>();
    private workspaceRoot: string | null = null;
    private activeRoot: string | null = null;
    private editorExtension: Extension;
    constructor(private opts: LanguageLspOptions) {
        this.runtime=opts.runtime;
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
                    if (!modifier || event.button !== 0)
                        return false;
                    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
                    if (position === null)
                        return false;
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
            this.generation++;
            this.detachEditor();
            for (const lease of this.queryLeases)
                lease.release();
            this.queryLeases.clear();
            this.workspaceRootsCache.clear();
            this.activeRoot = null;
        }
        this.workspaceRoot = normalizedRoot;
    }
    detachEditor() { this.editorLease?.release(); this.editorLease = undefined; this.editorRoot = null; }
    /** Synchronous editor attachment can wait in the registry's process queue. */
    extensionFor(filePath: string): Extension {
        const languageId = this.opts.adapter.languageId(filePath), root = this.rootFor(filePath);
        if (!languageId || !root || this.disposed) {
            this.detachEditor();
            return [];
        }
        if (this.editorRoot !== root || !this.editorLease?.current) {
            this.detachEditor();
            this.editorLease = this.acquire(root, 'editor') ?? undefined;
            this.editorRoot = root;
        }
        const lease = this.editorLease;
        if (!lease)
            return [];
        this.activeRoot = root;
        const workspace = lease.value.endpoint.workspace, display = this.opts.display;
        return [lease.value.endpoint.client.plugin(pathToFileURL(path.resolve(filePath)).href, languageId), this.editorExtension,
            ViewPlugin.define(view => { const release = workspace.bindDisplay(view, display); return { destroy: release }; })];
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
        if (this.disposed)
            return [];
        const generation = this.generation;
        if (filePath) {
            if (!this.opts.adapter.languageId(filePath))
                return [];
            const root = this.rootFor(filePath);
            if (!root)
                return [];
            return this.withServer(root, generation, server => this.requestDocumentSymbols(server, path.resolve(filePath)));
        }
        const workspaceRoot = this.workspaceRoot;
        if (!workspaceRoot)
            return [];
        try {
            let roots = this.workspaceRootsCache.get(workspaceRoot);
            if (!roots) {
                roots = await this.opts.adapter.workspaceRoots(workspaceRoot, this.opts.includeWorktrees ?? false);
                if (this.disposed || generation !== this.generation)
                    return [];
                this.workspaceRootsCache.set(workspaceRoot, roots);
            }
            const projects = roots.length ? roots : this.editorRoot ? [this.editorRoot] : [];
            const results: LspSymbol[][] = Array.from({ length: projects.length }, () => [] as LspSymbol[]);
            let next = 0;
            // Visit every root while limiting each consumer's queued leases.
            await Promise.all(Array.from({ length: Math.min(4, projects.length) }, async () => {
                while (!this.disposed && generation === this.generation) {
                    const index = next++;
                    if (index >= projects.length)
                        return;
                    results[index] = await this.withServer(projects[index]!, generation, async (server) => {
                        server.endpoint.client.sync();
                        const result = await server.endpoint.client.request<{
                            query: string;
                        }, SymbolInformation[] | null>('workspace/symbol', { query: query ?? '' });
                        return toLspSymbols(result, '');
                    });
                }
            }));
            return results.flat();
        }
        catch (error) {
            if (!this.disposed && generation === this.generation)
                this.showFailure(workspaceRoot, `Could not load ${this.opts.adapter.name} symbols`, error);
            return [];
        }
    }
    private acquire(root: string, usage: 'editor' | 'query'): ServerLease<CodeMirrorLanguageResource> | null {
        if (this.disposed || this.failed.has(root))
            return null;
        try {
            const lease = this.runtime.acquire(this.opts.adapter, root, this.opts.includeWorktrees ?? false, usage);
            void lease.ready.catch(error => {
                if (lease.current && !this.disposed)
                    this.showFailure(root, `${this.opts.adapter.serverName} initialization failed`, error);
            });
            return lease;
        }
        catch (error) {
            this.failed.add(root);
            this.showFailure(root, `Could not start ${this.opts.adapter.serverName}`, error);
            return null;
        }
    }
    private async withServer(root: string, generation: number, operation: (server: CodeMirrorLanguageResource) => Promise<LspSymbol[]>): Promise<LspSymbol[]> {
        const lease = this.acquire(root, 'query');
        if (!lease)
            return [];
        this.queryLeases.add(lease);
        try {
            await lease.ready;
            if (this.disposed || generation !== this.generation || !lease.current)
                return [];
            const result = await operation(lease.value);
            return this.disposed || generation !== this.generation || !lease.current ? [] : result;
        }
        catch (error) {
            if (!this.disposed && generation === this.generation && lease.current)
                this.showFailure(root, `Could not load ${this.opts.adapter.name} symbols`, error);
            return [];
        }
        finally {
            this.queryLeases.delete(lease);
            lease.release();
        }
    }
    async workspaceSymbols(query = ''): Promise<LspSymbol[]> { return this.symbols(query); }
    async documentSymbols(filePath: string): Promise<LspSymbol[]> { return this.symbols(undefined, filePath); }
    /** Navigate to the definition at the current cursor. Suitable as a command callback. */
    jumpToDefinition(view: EditorView): boolean { return this.jump(view); }
    /** Show references for the symbol at the current cursor. */
    findReferences(view: EditorView): boolean { return this.references(view); }
    private jump(view: EditorView): boolean {
        const generation = this.generation;
        const plugin = LSPPlugin.get(view);
        const capabilities = plugin?.client.serverCapabilities as unknown as {
            definitionProvider?: boolean;
        } | null;
        if (this.disposed || generation !== this.generation || !plugin || capabilities?.definitionProvider === false)
            return false;
        const initialDoc = view.state.doc;
        const initialHead = view.state.selection.main.head;
        const initialPosition = plugin.toPosition(initialHead) as unknown as Position;
        plugin.client.sync();
        void plugin.client.request<unknown, LspLocation | LspLocation[] | LocationLink[] | null>('textDocument/definition', {
            textDocument: { uri: plugin.uri }, position: initialPosition,
        }).then(async (response) => {
            if (this.disposed || generation !== this.generation || LSPPlugin.get(view) !== plugin || view.state.doc !== initialDoc || view.state.selection.main.head !== initialHead)
                return;
            const rawLocations = response ? (Array.isArray(response) ? response : [response]) : [];
            const locations = rawLocations.map(normalizeLocation)
                .filter((location) => toFilePath(location.uri) !== null)
                .filter((location, index, all) => all.findIndex((other) => other.uri === location.uri && other.range.start.line === location.range.start.line &&
                other.range.start.character === location.range.start.character) === index);
            if (locations.length === 1 && locations[0]?.uri === plugin.uri && contains(locations[0].range, initialPosition)) {
                this.references(view);
                return;
            }
            const choice = await this.chooseDefinition(locations);
            if (this.disposed || generation !== this.generation || LSPPlugin.get(view) !== plugin || view.state.doc !== initialDoc || view.state.selection.main.head !== initialHead || !choice)
                return;
            const location = choice.location;
            if (!location)
                return;
            await dispatchDefinitionLocation(location, plugin.uri, view, (uri) => { const file = toFilePath(uri); return file ? this.opts.display(file) : Promise.resolve(null); }, this.opts.beforeJump, (target, position) => {
                const targetPlugin = LSPPlugin.get(target);
                return targetPlugin
                    ? targetPlugin.fromPosition(position, target.state.doc)
                    : positionToOffset(position, target.state.doc);
            });
        }).catch((error: unknown) => this.showFailure(path.dirname(toFilePath(plugin.uri) ?? ''), 'Find definition failed', error));
        return true;
    }
    private chooseDefinition(locations: LspLocation[]): Promise<DefinitionChoice | null> {
        const choices = locations.flatMap((location) => {
            const filePath = toFilePath(location.uri);
            return filePath ? [{ location, filePath }] : [];
        });
        if (choices.length === 1)
            return Promise.resolve(choices[0] ?? null);
        if (!choices.length)
            return Promise.resolve(null);
        return new Promise((resolve) => new DefinitionChooser(this.opts.app, choices, resolve).open());
    }
    private references(view: EditorView): boolean {
        const generation = this.generation;
        const plugin = LSPPlugin.get(view);
        if (this.disposed || generation !== this.generation || !plugin)
            return false;
        plugin.client.sync();
        void plugin.client.request<unknown, LspLocation[] | null>('textDocument/references', {
            textDocument: { uri: plugin.uri },
            position: plugin.toPosition(view.state.selection.main.head) as unknown as Position,
            context: { includeDeclaration: true },
        }).then(async (locations) => {
            if (this.disposed || generation !== this.generation || LSPPlugin.get(view) !== plugin)
                return;
            const workspace = plugin.client.workspace as ViewerWorkspace;
            const release = await workspace.primeReferenceFiles((locations ?? []).map((location) => location.uri));
            try {
                if (!this.disposed && generation === this.generation && LSPPlugin.get(view) === plugin)
                    findReferences(view);
            }
            finally {
                release();
            }
        }).catch((error: unknown) => this.showFailure(path.dirname(toFilePath(plugin.uri) ?? ''), 'Finding references failed', error));
        return true;
    }
    private async requestDocumentSymbols(server: CodeMirrorLanguageResource, filePath: string): Promise<LspSymbol[]> {
        const uri = pathToFileURL(filePath).href;
        return server.endpoint.workspace.withDocument(uri, async () => {
            const result = await server.endpoint.client.request<unknown, DocumentSymbol[] | SymbolInformation[] | null>('textDocument/documentSymbol', { textDocument: { uri } });
            return toLspSymbols(result, uri);
        });
    }
    private showFailure(root: string, reason: string, error: unknown) {
        if (this.disposed)
            return;
        const detail = error instanceof Error ? `: ${error.message}` : '';
        const project = path.basename(root);
        new Notice(`Source Observer: ${reason}${project ? ` in ${project}` : ''}${detail}`);
    }
    /** Releases this consumer; the plugin registry owns shared server shutdown. */
    dispose() {
        this.disposed = true;
        this.generation++;
        this.detachEditor();
        for (const lease of this.queryLeases)
            lease.release();
        this.queryLeases.clear();
        this.workspaceRootsCache.clear();
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
