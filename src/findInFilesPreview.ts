import { setSearchQuery, SearchQuery } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { CodePane } from './codePane';
import { renderFindFileHeader } from './findInFilesResults';
import type { SearchMatch, SearchOptions } from './searchEngine';
import type { SourceObserverSettings } from './settings';

/** A separate read-only editor: browsing results never changes the main editor. */
export class FindInFilesPreview {
	private pane: CodePane;
	private generation = 0;
	constructor(private header: HTMLElement, private body: HTMLElement, settings: SourceObserverSettings, private root: string) {
		this.pane = new CodePane(body, settings.fontSize, settings.syntaxTheme, () => {}, settings.editorFontFamily, settings.editorFontLigatures);
		this.pane.setShortcuts(settings.shortcuts);
	}
	clear() {
		++this.generation;
		this.pane.suspend();
		this.header.setText('Select a match to preview its source.');
		this.body.empty();
	}
	async show(match: SearchMatch, query: string, options: Omit<SearchOptions, 'query'>, root = this.root) {
		const generation = ++this.generation;
		renderFindFileHeader(this.header, root, match);
		const editor = await this.pane.openAt(match.filePath, match.line, match.column);
		if (generation !== this.generation) return;
		if (!editor) { this.body.setText('Could not read this file.'); return; }
		editor.dispatch({ effects: [setSearchQuery.of(new SearchQuery({ search: query, caseSensitive: options.caseSensitive,
			wholeWord: options.wholeWord, regexp: options.regex, literal: !options.regex })),
			EditorView.scrollIntoView(editor.state.selection.main.head, { y: 'center' })] });
	}
	dispose() { ++this.generation; this.pane.destroy(); }
}
