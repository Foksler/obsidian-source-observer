import * as fsp from 'fs/promises';
import { fileURLToPath } from 'url';
import { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { LSPClient, LSPPlugin, Workspace, type WorkspaceFile } from '@codemirror/lsp-client';

export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface LspLocation { uri: string; range: Range }
export interface LspSymbol {
	name: string;
	kind: number;
	uri: string;
	range: Range;
	selectionRange?: Range;
	detail?: string;
	containerName?: string;
	children?: LspSymbol[];
}

export interface DocumentSymbol {
	name: string;
	kind: number;
	range: Range;
	selectionRange: Range;
	detail?: string;
	children?: DocumentSymbol[];
}
export interface SymbolInformation {
	name: string;
	kind: number;
	location: LspLocation;
	containerName?: string;
}

export async function dispatchDefinitionLocation(
	location: LspLocation,
	sourceUri: string,
	sourceView: EditorView,
	display: (uri: string) => Promise<EditorView | null>,
	beforeJump: () => void,
	positionToOffset: (view: EditorView, position: Position) => number,
): Promise<boolean> {
	let target: EditorView | null = sourceView;
	if (location.uri !== sourceUri) {
		beforeJump();
		target = await display(location.uri);
	}
	if (!target) return false;
	if (location.uri === sourceUri) beforeJump();
	target.dispatch({
		selection: { anchor: positionToOffset(target, location.range.start) },
		scrollIntoView: true,
		userEvent: 'select.definition',
	});
	target.focus();
	return true;
}

function toFilePath(uri: string): string | null {
	try { return fileURLToPath(uri); } catch { return null; }
}

/** Convert either flat workspace symbols or hierarchical document symbols. */
export function toLspSymbols(response: DocumentSymbol[] | SymbolInformation[] | null, fallbackUri: string): LspSymbol[] {
	if (!response) return [];
	return response.map((symbol) => {
		if ('location' in symbol) {
			return {
				name: symbol.name, kind: symbol.kind, uri: symbol.location.uri,
				range: symbol.location.range, containerName: symbol.containerName,
			};
		}
		return {
			name: symbol.name, kind: symbol.kind, uri: fallbackUri,
			range: symbol.range, selectionRange: symbol.selectionRange,
			detail: symbol.detail,
			...(symbol.children ? { children: toLspSymbols(symbol.children, fallbackUri) } : {}),
		};
	});
}

/** Read-only workspace for a single project, with snapshots for references. */
export class ViewerWorkspace extends Workspace {
	files: WorkspaceFile[] = [];
	private referenceSnapshots = new Map<string, WorkspaceFile>();
	private primedReferenceUris = new Set<string>();
	private awaitingReferenceFiles = new Set<string>();
	private display: (filePath: string) => Promise<EditorView | null>;
	private languageId: (filePath: string) => string | null;

	constructor(client: LSPClient, display: (filePath: string) => Promise<EditorView | null>,
		languageId: (filePath: string) => string | null = () => 'plaintext') {
		super(client);
		this.display = display;
		this.languageId = languageId;
	}

	syncFiles() { return []; }

	openFile(uri: string, languageId: string, view: EditorView) {
		const existing = this.getFile(uri);
		if (existing && !this.referenceSnapshots.has(uri) && existing.getView()) return;
		if (existing) {
			this.files = this.files.filter((file) => file !== existing);
			this.client.didClose(uri);
		}
		this.referenceSnapshots.delete(uri);
		const file: WorkspaceFile = {
			uri, languageId, version: 1, doc: view.state.doc,
			getView: () => LSPPlugin.get(view)?.uri === uri ? view : null,
		};
		this.files.push(file);
		this.client.didOpen(file);
	}

	closeFile(uri: string) {
		const file = this.getFile(uri);
		if (!file) return;
		this.files = this.files.filter((item) => item !== file);
		this.client.didClose(uri);
	}

	async requestFile(uri: string): Promise<WorkspaceFile | null> {
		const open = this.getFile(uri);
		if (open) return open;
		const cached = this.referenceSnapshots.get(uri);
		if (cached) {
			if (this.awaitingReferenceFiles.delete(uri)) this.referenceSnapshots.delete(uri);
			return cached;
		}
		const filePath = toFilePath(uri);
		if (!filePath) return null;
		try {
			const contents = await fsp.readFile(filePath, 'utf8');
			return { uri, languageId: this.languageId(filePath) ?? 'plaintext', version: 1, doc: Text.of(contents.split(/\r?\n/)), getView: () => null };
		} catch { return null; }
	}

	async primeReferenceFiles(uris: string[]) {
		for (const uri of new Set(uris)) {
			if (this.getFile(uri)) continue;
			const file = await this.requestFile(uri);
			if (!file) continue;
			this.referenceSnapshots.set(uri, file);
			this.primedReferenceUris.add(uri);
			this.files.push(file);
		}
	}

	releasePrimedReferenceFiles() {
		if (!this.primedReferenceUris.size) return;
		this.files = this.files.filter((file) => !this.primedReferenceUris.has(file.uri));
		for (const uri of this.primedReferenceUris) this.awaitingReferenceFiles.add(uri);
		this.primedReferenceUris.clear();
		window.setTimeout(() => {
			for (const uri of this.awaitingReferenceFiles) this.referenceSnapshots.delete(uri);
			this.awaitingReferenceFiles.clear();
		}, 21000);
	}

	displayFile(uri: string) {
		const filePath = toFilePath(uri);
		return filePath ? this.display(filePath) : Promise.resolve(null);
	}
}
