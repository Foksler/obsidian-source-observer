import * as path from 'path';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { getSearchQuery, openSearchPanel, search, searchKeymap, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import type { SyntaxTheme } from './settings';
import type { LspNavigation } from './lspNavigation';
import { go } from '@codemirror/lang-go';
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
import { yamlWithKeyHighlighting } from './yamlSyntax';
import { normalizeShortcuts, type SearchShortcuts } from './searchShortcuts';
import { containsFile } from './searchRoots';
import { lineBreakFor, readSourceText, saveIfUnchanged, writeSourceText, type SaveResult, type SourceText } from './sourceFile';

/** Edits are written to disk after this much typing inactivity. */
const AUTOSAVE_DELAY_MS = 1000;

export interface SaveHandlers {
	/** Called after the editor wrote `filePath`. */
	saved(filePath: string): void;
	/** Asks whether to overwrite a file that changed on disk, or was removed, since it was loaded. */
	conflict(filePath: string, missing: boolean): Promise<boolean>;
	failed(filePath: string, error: unknown): void;
}

const EXT_LANG: Record<string, () => ReturnType<typeof javascript>> = {
	go:   () => go(),
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
	yml:  () => yamlWithKeyHighlighting(),
	yaml: () => yamlWithKeyHighlighting(),
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

export interface CodePaneSessionLocation {
	filePath: string;
	pos: number;
	scrollTop: number;
}

export interface CodePaneSession {
	currentPath: string | null;
	currentLocation: CodePaneSessionLocation | null;
	fileLocations: CodePaneSessionLocation[];
	history: CodePaneSessionLocation[];
	forwardHistory: CodePaneSessionLocation[];
}

function cloneSessionLocation(location: CodePaneSessionLocation): CodePaneSessionLocation {
	return { filePath: location.filePath, pos: location.pos, scrollTop: location.scrollTop };
}

/** Returns a plain serializable copy without sharing mutable arrays or entries. */
export function cloneCodePaneSession(session: CodePaneSession | null): CodePaneSession {
	if (!session) return { currentPath: null, currentLocation: null, fileLocations: [], history: [], forwardHistory: [] };
	return {
		currentPath: session.currentPath,
		currentLocation: session.currentLocation ? cloneSessionLocation(session.currentLocation) : null,
		fileLocations: session.fileLocations.map(cloneSessionLocation),
		history: session.history.map(cloneSessionLocation),
		forwardHistory: session.forwardHistory.map(cloneSessionLocation),
	};
}

/**
 * CodeMirror 6 editor pane that syntax-highlights files using Obsidian CSS
 * variables and autosaves edits. A single EditorView instance is reused
 * across files, each file getting a fresh state with its own undo history;
 * theme and font size are swapped via Compartments.
 */
export class CodePane {
	private container: HTMLElement;
	private view: EditorView | null = null;
	private fontSize: number;
	private fontFamily: string;
	private fontLigatures: boolean;
	private font = new Compartment();
	private theme = new Compartment();
	private themeName: SyntaxTheme;
	private lspSlot = new Compartment();
	private lsp: LspNavigation | null = null;
	private shortcutConfig = normalizeShortcuts(undefined);
	private shortcuts = new Compartment();
	private currentPath: string | null = null;
	private openRequestId = 0;
	private pendingPath: string | null = null;
	private fileLocations = new Map<string, CodePaneSessionLocation>();
	/** Positions to return to with Mod-[ after jumping to a definition. */
	private history: { filePath: string; pos: number; scrollTop: number }[] = [];
	private onShown: (filePath: string) => void;
	private saveHandlers: SaveHandlers = { saved: () => {}, conflict: () => Promise.resolve(false), failed: () => {} };
	/** Disk text the shown document was loaded from or last saved as; null while it is read-only. */
	private savedText: string | null = null;
	private dirty = false;
	private saveTimer: number | null = null;
	/** File whose overwrite question is open; its saves wait for the answer. */
	private conflictPath: string | null = null;
	/** Bumped whenever a new document replaces the editor state. */
	private documentId = 0;

	constructor(container: HTMLElement, fontSize: number, themeName: SyntaxTheme, onShown: (filePath: string) => void, fontFamily = 'JetBrains Mono', fontLigatures = true) {
		this.container = container;
		this.fontSize = fontSize;
		this.fontFamily = fontFamily;
		this.fontLigatures = fontLigatures;
		this.themeName = themeName;
		this.onShown = onShown;
	}

	/** Attaches or detaches language navigation for the currently displayed file. */
	setLsp(lsp: LspNavigation | null) {
		if (this.lsp === lsp) return;
		this.view?.dispatch({ effects: this.lspSlot.reconfigure([]) });
		this.lsp = lsp;
		if (this.view && this.currentPath) {
			this.view.dispatch({ effects: this.lspSlot.reconfigure(this.lsp?.extensionFor(this.currentPath) ?? []) });
		}
	}

	setSaveHandlers(handlers: SaveHandlers) {
		this.saveHandlers = handlers;
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
		if (prev.filePath !== this.currentPath && !await this.open(prev.filePath)) return false;
		if (!this.view || this.currentPath !== prev.filePath) return false;
		this.view.dispatch({ selection: { anchor: Math.min(prev.pos, this.view.state.doc.length) }, scrollIntoView: true });
		this.view.scrollDOM.scrollTop = prev.scrollTop;
		return true;
	}

	getCurrentFile(): string | null {
		return this.currentPath;
	}

	/** Captures serializable per-file positions and navigation history without sharing state. */
	captureSession(): CodePaneSession {
		if (this.view && this.currentPath) {
			this.fileLocations.set(this.currentPath, {
				filePath: this.currentPath,
				pos: this.view.state.selection.main.head,
				scrollTop: this.view.scrollDOM.scrollTop,
			});
		}
		const currentLocation = this.currentPath ? this.fileLocations.get(this.currentPath) ?? null : null;
		return cloneCodePaneSession({
			currentPath: this.currentPath,
			currentLocation,
			fileLocations: [...this.fileLocations.values()],
			history: this.history,
			forwardHistory: this.forwardHistory,
		});
	}

	/** Replaces this pane's navigation state without opening a file. */
	restoreSession(session: CodePaneSession | null): void {
		this.suspend();
		const cloned = cloneCodePaneSession(session);
		this.fileLocations.clear();
		for (const location of cloned.fileLocations) this.fileLocations.set(location.filePath, location);
		if (cloned.currentLocation) this.fileLocations.set(cloned.currentLocation.filePath, cloned.currentLocation);
		this.history = cloned.history;
		this.forwardHistory = cloned.forwardHistory;
		this.currentPath = cloned.currentPath;
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
		if (!await this.open(location.filePath)) return false;
		if (!this.view || this.currentPath !== location.filePath) return false;
		this.selectLocation(location);
		this.view.scrollDOM.scrollTop = location.scrollTop;
		return true;
	}

	findInFile(): void {
		if (this.view) openSearchPanel(this.view);
	}

	setShortcuts(shortcuts: SearchShortcuts) {
		this.shortcutConfig = normalizeShortcuts(shortcuts);
		this.view?.dispatch({ effects: this.shortcuts.reconfigure(keymap.of(this.editorBindings())) });
	}

	private editorBindings() {
		const bindings = searchKeymap.filter((binding) => binding.key !== 'Mod-f');
		for (const [action, run] of [
			['findInFile', (view: EditorView) => openSearchPanel(view)],
			['back', () => { void this.goBack(); return true; }],
			['forward', () => { void this.goForward(); return true; }],
		] as const) {
			const shortcut = this.shortcutConfig[action];
			if (shortcut) bindings.push({ key: [...shortcut.modifiers, shortcut.key].join('-'), run });
		}
		return bindings;
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

	/** Loads `filePath` into the editor, saving the current document first. */
	async open(filePath: string): Promise<EditorView | null> {
		const requestId = ++this.openRequestId;
		this.pendingPath = filePath;
		// Saving before the read lets reopening the shown file see its latest text.
		this.save();
		const file = await readSourceText(filePath);
		if (requestId !== this.openRequestId) return null;
		this.pendingPath = null;
		this.save();

		if (this.view && this.currentPath === filePath && (this.dirty || this.view.state.sliceDoc() === file?.content)) {
			// Reopening the shown file, e.g. for a jump inside it, keeps its undo history.
			this.onShown(filePath);
			return this.view;
		}
		if (this.view && this.currentPath) {
			this.fileLocations.set(this.currentPath, {
				filePath: this.currentPath,
				pos: this.view.state.selection.main.head,
				scrollTop: this.view.scrollDOM.scrollTop,
			});
		}
		const savedLocation = this.fileLocations.get(filePath);
		this.currentPath = filePath;
		this.onShown(filePath);
		this.display(filePath, file);
		this.restoreSavedFileLocation(savedLocation);
		return this.view;
	}

	/** Replaces the editor state with `file`, keeping an open search panel and the focus. */
	private display(filePath: string, file: SourceText | null) {
		const content = file?.content ?? '(cannot read file)';
		this.savedText = file?.editable ? file.content : null;
		this.dirty = false;
		this.documentId++;
		// The language server extension of the old state detaches when its
		// plugins are destroyed, so each server sees one open file at a time.
		const state = EditorState.create({
			doc: content,
			extensions: [
				EditorState.readOnly.of(this.savedText === null),
				EditorState.lineSeparator.of(lineBreakFor(content)),
				history(),
				lineNumbers(),
				highlightActiveLine(),
				bracketMatching(),
				obsidianTheme,
				Prec.highest(this.theme.of(syntaxTheme(this.themeName))),
				languageForPath(filePath),
				Prec.highest(this.font.of(fontTheme(this.fontSize, this.fontFamily, this.fontLigatures))),
				search(),
				this.shortcuts.of(keymap.of(this.editorBindings())),
				keymap.of([{ key: 'Mod-s', run: () => { this.save(); return true; } }, ...defaultKeymap, ...historyKeymap, indentWithTab]),
				this.lspSlot.of(this.lsp?.extensionFor(filePath) ?? []),
				EditorView.updateListener.of((update) => { if (update.docChanged) this.scheduleSave(); }),
			],
		});

		if (!this.view) {
			// Diff rendering may have replaced this pane after the last editor
			// was destroyed. Remove that DOM before mounting a fresh editor.
			this.container.empty();
			this.view = new EditorView({ state, parent: this.container });
			return;
		}
		const query = searchPanelOpen(this.view.state) ? getSearchQuery(this.view.state) : null;
		const focused = this.container.ownerDocument.activeElement as HTMLElement | null;
		this.view.setState(state);
		if (!query) return;
		this.view.dispatch({ effects: setSearchQuery.of(query) });
		openSearchPanel(this.view);
		// Reopening the panel focuses its field; give the focus back to the tree or editor.
		if (focused?.isConnected) focused.focus();
	}

	/** Writes unsaved edits of the shown file now, unless the file changed on disk. */
	save() {
		if (this.saveTimer !== null) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
		const filePath = this.currentPath;
		if (!this.view || !filePath || !this.dirty || this.savedText === null || this.conflictPath === filePath) return;
		const text = this.view.state.sliceDoc();
		let result: SaveResult;
		try {
			result = saveIfUnchanged(filePath, text, this.savedText);
		} catch (error) {
			this.saveHandlers.failed(filePath, error);
			return;
		}
		if (result !== 'saved') { void this.resolveConflict(filePath, text, result === 'missing'); return; }
		this.savedText = text;
		this.dirty = false;
		this.saveHandlers.saved(filePath);
	}

	private scheduleSave() {
		this.dirty = true;
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => { this.saveTimer = null; this.save(); }, AUTOSAVE_DELAY_MS);
	}

	/** Overwrites the file with the edits, or drops them and shows the disk version, as the user picks. */
	private async resolveConflict(filePath: string, text: string, missing: boolean) {
		this.conflictPath = filePath;
		const documentId = this.documentId;
		const overwrite = await this.saveHandlers.conflict(filePath, missing);
		this.conflictPath = null;
		// The answer may come after the editor moved to another file; then the captured text is saved.
		const shown = this.view !== null && this.documentId === documentId;
		if (!overwrite) {
			if (!shown) return;
			const file = await readSourceText(filePath);
			if (this.view && this.documentId === documentId) this.redisplay(filePath, file);
			return;
		}
		const latest = shown ? this.view!.state.sliceDoc() : text;
		try {
			writeSourceText(filePath, latest);
		} catch (error) {
			this.saveHandlers.failed(filePath, error);
			return;
		}
		if (shown && this.view!.state.sliceDoc() === latest) {
			this.savedText = latest;
			this.dirty = false;
		}
		this.saveHandlers.saved(filePath);
	}

	/** Shows the disk text of the shown file when it changed elsewhere and has no unsaved edits here. */
	async reloadIfChanged() {
		const filePath = this.currentPath;
		if (!this.view || !filePath || this.dirty || this.pendingPath) return;
		const documentId = this.documentId;
		const file = await readSourceText(filePath);
		if (!file || !this.view || this.documentId !== documentId || this.dirty || this.pendingPath) return;
		if (file.content !== this.view.state.sliceDoc()) this.redisplay(filePath, file);
	}

	/** Shows new text of the shown file at the same cursor and scroll position. */
	private redisplay(filePath: string, file: SourceText | null) {
		if (!this.view) return;
		const pos = this.view.state.selection.main.head;
		const scrollTop = this.view.scrollDOM.scrollTop;
		this.display(filePath, file);
		this.restoreSavedFileLocation({ filePath, pos, scrollTop });
	}

	private restoreSavedFileLocation(location: CodePaneSessionLocation | undefined) {
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
		if (next.filePath !== this.currentPath && !await this.open(next.filePath)) return false;
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

	/** Drops a deleted file, or every file inside a deleted folder. */
	forgetFile(deletedPath: string) {
		const removed = (filePath: string) => containsFile(deletedPath, filePath);
		if (this.pendingPath && removed(this.pendingPath)) { ++this.openRequestId; this.pendingPath = null; }
		if (this.currentPath && removed(this.currentPath)) {
			// Unsaved edits of a trashed file are dropped, not written back.
			if (this.saveTimer !== null) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
			this.dirty = false;
			// A diff can be visible while currentPath still refers to the last code tab.
			if (this.view) { this.view.destroy(); this.view = null; this.container.empty(); }
			this.currentPath = null;
		}
		for (const filePath of [...this.fileLocations.keys()]) if (removed(filePath)) this.fileLocations.delete(filePath);
		this.history = this.history.filter((entry) => !removed(entry.filePath));
		this.forwardHistory = this.forwardHistory.filter((entry) => !removed(entry.filePath));
	}

	/** Saves and unmounts CodeMirror while retaining this pane's cursor and navigation state. */
	suspend() {
		this.save();
		this.openRequestId++;
		this.pendingPath = null;
		if (this.view && this.currentPath) {
			this.fileLocations.set(this.currentPath, {
				filePath: this.currentPath,
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
