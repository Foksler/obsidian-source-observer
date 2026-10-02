import { promises as fsp } from 'fs';
import * as path from 'path';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import type { SyntaxTheme } from './settings';
import type { PhpLsp } from './phpLsp';
import { obsidianTheme, syntaxTheme } from './editorThemes';
import { phpWithSemanticHighlighting } from './phpSyntax';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { isPhpFile } from './phpFiles';

const EXT_LANG: Record<string, () => ReturnType<typeof javascript>> = {
	js:   () => javascript(),
	jsx:  () => javascript({ jsx: true }),
	ts:   () => javascript({ typescript: true }),
	tsx:  () => javascript({ jsx: true, typescript: true }),
	mjs:  () => javascript(),
	cjs:  () => javascript(),
	py:   () => python(),
	rs:   () => rust(),
	css:  () => css(),
	html: () => html(),
	htm:  () => html(),
	json: () => json(),
	jsonc:() => json(),
	md:   () => markdown(),
	mdx:  () => markdown(),
	php:  () => phpWithSemanticHighlighting(),
};

function languageForPath(filePath: string) {
	if (isPhpFile(filePath)) return phpWithSemanticHighlighting();
	const ext = path.extname(filePath).slice(1).toLowerCase();
	return EXT_LANG[ext]?.() ?? [];
}

function fontTheme(fontSize: number, fontFamily: string, ligatures: boolean) {
	return EditorView.theme({
		'&': { fontSize: `${fontSize}px` },
		'.cm-scroller': {
			fontFamily: `${fontFamily}, var(--font-monospace), monospace`,
			fontVariantLigatures: ligatures ? 'normal' : 'none',
			fontFeatureSettings: ligatures ? 'normal' : '"liga" 0, "calt" 0',
		},
		'.cm-line': { position: 'relative' },
		'.cm-line::after': {
			content: '""',
			position: 'absolute',
			top: 0,
			bottom: 0,
			left: '120ch',
			borderLeft: '1px solid #9b969841',
			pointerEvents: 'none',
		},
	});
}

export interface EditorLocation {
	filePath: string;
	/** One-based line number. */
	line: number;
	/** One-based character column. */
	column: number;
	/** Optional one-based, exclusive end column. */
	endColumn?: number;
	scrollTop: number;
}

interface SavedFileLocation {
	pos: number;
	scrollTop: number;
}

/**
 * Read-only CodeMirror 6 editor pane that syntax-highlights files using
 * Obsidian CSS variables. A single EditorView instance is reused across
 * files; language and font size are swapped via Compartments.
 */
export class CodePane {
	private container: HTMLElement;
	private view: EditorView | null = null;
	private fontSize: number;
	private fontFamily: string;
	private fontLigatures: boolean;
	private language = new Compartment();
	private font = new Compartment();
	private theme = new Compartment();
	private themeName: SyntaxTheme;
	private lspSlot = new Compartment();
	private lsp: PhpLsp | null = null;
	private currentPath: string | null = null;
	private openRequestId = 0;
	private fileLocations = new Map<string, SavedFileLocation>();
	/** Positions to return to with Mod-[ after jumping to a definition. */
	private history: { filePath: string; pos: number; scrollTop: number }[] = [];
	private onShown: (filePath: string) => void;

	constructor(container: HTMLElement, fontSize: number, themeName: SyntaxTheme, onShown: (filePath: string) => void, fontFamily = 'JetBrains Mono', fontLigatures = true) {
		this.container = container;
		this.fontSize = fontSize;
		this.fontFamily = fontFamily;
		this.fontLigatures = fontLigatures;
		this.themeName = themeName;
		this.onShown = onShown;
	}

	/** Attaches or detaches the PHP language server for the currently displayed file. */
	setLsp(lsp: PhpLsp | null) {
		if (this.lsp === lsp) return;
		this.view?.dispatch({ effects: this.lspSlot.reconfigure([]) });
		this.lsp = lsp;
		if (this.view && this.currentPath) {
			this.view.dispatch({ effects: this.lspSlot.reconfigure(this.lsp?.extensionFor(this.currentPath) ?? []) });
		}
	}

