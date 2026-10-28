import { NavigationSession, type CodePaneSession, type CodePaneSessionLocation } from '../workspace/index.ts';
import * as path from 'path';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { getSearchQuery, openSearchPanel, search, searchKeymap, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import type { SyntaxTheme } from '../app/index.ts';
import type { LspNavigation } from './lspNavigation.ts';
import { go } from '@codemirror/lang-go';
import { obsidianTheme, syntaxTheme } from './editorThemes.ts';
import { phpWithSemanticHighlighting } from './phpSyntax.ts';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { isPhpFile } from '../files/index.ts';
import { yamlWithKeyHighlighting } from './yamlSyntax.ts';
import { normalizeShortcuts, type SearchShortcuts } from '../app/index.ts';
import { containsFile } from '../files/index.ts';
import { lineBreakFor, sourceDocumentIO, type SourceText } from '../files/index.ts';
import { DocumentStore } from '../documents/index.ts';
import type { ConflictDecision, DocumentSession, SaveOutcome } from '../documents/index.ts';

export interface SaveHandlers {
	/** Called after the editor wrote `filePath`. */
	saved(filePath: string): void;
	/** Asks whether to overwrite a file that changed on disk, or was removed, since it was loaded. */
	conflict(filePath: string, missing: boolean): Promise<boolean | ConflictDecision>;
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

export type { CodePaneSession, CodePaneSessionLocation } from '../workspace/index.ts';

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
	private navigationState?: NavigationSession;
 private get navigation() { return this.navigationState ??= new NavigationSession(); }
	private openRequestId = 0;
	private pendingPath: string | null = null;
	/** Positions to return to with Mod-[ after jumping to a definition. */
	private onShown: (filePath: string) => void;
	private saveHandlers: SaveHandlers = { saved: () => {}, conflict: () => Promise.resolve('cancel'), failed: () => {} };
	private activeDocument: DocumentSession | null = null;
	private unsubscribeHandlers?: ()=>void;
	private unsubscribeDocument?: () => void;
	private documents: DocumentStore;
	private readOnly: boolean;
	/** Public observations for host diagnostics; the document remains the owner. */
	get dirty() { return this.activeDocument?.snapshot().dirty ?? false; }
	get conflictPath() { return this.activeDocument?.snapshot().state === 'conflict' ? this.activeDocument.path : null; }

	constructor(container: HTMLElement, fontSize: number, themeName: SyntaxTheme, onShown: (filePath: string) => void, fontFamily = 'JetBrains Mono', fontLigatures = true, options: { documents?: DocumentStore; readOnly?: boolean; navigation?: NavigationSession } = {}) {
		this.documents = options.documents ?? new DocumentStore(sourceDocumentIO);
  this.navigationState = options.navigation;
		this.readOnly = options.readOnly ?? false;
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
		if (this.view && this.navigation.currentPath) {
			this.view.dispatch({ effects: this.lspSlot.reconfigure(this.lsp?.extensionFor(this.navigation.currentPath) ?? []) });
		}
	}

	setSaveHandlers(handlers: SaveHandlers) {
		this.saveHandlers = handlers;
  this.unsubscribeHandlers?.();this.unsubscribeHandlers=this.activeDocument?this.documents.bindHandlers(this.activeDocument,adaptDocumentHandlers(handlers)):undefined;
	}

	/** Remembers the cursor so a definition jump can be undone with Mod-[. */
	rememberPosition() {
  const location=this.captureLocationOffset(); if(location) this.navigation.remember(location);
 }
 private captureLocationOffset(): CodePaneSessionLocation | null {
  return this.view && this.navigation.currentPath ? {filePath:this.navigation.currentPath,pos:this.view.state.selection.main.head,scrollTop:this.view.scrollDOM.scrollTop} : null;
 }
 async goBack(): Promise<boolean> { return this.traverse('back'); }
 private async traverse(direction: 'back' | 'forward'): Promise<boolean> {
  const traversal=this.navigation.begin(direction,this.captureLocationOffset()); if(!traversal) return false;
  const target=traversal.target;
  if(target.filePath!==this.navigation.currentPath && !await this.open(target.filePath)) return false;
  if(!this.view || this.navigation.currentPath!==target.filePath || !traversal.commit()) return false;
  this.restoreSavedFileLocation(target); return true;
 }

	getCurrentFile(): string | null {
		return this.navigation.currentPath;
	}

	/** Captures serializable per-file positions and navigation history without sharing state. */
	captureSession(): CodePaneSession {
		if (this.view && this.navigation.currentPath) {
			this.navigation.fileLocations.set(this.navigation.currentPath, {
				filePath: this.navigation.currentPath,
				pos: this.view.state.selection.main.head,
				scrollTop: this.view.scrollDOM.scrollTop,
			});
		}
		return this.navigation.capture();
	}

	/** Application commit immediately after successful document preparation, without another save decision. */
 restorePreparedSession(session: CodePaneSession | null): boolean {
  const document=this.activeDocument?.snapshot();
  if(document?.dirty || document?.state==='conflict') return false;
  this.unmount(); return this.restoreNavigation(session);
 }

	/** Replaces this pane's navigation state without opening a file. */
	restoreSession(session: CodePaneSession | null): boolean | Promise<boolean> {
		const outcome = this.suspend();
		if (outcome instanceof Promise) return outcome.then(ready => ready ? this.restoreNavigation(session) : false);
		return outcome ? this.restoreNavigation(session) : false;
	}
	private restoreNavigation(session: CodePaneSession | null): true {
		this.navigation.restore(session);
		return true;
	}

	getEditor(): EditorView | null {
		return this.view;
	}

	focus() {
		this.view?.focus();
	}

	captureLocation(): EditorLocation | null {
		if (!this.view || !this.navigation.currentPath) return null;
		const pos = this.view.state.selection.main.head;
		const line = this.view.state.doc.lineAt(pos);
		return {
			filePath: this.navigation.currentPath,
			line: line.number,
			column: pos - line.from + 1,
			scrollTop: this.view.scrollDOM.scrollTop,
		};
	}

	async restoreLocation(location: EditorLocation): Promise<boolean> {
		if (!await this.open(location.filePath)) return false;
		if (!this.view || this.navigation.currentPath !== location.filePath) return false;
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
		if (this.navigation.currentPath && this.view) this.rememberPosition();
		const view = await this.open(filePath);
		if (!view || this.navigation.currentPath !== filePath) return null;
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

	/** Loads a document only after the previous buffer has a successful transition outcome. */
	async open(filePath: string): Promise<EditorView | null> {
		const requestId = ++this.openRequestId;
		this.pendingPath = filePath;
		if (!await this.prepareToLeave() || requestId !== this.openRequestId) { if (requestId === this.openRequestId) this.pendingPath = null; return null; }
		const document = await this.documents.open(filePath);
		if (!document || requestId !== this.openRequestId) { if (document) this.documents.release(document); return null; }
		if (!await this.prepareToLeave() || requestId !== this.openRequestId) { this.documents.release(document); if (requestId === this.openRequestId) this.pendingPath = null; return null; }
		this.pendingPath = null;
		if (this.activeDocument === document && this.view) { this.documents.release(document); this.onShown(filePath); return this.view; }
		if (this.view && this.navigation.currentPath) this.navigation.fileLocations.set(this.navigation.currentPath, {
			filePath: this.navigation.currentPath, pos: this.view.state.selection.main.head, scrollTop: this.view.scrollDOM.scrollTop,
		});
		this.detachDocument();
		this.activeDocument = document;
        this.unsubscribeHandlers=this.documents.bindHandlers(document,adaptDocumentHandlers(this.saveHandlers));
		this.unsubscribeDocument = document.subscribe(snapshot => {
			if (this.activeDocument === document && this.view && this.view.state.sliceDoc() !== snapshot.text && snapshot.state !== 'deleted') {
				this.redisplay(filePath, { content: snapshot.text, editable: snapshot.editable });
			}
		});
		this.navigation.currentPath = filePath;
		const snapshot = document.snapshot();
		this.display(filePath, { content: snapshot.text, editable: snapshot.editable });
		this.onShown(filePath);
		this.restoreSavedFileLocation(this.navigation.fileLocations.get(filePath));
		return this.view;
	}

	private detachDocument() {
		this.unsubscribeDocument?.(); this.unsubscribeDocument = undefined;
  this.unsubscribeHandlers?.();this.unsubscribeHandlers=undefined;
		if (this.activeDocument) this.documents.release(this.activeDocument);
		this.activeDocument = null;
	}

	async prepareToLeave(): Promise<boolean> { return await this.save() === 'ready'; }

	/** Replaces the editor state with `file`, keeping an open search panel and the focus. */
	private display(filePath: string, file: SourceText | null) {
		const content = file?.content ?? '(cannot read file)';
		// The language server extension of the old state detaches when its
		// plugins are destroyed, so each server sees one open file at a time.
		const state = EditorState.create({
			doc: content,
			extensions: [
				EditorState.readOnly.of(this.readOnly || !file?.editable),
				EditorView.editable.of(!this.readOnly && !!file?.editable),
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
				keymap.of([{ key: 'Mod-s', run: () => { void this.save(); return true; } }, ...defaultKeymap, ...historyKeymap, indentWithTab]),
				this.lspSlot.of(this.lsp?.extensionFor(filePath) ?? []),
				EditorView.updateListener.of((update) => { if (update.docChanged && !this.readOnly) this.activeDocument?.edit(update.state.sliceDoc()); }),
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

	/** Saves the document; callers deciding navigation must inspect the outcome. */
	save(): SaveOutcome | Promise<SaveOutcome> { return this.readOnly ? 'ready' : this.activeDocument?.save() ?? 'ready'; }

	async reloadIfChanged() {
		if (!this.pendingPath) await this.activeDocument?.reloadIfChanged();
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


	async goForward(): Promise<boolean> { return this.traverse('forward'); }

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
		this.documents.forget(removed);
		if (this.pendingPath && removed(this.pendingPath)) { ++this.openRequestId; this.pendingPath = null; }
		if (this.navigation.currentPath && removed(this.navigation.currentPath)) {
			// Unsaved edits of a trashed file are dropped, not written back.

			// A diff can be visible while currentPath still refers to the last code tab.
			if (this.view) { this.view.destroy(); this.view = null; this.container.empty(); }
			this.detachDocument();
			this.navigation.currentPath = null;
		}
		this.navigation.forget(removed);
	}

	/** Saves and unmounts CodeMirror while retaining this pane's cursor and navigation state. */
	suspend(): boolean | Promise<boolean> {
  const request=++this.openRequestId;
  const outcome = this.save();
  if (outcome instanceof Promise) return outcome.then(result => result === 'ready' && request===this.openRequestId ? this.unmount() : false);
		return outcome === 'ready' ? this.unmount() : false;
	}

	private unmount(): true {
		this.openRequestId++;
		this.pendingPath = null;
		if (this.view && this.navigation.currentPath) {
			this.navigation.fileLocations.set(this.navigation.currentPath, {
				filePath: this.navigation.currentPath,
				pos: this.view.state.selection.main.head,
				scrollTop: this.view.scrollDOM.scrollTop,
			});
		}
		this.view?.destroy();
		this.view = null;
		this.container.empty();
		this.detachDocument();
		return true;
	}

	/** Host teardown after recovery was retained by the plugin's document owner. */
	disposeView() { this.unmount();this.saveHandlers={saved(){},failed(){},conflict:()=>Promise.resolve('cancel')}; }

	/** Destroys the CodeMirror instance and clears its navigation state. */
	async destroy(): Promise<boolean> {
		if (!await this.suspend()) return false;
		this.navigation.currentPath = null; this.navigation.history = []; this.navigation.forwardHistory = []; this.navigation.fileLocations.clear();
		return true;
	}
}

function normalizeConflictDecision(decision: boolean | ConflictDecision): ConflictDecision {
 return typeof decision==='boolean'?(decision?'overwrite':'discard'):decision;
}
function adaptDocumentHandlers(handlers:SaveHandlers) {
 return {saved:(file:string)=>handlers.saved(file),failed:(file:string,error:unknown)=>handlers.failed(file,error),conflict:(file:string,missing:boolean)=>handlers.conflict(file,missing).then(normalizeConflictDecision)};
}
