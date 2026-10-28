import { createFilePathIndex, type FilePathSearchOptions, type FilePathSearchResult } from './filePathIndex.ts';
import { createExclusionPolicy, type ExclusionPolicy } from '../files/index.ts';
import { searchContent, type SearchOptions } from './searchEngine.ts';
import { searchContentPage } from './contentSearchPage.ts';

export type WorktreeProvider = (root: string) => Promise<string[]>;

/** An immutable request owns cancellation and scope; it borrows the shared index. */
export class SearchSession {
	readonly root: string;
	readonly options: Readonly<SearchOptions>;
	readonly revision: number;
	readonly policy: ExclusionPolicy;
	private controller = new AbortController();
	private roots: Promise<string[]> | undefined;
	private parent?: AbortSignal;
	private release: () => void;
	private discover: WorktreeProvider;
	private index: ReturnType<typeof createFilePathIndex>;
	private disposed = false;
	private abort = () => this.dispose();
	constructor(root: string, options: SearchOptions, revision: number, policy: ExclusionPolicy,
		index: ReturnType<typeof createFilePathIndex>, discover: WorktreeProvider, release: () => void, signal?: AbortSignal) {
		this.root = root; this.options = Object.freeze({ ...options }); this.revision = revision; this.policy = policy;
		this.index = index; this.discover = discover; this.release = release; this.parent = signal;
		signal?.addEventListener('abort', this.abort, { once: true });
		if (signal?.aborted) this.controller.abort();
	}
	get signal(): AbortSignal { return this.controller.signal; }
	private check() { if (this.signal.aborted) throw new Error('Search cancelled'); }
	async worktreeRoots(): Promise<string[]> {
		this.check();
		this.roots ??= this.discover(this.root).then(roots => [...roots]);
		const roots = await new Promise<string[]>((resolve, reject) => {
			const abort = () => { this.signal.removeEventListener('abort', abort); reject(new Error('Search cancelled')); };
			this.signal.addEventListener('abort', abort, { once: true });
			void this.roots!.then(value => { this.signal.removeEventListener('abort', abort); resolve(value); },
				error => { this.signal.removeEventListener('abort', abort); reject(error instanceof Error ? error : new Error(String(error))); });
			if (this.signal.aborted) abort();
		}); this.check(); return [...roots];
	}
	async files(extra: Pick<FilePathSearchOptions, 'matchMode' | 'limit'> = {}): Promise<FilePathSearchResult> {
		const worktreeRoots = await this.worktreeRoots();
		return this.index.searchFilePathIndex(this.root, this.options.query, {
			...this.options, ...extra,
			worktreeRoots, signal: this.signal, exclusionPolicy: this.policy
		});
	}
	async content() {
		const worktreeRoots = await this.worktreeRoots();
		return searchContent(this.root, this.options, this.signal, { worktreeRoots, policy: this.policy });
	}
	async page(limit = 1000, offset = 0, includeFile?: (filePath: string) => boolean) {
		const worktreeRoots = await this.worktreeRoots();
		return searchContentPage(this.root, this.options, this.signal, limit, offset, includeFile,
			{ worktreeRoots, policy: this.policy });
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true; this.controller.abort(); this.parent?.removeEventListener('abort', this.abort); this.parent = undefined; this.release();
	}
}

/** One per plugin lifetime. Closing a consumer never aborts a shared inventory build. */
export class SearchRuntime {
	private index: ReturnType<typeof createFilePathIndex>;
	private sessions = new Set<SearchSession>();
	private policy = createExclusionPolicy([]);
	private revision = 0;
	private stopped = false;
	private discover: WorktreeProvider;
	constructor(discover: WorktreeProvider, index = createFilePathIndex()) { this.discover = discover; this.index = index; }
	setExcludedFiles(globs: readonly string[]) {
		const policy = createExclusionPolicy(globs);
		if (policy.key === this.policy.key) return;
		this.policy = policy; this.revision++;
		// Entries include the policy key; in-flight requests retain their captured rules.
	}
	configuration() { return { policy: this.policy, revision: this.revision }; }
	exclusionPolicy(): ExclusionPolicy { return this.policy; }
	begin(root: string, options: SearchOptions, signal?: AbortSignal, configuration = this.configuration()): SearchSession {
		if (this.stopped) throw new Error('Search runtime disposed');
		const session = new SearchSession(root, options, configuration.revision, configuration.policy, this.index, this.discover,
			() => this.sessions.delete(session), signal);
		this.sessions.add(session); return session;
	}
	async files(root: string, query: string, options: FilePathSearchOptions = {}) {
		const session = this.begin(root, { ...options, query }, options.signal);
		try { return await session.files({ matchMode: options.matchMode, limit: options.limit }); }
		finally { session.dispose(); }
	}
	async content(root: string, options: SearchOptions, signal: AbortSignal) {
		const session = this.begin(root, options, signal);
		try { return await session.content(); } finally { session.dispose(); }
	}
	async page(root: string, options: SearchOptions, signal: AbortSignal, limit = 1000, offset = 0,
		includeFile?: (filePath: string) => boolean, configuration = this.configuration()) {
		const session = this.begin(root, options, signal, configuration);
		try { return await session.page(limit, offset, includeFile); } finally { session.dispose(); }
	}
	async worktreeRoots(root: string): Promise<string[]> {
		if (this.stopped) throw new Error('Search runtime disposed');
		const roots = await this.discover(root);
		if (this.stopped) throw new Error('Search runtime disposed');
		return roots;
	}
	async warm(root: string, includeWorktrees = false) {
		const revision = this.revision, policy = this.policy;
		const roots = await this.worktreeRoots(root);
		if (revision !== this.revision) return;
		await this.index.warmFileIndex(root, includeWorktrees, roots, policy);
	}
	invalidate(root: string) { this.index.invalidateFilePathIndex(root); }
	dispose() {
		this.stopped = true;
		for (const session of [...this.sessions]) session.dispose();
		this.index.dispose();
	}
	diagnostics() { return { ...this.index.diagnostics(), sessions: this.sessions.size, revision: this.revision }; }
}