	/** Remembers the cursor so a definition jump can be undone with Mod-[. */
	rememberPosition() {
		if (!this.view || !this.currentPath) return;
		this.forwardHistory = [];
		const entry = { filePath: this.currentPath, pos: this.view.state.selection.main.head, scrollTop: this.view.scrollDOM.scrollTop };
		const last = this.history[this.history.length - 1];
		if (last?.filePath === entry.filePath && last.pos === entry.pos) return;
		this.history.push(entry);
		if (this.history.length > 100) this.history.shift();
	}

	/** Returns to the position before the last definition jump. */
	async goBack(): Promise<boolean> {
		const prev = this.history.pop();
		if (!prev) return false;
		if (this.currentPath && this.view) {
			this.forwardHistory.push({ filePath: this.currentPath, pos: this.view.state.selection.main.head, scrollTop: this.view.scrollDOM.scrollTop });
		}
		if (prev.filePath !== this.currentPath) await this.open(prev.filePath);
		if (!this.view || this.currentPath !== prev.filePath) return false;
		this.view.dispatch({ selection: { anchor: Math.min(prev.pos, this.view.state.doc.length) }, scrollIntoView: true });
		this.view.scrollDOM.scrollTop = prev.scrollTop;
		return true;
	}

	getCurrentFile(): string | null {
		return this.currentPath;
	}

	getEditor(): EditorView | null {
		return this.view;
	}

	focus() {
		this.view?.focus();
	}

	captureLocation(): EditorLocation | null {
		if (!this.view || !this.currentPath) return null;
		const pos = this.view.state.selection.main.head;
		const line = this.view.state.doc.lineAt(pos);
		return {
			filePath: this.currentPath,
			line: line.number,
			column: pos - line.from + 1,
			scrollTop: this.view.scrollDOM.scrollTop,
		};
	}

	async restoreLocation(location: EditorLocation): Promise<boolean> {
		await this.open(location.filePath);
		if (!this.view || this.currentPath !== location.filePath) return false;
		this.selectLocation(location);
		this.view.scrollDOM.scrollTop = location.scrollTop;
		return true;
	}

	findInFile(): void {
		if (this.view) openSearchPanel(this.view);
	}

	/** Opens a file and selects a one-based line/column range. */
	async openAt(filePath: string, line: number, column = 1, endColumn?: number): Promise<EditorView | null> {
		if (this.currentPath && this.view) this.rememberPosition();
		const view = await this.open(filePath);
		if (!view || this.currentPath !== filePath) return null;
		this.selectLocation({ filePath, line, column, endColumn, scrollTop: 0 });
		return view;
	}

	private selectLocation(location: EditorLocation) {
		if (!this.view) return;
		const lineNumber = Math.max(1, Math.min(Math.trunc(location.line) || 1, this.view.state.doc.lines));
		const line = this.view.state.doc.line(lineNumber);
		const from = Math.max(line.from, Math.min(line.to, line.from + Math.max(0, Math.trunc(location.column) - 1)));
		const to = location.endColumn === undefined
			? from
			: Math.max(from, Math.min(line.to, line.from + Math.max(0, Math.trunc(location.endColumn) - 1)));
		this.view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
	}

