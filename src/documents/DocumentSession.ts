export interface DocumentText { content: string; editable: boolean }
export interface DocumentIO {
	read(filePath: string): Promise<DocumentText | null>;
	compareAndWrite(filePath: string, text: string, expected: string): 'saved' | 'changed' | 'missing';
	write(filePath: string, text: string): void;
}
export type ConflictDecision = 'overwrite' | 'discard' | 'cancel';
export type SaveOutcome = 'ready' | 'blocked' | 'cancelled';
export interface DocumentHandlers {
	saved(filePath: string): void;
	failed(filePath: string, error: unknown): void;
	conflict(filePath: string, missing: boolean): Promise<ConflictDecision>;
}
export interface DocumentSnapshot {
	path: string;
	text: string;
	revision: number;
	editable: boolean;
	dirty: boolean;
	state: 'clean' | 'dirty' | 'conflict' | 'error' | 'deleted';
}
export interface DocumentRecovery { path: string; text: string; baseline: string; revision: number }
const noopHandlers: DocumentHandlers = { saved() { }, failed() { }, conflict: () => Promise.resolve('cancel') };
type Schedule = (callback: () => void, delay: number) => () => void;
// eslint-disable-next-line obsidianmd/prefer-window-timers -- This host-independent model accepts an injected scheduler.
const schedule: Schedule = (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); };

/** Owns text and save decisions independently of any editor or renderer. */
export class DocumentSession {
	private text: string;
	private baseline: string | null;
	private revision = 1;
	private state: DocumentSnapshot['state'] = 'clean';
	private listeners = new Set<(snapshot: DocumentSnapshot) => void>();
	private cancelTimer?: () => void;
	private pending?: Promise<SaveOutcome>;
	private cancelDecision?: () => void;
	private generation = 0;
	private handlers = noopHandlers;
	readonly path: string;
	private io: DocumentIO;
	private clock: Schedule;
	constructor(filePath: string, initial: DocumentText | null, io: DocumentIO, clock: Schedule = schedule) {
		this.path = filePath; this.io = io; this.clock = clock;
		this.text = initial?.content ?? '(cannot read file)';
		this.baseline = initial?.editable ? initial.content : null;
	}
	get hasPendingSave(): boolean { return this.pending !== undefined; }
	setHandlers(handlers: DocumentHandlers) { this.handlers = handlers; }
	snapshot(): DocumentSnapshot {
		return {
			path: this.path, text: this.text, revision: this.revision, editable: this.baseline !== null && this.state !== 'deleted',
			dirty: this.baseline !== null && this.text !== this.baseline && this.state !== 'deleted', state: this.state
		};
	}
	subscribe(listener: (snapshot: DocumentSnapshot) => void): () => void {
		this.listeners.add(listener); return () => { this.listeners.delete(listener); };
	}
	private publish() { const snapshot = this.snapshot(); for (const listener of this.listeners) listener(snapshot); }
	edit(text: string) {
		if (this.baseline === null || this.state === 'deleted' || text === this.text) return;
		this.text = text; this.revision++;
		if (!this.pending) this.state = this.text === this.baseline ? 'clean' : 'dirty';
		this.cancelTimer?.();
		this.cancelTimer = this.snapshot().dirty ? this.clock(() => { this.cancelTimer = undefined; void this.save(); }, 1000) : undefined;
		this.publish();
	}
	/** The synchronous ready/error path preserves switch ordering; a decision is awaited explicitly. */
	save(): SaveOutcome | Promise<SaveOutcome> {
		this.cancelTimer?.(); this.cancelTimer = undefined;
		if (this.state === 'deleted') return 'cancelled';
		if (this.pending) return this.pending;
		if (!this.snapshot().dirty || this.baseline === null) return 'ready';
		try {
			const result = this.io.compareAndWrite(this.path, this.text, this.baseline);
			if (result === 'saved') { this.markSaved(); return 'ready'; }
			this.state = 'conflict';
			const generation = this.generation;
			const cancelled = new Promise<ConflictDecision>(resolve => { this.cancelDecision = () => resolve('cancel'); });
			// Set pending before exposing the conflict to listeners or another transition.
			this.pending = Promise.race([this.handlers.conflict(this.path, result === 'missing'), cancelled])
				.then(async (decision): Promise<SaveOutcome> => {
					if (generation !== this.generation || this.state === 'deleted') return 'cancelled';
					if (decision === 'cancel') { this.state = 'dirty'; return 'blocked'; }
					if (decision === 'discard') {
						const revision = this.revision, file = await this.io.read(this.path);
						if (generation !== this.generation || this.snapshot().state === 'deleted') return 'cancelled';
						if (revision !== this.revision) { this.state = 'dirty'; return 'blocked'; }
						this.replace(file); return 'ready';
					}
					this.io.write(this.path, this.text); this.markSaved(); return 'ready';
				}).catch((error: unknown) => this.failed(error)).finally(() => {
					this.pending = undefined; this.cancelDecision = undefined; this.publish();
				});
			this.publish(); return this.pending;
		} catch (error) { return this.failed(error); }
	}
	private failed(error: unknown): SaveOutcome {
		if (this.state === 'deleted') return 'cancelled';
		this.state = 'error'; this.handlers.failed(this.path, error); this.publish(); return 'blocked';
	}
	private markSaved() { this.baseline = this.text; this.state = 'clean'; this.handlers.saved(this.path); this.publish(); }
	private replace(file: DocumentText | null) {
		this.text = file?.content ?? '(cannot read file)'; this.baseline = file?.editable ? file.content : null;
		this.revision++; this.state = 'clean'; this.publish();
	}
	async reloadIfChanged(): Promise<void> {
		if (this.snapshot().dirty || this.pending || this.state === 'deleted') return;
		const generation = this.generation, revision = this.revision, file = await this.io.read(this.path);
		if (generation !== this.generation || revision !== this.revision || this.snapshot().dirty || this.pending) return;
		if (file && file.content !== this.text) this.replace(file);
	}
	/** Trash revokes the identity, including an outstanding overwrite decision. */
	revoke() {
		this.generation++; this.state = 'deleted'; this.cancelTimer?.(); this.cancelTimer = undefined;
		this.cancelDecision?.(); this.publish();
	}
	recovery(): DocumentRecovery | null {
		return this.snapshot().dirty && this.baseline !== null ? { path: this.path, text: this.text, baseline: this.baseline, revision: this.revision } : null;
	}
	restore(recovery: DocumentRecovery) {
		this.cancelTimer?.(); this.text = recovery.text; this.baseline = recovery.baseline;
		this.revision = recovery.revision; this.state = 'dirty'; this.publish();
	}
	stop() { this.generation++; this.cancelTimer?.(); this.cancelTimer = undefined; this.cancelDecision?.(); this.handlers = noopHandlers; this.listeners.clear(); }
}
