import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { LSPPlugin } from '@codemirror/lsp-client';
import { fileURLToPath } from 'url';
import { LanguageLsp, type LanguageLspOptions } from './languageLsp';
import type { LspAdapter } from './lspAdapter';
import type { LspSymbol } from './lspWorkspace';
import { phpAdapter, detectIntelephense, detectNode } from './phpAdapter';
import { goAdapter, detectGo, detectGopls } from './goAdapter';

interface NavigationSettings {
	phpLsp: boolean;
	goLsp: boolean;
	nodePath: string;
	intelephensePath: string;
	intelephenseLicence: string;
	goPath: string;
	goplsPath: string;
}

export function navigationAdapters(settings: NavigationSettings): LspAdapter[] {
	const adapters: LspAdapter[] = [];
	if (settings.phpLsp) adapters.push(phpAdapter(settings.nodePath || detectNode(),
		settings.intelephensePath || detectIntelephense(), settings.intelephenseLicence));
	if (settings.goLsp) adapters.push(goAdapter(settings.goPath || detectGo(), settings.goplsPath || detectGopls()));
	return adapters;
}

/** Routes documents to their adapter and combines symbols across enabled languages. */
export class LspNavigation {
	private languages: { adapter: LspAdapter; lsp: LanguageLsp }[];
	constructor(options: Omit<LanguageLspOptions, 'adapter'>, adapters: LspAdapter[]) {
		this.languages = adapters.map((adapter) => ({ adapter, lsp: new LanguageLsp({ ...options, adapter }) }));
	}

	setWorkspaceRoot(root: string) { for (const { lsp } of this.languages) lsp.setWorkspaceRoot(root); }
	supports(file: string): boolean { return this.languages.some(({ adapter }) => adapter.languageId(file) !== null); }
	extensionFor(file: string): Extension {
		return this.languages.find(({ adapter }) => adapter.languageId(file))?.lsp.extensionFor(file) ?? [];
	}
	async symbols(query?: string, file?: string): Promise<LspSymbol[]> {
		if (file) return this.languages.find(({ adapter }) => adapter.languageId(file))?.lsp.symbols(query, file) ?? [];
		return (await Promise.all(this.languages.map(({ lsp }) => lsp.workspaceSymbols(query)))).flat();
	}
	workspaceSymbols(query = '') { return this.symbols(query); }
	private languageFor(view: EditorView): LanguageLsp | undefined {
		const uri = LSPPlugin.get(view)?.uri;
		if (!uri) return;
		try { return this.languages.find(({ adapter }) => adapter.languageId(fileURLToPath(uri)))?.lsp; }
		catch { return; }
	}
	jumpToDefinition(view: EditorView): boolean { return this.languageFor(view)?.jumpToDefinition(view) ?? false; }
	findReferences(view: EditorView): boolean { return this.languageFor(view)?.findReferences(view) ?? false; }
	dispose() { for (const { lsp } of this.languages) lsp.dispose(); }
}