	/** Loads `filePath` into the editor, replacing the current document in place. */
	async open(filePath: string): Promise<EditorView | null> {
		const requestId = ++this.openRequestId;
		let content: string;
		try {
			content = await fsp.readFile(filePath, 'utf-8');
		} catch {
			content = '(cannot read file)';
		}
		if (requestId !== this.openRequestId) return null;

		const langExtension = languageForPath(filePath);
		const lspExtension = this.lsp?.extensionFor(filePath) ?? [];
		if (this.view && this.currentPath) {
			this.fileLocations.set(this.currentPath, {
				pos: this.view.state.selection.main.head,
				scrollTop: this.view.scrollDOM.scrollTop,
			});
		}
		const savedLocation = this.fileLocations.get(filePath);
		this.currentPath = filePath;
		this.onShown(filePath);

		if (!this.view) {
			// Diff rendering may have replaced this pane after the last editor
			// was destroyed. Remove that DOM before mounting a fresh editor.
			this.container.empty();
			const state = EditorState.create({
				doc: content,
				extensions: [
					EditorState.readOnly.of(true),
					lineNumbers(),
					highlightActiveLine(),
					bracketMatching(),
					obsidianTheme,
					Prec.highest(this.theme.of(syntaxTheme(this.themeName))),
					this.language.of(langExtension),
					Prec.highest(this.font.of(fontTheme(this.fontSize, this.fontFamily, this.fontLigatures))),
					search(),
					keymap.of([
						{ key: 'Mod-f', run: (view) => openSearchPanel(view) },
						{ key: 'Mod-[', run: () => { void this.goBack(); return true; } },
						{ key: 'Mod-]', run: () => { void this.goForward(); return true; } },
						...searchKeymap,
					]),
					this.lspSlot.of(lspExtension),
				],
			});
			this.view = new EditorView({ state, parent: this.container });
			this.restoreSavedFileLocation(savedLocation);
			return this.view;
		}

		// Detach the old file from the language server before swapping the
		// document, then attach the new one, so each plugin sees one file only.
		this.view.dispatch({ effects: this.lspSlot.reconfigure([]) });
		this.view.dispatch({
			changes: { from: 0, to: this.view.state.doc.length, insert: content },
			selection: { anchor: Math.min(savedLocation?.pos ?? 0, content.length) },
			effects: this.language.reconfigure(langExtension),
		});
		this.view.dispatch({ effects: this.lspSlot.reconfigure(lspExtension) });
		this.restoreSavedFileLocation(savedLocation);
		return this.view;
	}

	private restoreSavedFileLocation(location: SavedFileLocation | undefined) {
		if (!this.view) return;
		if (location) {
			this.view.dispatch({
				selection: { anchor: Math.min(location.pos, this.view.state.doc.length) },
				scrollIntoView: true,
			});
			this.view.scrollDOM.scrollTop = location.scrollTop;
		} else {
			this.view.scrollDOM.scrollTop = 0;
		}
	}

	private forwardHistory: { filePath: string; pos: number; scrollTop: number }[] = [];

	async goForward(): Promise<boolean> {
		const next = this.forwardHistory.pop();
		if (!next) return false;
		if (this.currentPath && this.view) {
			this.history.push({ filePath: this.currentPath, pos: this.view.state.selection.main.head, scrollTop: this.view.scrollDOM.scrollTop });
		}
		if (next.filePath !== this.currentPath) await this.open(next.filePath);
		if (!this.view || this.currentPath !== next.filePath) return false;
		this.view.dispatch({ selection: { anchor: Math.min(next.pos, this.view.state.doc.length) }, scrollIntoView: true });
		this.view.scrollDOM.scrollTop = next.scrollTop;
		return true;
	}

	/** Applies a new font size without recreating the editor. */
	setFontSize(fontSize: number) {
		if (this.fontSize === fontSize) return;
		this.fontSize = fontSize;
		this.view?.dispatch({ effects: this.font.reconfigure(fontTheme(fontSize, this.fontFamily, this.fontLigatures)) });
	}

	setFontOptions(fontFamily: string, ligatures: boolean) {
		if (this.fontFamily === fontFamily && this.fontLigatures === ligatures) return;
		this.fontFamily = fontFamily;
		this.fontLigatures = ligatures;
		this.view?.dispatch({ effects: this.font.reconfigure(fontTheme(this.fontSize, fontFamily, ligatures)) });
	}

	/** Switches the syntax theme without recreating the editor. */
	setTheme(themeName: SyntaxTheme) {
		if (this.themeName === themeName) return;
		this.themeName = themeName;
		this.view?.dispatch({ effects: this.theme.reconfigure(syntaxTheme(themeName)) });
	}

	/** Unmounts CodeMirror while retaining this pane's cursor and navigation state. */
	suspend() {
		this.openRequestId++;
		if (this.view && this.currentPath) {
			this.fileLocations.set(this.currentPath, {
				pos: this.view.state.selection.main.head,
				scrollTop: this.view.scrollDOM.scrollTop,
			});
		}
		this.view?.destroy();
		this.view = null;
		this.container.empty();
	}

	/** Destroys the CodeMirror instance and clears its navigation state. */
	destroy() {
		this.suspend();
		this.currentPath = null;
		this.history = [];
		this.forwardHistory = [];
		this.fileLocations.clear();
	}
}
