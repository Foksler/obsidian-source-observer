import { setTimeout, clearTimeout } from 'timers';
import { fileURLToPath } from 'url';
import { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { LSPClient, LSPPlugin, Workspace, type WorkspaceFile } from '@codemirror/lsp-client';
import type {Position,LspLocation} from '../language/index.ts';
export async function dispatchDefinitionLocation(location: LspLocation, sourceUri: string, sourceView: EditorView, display: (uri: string) => Promise<EditorView | null>, beforeJump: () => void, positionToOffset: (view: EditorView, position: Position) => number): Promise<boolean> {
    let target: EditorView | null = sourceView;
    if (location.uri !== sourceUri) {
        beforeJump();
        target = await display(location.uri);
    }
    if (!target)
        return false;
    if (location.uri === sourceUri)
        beforeJump();
    target.dispatch({
        selection: { anchor: positionToOffset(target, location.range.start) },
        scrollIntoView: true,
        userEvent: 'select.definition',
    });
    target.focus();
    return true;
}
function toFilePath(uri: string): string | null {
    try {
        return fileURLToPath(uri);
    }
    catch {
        return null;
    }
}
/** Live editor documents and separate read-only snapshots used by references. */
export class ViewerWorkspace extends Workspace {
    files: WorkspaceFile[] = [];
    private attachments = new Map<string, Set<EditorView>>();
    private routes = new Map<EditorView, (filePath: string) => Promise<EditorView | null>>();
    private versions = new Map<string, number>();
    private announced = new Set<string>();
    private temporary = new Map<string, {
        refs: number;
        file?: WorkspaceFile;
        pending?: Promise<WorkspaceFile>;
    }>();
    private referenceSnapshots = new Map<string, WorkspaceFile>();
    private referenceCounts = new Map<string, number>();
    private referenceDeadlines = new Map<string, number>();
    private referenceTimer?: ReturnType<typeof setTimeout>;
    private stopped = false;
    private display: (filePath: string) => Promise<EditorView | null>;
    private languageId: (filePath: string) => string | null;
    private readDocument:(uri:string)=>Promise<string>;
    constructor(client: LSPClient, display: (filePath: string) => Promise<EditorView | null>, languageId: (filePath: string) => string | null = () => 'plaintext',readDocument:(uri:string)=>Promise<string>=()=>Promise.reject(new Error('No language document reader'))) {
        super(client);
        this.display = display;
        this.languageId = languageId;this.readDocument=readDocument;
    }
    private viewFor(uri: string): EditorView | null {
        const views = [...(this.attachments.get(uri) ?? [])];
        return views.find(view => view.hasFocus) ?? views[0] ?? null;
    }
    bindDisplay(view: EditorView, display: (filePath: string) => Promise<EditorView | null>): () => void {
        this.routes.set(view, display);
        return () => this.routes.delete(view);
    }
    connected() {
        this.announced.clear();
        for (const file of this.files)
            if (!this.referenceSnapshots.has(file.uri))
                this.announce(file);
    }
    private announce(file: WorkspaceFile) {
        if (this.stopped || !this.client.connected || this.announced.has(file.uri))
            return;
        this.announced.add(file.uri);
        this.client.didOpen(file);
    }
    private forget(uri: string) {
        if (this.announced.delete(uri))
            this.client.didClose(uri);
    }
    syncFiles() {
        const updates = [];
        for (const file of this.files) {
            const view = this.viewFor(file.uri), plugin = view && LSPPlugin.get(view);
            if (!view || !plugin || plugin.unsyncedChanges.empty)
                continue;
            const changes = plugin.unsyncedChanges, prevDoc = file.doc;
            file.doc = view.state.doc;
            file.version++;
            this.versions.set(file.uri, file.version);
            plugin.clear();
            for (const other of this.attachments.get(file.uri) ?? []) {
                if (other !== view && other.state.doc.eq(view.state.doc))
                    LSPPlugin.get(other)?.clear();
            }
            updates.push({ file, changes, prevDoc });
        }
        return updates;
    }
    openFile(uri: string, languageId: string, view: EditorView) {
        if (this.stopped)
            return;
        const hadLive = !!this.attachments.get(uri)?.size;
        let views = this.attachments.get(uri);
        if (!views) {
            views = new Set();
            this.attachments.set(uri, views);
        }
        views.add(view);
        const existing = this.getFile(uri);
        if (existing && hadLive)
            return;
        if (existing) {
            this.files = this.files.filter(file => file !== existing);
            this.forget(uri);
        }
        this.referenceSnapshots.delete(uri);
        this.referenceDeadlines.delete(uri);
        const version = (this.versions.get(uri) ?? 0) + 1;
        this.versions.set(uri, version);
        const file: WorkspaceFile = { uri, languageId, version, doc: view.state.doc, getView: () => this.viewFor(uri) };
        this.files.push(file);
        this.announce(file);
    }
    closeFile(uri: string, view?: EditorView) {
        const views = this.attachments.get(uri);
        if (view)
            views?.delete(view);
        else
            views?.clear();
        if (views?.size)
            return;
        this.attachments.delete(uri);
        // A concurrent document request may still use this URI after the last editor detached.
        if (this.temporary.get(uri)?.refs)
            return;
        this.files = this.files.filter(file => file.uri !== uri);
        this.forget(uri);
    }
    async requestFile(uri: string): Promise<WorkspaceFile | null> {
        if (this.stopped)
            return null;
        const open = this.getFile(uri);
        if (open)
            return open;
        const cached = this.referenceSnapshots.get(uri);
        if (cached)
            return cached;
        const filePath = toFilePath(uri);
        if (!filePath)
            return null;
        try {
            const contents = await this.readDocument(uri);
            if (this.stopped)
                return null;
            return this.getFile(uri) ?? {
                uri, languageId: this.languageId(filePath) ?? 'plaintext', version: (this.versions.get(uri) ?? 0) + 1,
                doc: Text.of(contents.split(/\r?\n/)), getView: () => null
            };
        }
        catch {
            return null;
        }
    }
    async withDocument<T>(uri: string, operation: () => Promise<T>): Promise<T> {
        if (this.stopped)
            throw Error('Language workspace stopped');
        let state = this.temporary.get(uri);
        if (!state) {
            state = { refs: 0 };
            this.temporary.set(uri, state);
        }
        state.refs++;
        try {
            if (!this.getFile(uri)) {
                state.pending ??= this.requestFile(uri).then(file => {
                    if (!file || this.stopped)
                        throw Error('Could not read language document');
                    const current = this.getFile(uri);
                    if (current)
                        return current;
                    state.file = file;
                    this.versions.set(uri, file.version);
                    this.files.push(file);
                    this.announce(file);
                    return file;
                });
                await state.pending;
            }
            if (this.stopped)
                throw Error('Language workspace stopped');
            this.client.sync();
            return await operation();
        }
        finally {
            state.refs--;
            if (!state.refs) {
                this.temporary.delete(uri);
                if (!this.attachments.get(uri)?.size) {
                    this.files = this.files.filter(file => file.uri !== uri);
                    this.forget(uri);
                }
            }
        }
    }
    async primeReferenceFiles(uris: string[]): Promise<() => void> {
        const owned = new Set<string>();
        for (const uri of new Set(uris)) {
            if (this.attachments.get(uri)?.size || this.temporary.has(uri))
                continue;
            this.referenceCounts.set(uri, (this.referenceCounts.get(uri) ?? 0) + 1);
            owned.add(uri);
            this.referenceDeadlines.delete(uri);
            const file = await this.requestFile(uri);
            if (!file || this.stopped)
                continue;
            this.referenceSnapshots.set(uri, file);
            if (!this.getFile(uri))
                this.files.push(file);
        }
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            for (const uri of owned) {
                const remaining = (this.referenceCounts.get(uri) ?? 1) - 1;
                if (remaining > 0) {
                    this.referenceCounts.set(uri, remaining);
                    continue;
                }
                this.referenceCounts.delete(uri);
                if (!this.attachments.get(uri)?.size && !this.temporary.has(uri))
                    this.files = this.files.filter(file => file.uri !== uri);
                if (this.stopped)
                    continue;
                this.referenceDeadlines.set(uri, Date.now() + 21000);
            }
            this.scheduleReferenceCleanup();
        };
    }
    private scheduleReferenceCleanup() {
        if (this.stopped || this.referenceTimer || !this.referenceDeadlines.size)
            return;
        let deadline = Infinity;
        for (const expiry of this.referenceDeadlines.values())
            deadline = Math.min(deadline, expiry);
        this.referenceTimer = setTimeout(() => {
            this.referenceTimer = undefined;
            const now = Date.now();
            for (const [uri, expiry] of this.referenceDeadlines) {
                if (expiry > now)
                    continue;
                this.referenceDeadlines.delete(uri);
                if (!this.referenceCounts.has(uri))
                    this.referenceSnapshots.delete(uri);
            }
            this.scheduleReferenceCleanup();
        }, Math.max(1, deadline - Date.now()));
        this.referenceTimer.unref?.();
    }
    displayFile(uri: string) {
        const filePath = toFilePath(uri);
        if (!filePath || this.stopped)
            return Promise.resolve(null);
        const focused = [...this.routes].filter(([view]) => view.dom.contains(view.dom.ownerDocument.activeElement));
        if (focused.length === 1)
            return focused[0]![1](filePath);
        return this.routes.size ? Promise.resolve(null) : this.display(filePath);
    }
    dispose() {
        this.stopped = true;
        if (this.referenceTimer)
            clearTimeout(this.referenceTimer);
        this.referenceTimer = undefined;
        this.referenceDeadlines.clear();
        this.referenceCounts.clear();
        this.referenceSnapshots.clear();
        this.temporary.clear();
        this.attachments.clear();
        this.routes.clear();
        this.versions.clear();
        this.announced.clear();
        this.files = [];
    }
}
