import { App, SuggestModal } from 'obsidian';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { PhpLsp, PhpSymbol } from './phpLsp';

function flatten(symbols: PhpSymbol[]): PhpSymbol[] {
	return symbols.flatMap((symbol) => [symbol, ...flatten(symbol.children ?? [])]);
}

/** Uses actual language-server symbols, rather than guessing declarations from text. */
export class SymbolPicker extends SuggestModal<PhpSymbol> {
	private sequence = 0;
	constructor(app: App, private lsp: PhpLsp, private filePath: string | undefined,
		private select: (filePath: string, line: number, column: number) => void) {
		super(app);
		this.setPlaceholder(filePath ? 'Go to symbol in file…' : 'Go to PHP symbol in workspace…');
		this.setInstructions([{ command: '↑↓', purpose: 'Select' }, { command: '↵', purpose: 'Open symbol' }, { command: 'esc', purpose: 'Close' }]);
	}
	async getSuggestions(query: string): Promise<PhpSymbol[]> {
		const seq = ++this.sequence;
		const symbols = flatten(await this.lsp.symbols(this.filePath ? undefined : query, this.filePath));
		if (seq !== this.sequence) return [];
		return symbols.filter((symbol) => symbol.name.toLowerCase().includes(query.toLowerCase())).slice(0, 200);
	}
	renderSuggestion(symbol: PhpSymbol, el: HTMLElement) {
		el.createDiv({ text: symbol.name });
		let file = symbol.uri;
		try { file = fileURLToPath(symbol.uri); } catch { /* keep URI */ }
		el.createDiv({ cls: 'so-symbol-detail', text: symbol.detail ?? `${symbol.containerName ?? ''} ${path.basename(file)}:${symbol.range.start.line + 1}` });
	}
	onChooseSuggestion(symbol: PhpSymbol) {
		const position = (symbol.selectionRange ?? symbol.range).start;
		this.select(fileURLToPath(symbol.uri), position.line + 1, position.character + 1);
	}
}
