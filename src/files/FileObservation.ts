import { watch as watchFileSystem } from 'fs';
import * as path from 'path';
import { FileScope } from './FileScope.ts';
export interface RepositoryMetadata {gitDir:string;commonDir:string}

export interface WatchHandle { close(): void }
export interface ObservationEnvironment {
	watch(target: string, recursive: boolean, changed: (event: string, filename: string | null) => void, failed: () => void): WatchHandle;
	after(callback: () => void, delay: number): () => void;
	every(callback: () => void, delay: number): () => void;
}
export const nodeObservationEnvironment: ObservationEnvironment = {
	watch(target, recursive, changed, failed) {
		const handle = watchFileSystem(target, { recursive }, (event, filename) => changed(event, filename?.toString() ?? null));
		handle.on('error', failed); return handle;
	},
	// eslint-disable-next-line obsidianmd/prefer-window-timers -- Filesystem runtime has an injected environment and does not depend on the renderer.
	after(callback, delay) { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); },
	// eslint-disable-next-line obsidianmd/prefer-window-timers -- Fallback polling belongs to the same scope as the filesystem handles.
	every(callback, delay) { const timer = setInterval(callback, delay); return () => clearInterval(timer); },
};
export interface ObservationCallbacks {
	pathsChanged(): void;
	currentFile(): string | null;
	contentChanged(): void;
	gitChanged(): void;
	invalidateGit(target: string | null, topology: boolean): void;
	poll(): void;
}

/** Owns one workspace folder's watchers, debounce timers, metadata subscriptions and fallback poll. */
export class FileObservation {
	private scope: FileScope;
	private callbacks: ObservationCallbacks;
	private environment: ObservationEnvironment;
	private rootWatch?: WatchHandle;
	private metadata = new Map<string, WatchHandle>();
	private timers = new Map<string, () => void>();
	private cancelPoll?: () => void;
	private stopped = false;
	constructor(scope: FileScope, callbacks: ObservationCallbacks, environment: ObservationEnvironment = nodeObservationEnvironment) {
		this.scope = scope; this.callbacks = callbacks; this.environment = environment; this.watchRoot();
	}
	updateScope(scope: FileScope) {
		if (scope.root.display !== this.scope.root.display) throw Error('An observation cannot change its workspace folder');
		const retargeted = scope.root.canonical !== this.scope.root.canonical;
		this.scope = scope;
		if (retargeted) {
			for (const cancel of this.timers.values()) cancel(); this.timers.clear();
			for (const handle of this.watchers) handle.close();
			this.rootWatch = undefined; this.metadata.clear(); this.watchRoot();
		}
	}
	private watchRoot() {
		if (this.stopped || this.rootWatch) return;
		try {
			let handle: WatchHandle;
			handle = this.environment.watch(this.scope.root.display, true, (event, filename) => {
				if (this.stopped || this.rootWatch !== handle) return;
				const relative = filename?.split(path.sep).join('/') ?? null;
				const topology = !!relative && relative.split('/').some(part => part === '.git' || part === 'commondir' || part === 'gitdir');
				this.callbacks.invalidateGit(relative ? path.resolve(this.scope.root.canonical, relative) : null, topology);
				this.scheduleGit();
				const current = this.callbacks.currentFile();
				if (!relative || (current && path.resolve(this.scope.root.display, relative) === current)) this.debounce('content', 100, () => {
					if (!relative || this.callbacks.currentFile() === current) this.callbacks.contentChanged();
				});
				if (event === 'rename' && (!relative || this.scope.allows('filename', relative))) this.debounce('paths', 80, () => this.callbacks.pathsChanged());
			}, () => { if (this.rootWatch === handle) { handle.close(); this.rootWatch = undefined; } });
			this.rootWatch = handle;
		} catch { /* Polling still runs when recursive watching is unavailable. */ }
	}
	setRepositories(repositories: readonly RepositoryMetadata[]) {
		if (this.stopped) return;
		const desired = new Map<string, boolean>();
		for (const repository of repositories) {
			desired.set(repository.gitDir, false); desired.set(repository.commonDir, false);
			desired.set(path.join(repository.commonDir, 'refs'), true);
		}
		for (const [target, handle] of this.metadata) if (!desired.has(target)) { handle.close(); this.metadata.delete(target); }
		for (const [target, recursive] of desired) if (!this.metadata.has(target)) {
			try {
				let handle: WatchHandle;
				handle = this.environment.watch(target, recursive, (_event, filename) => {
					if (this.stopped || this.metadata.get(target) !== handle) return;
					this.callbacks.invalidateGit(filename ? path.resolve(target, filename) : target, filename === null || /(?:^|[\\/])(?:worktrees|commondir|gitdir)(?:[\\/]|$)/.test(filename));
					this.scheduleGit();
				}, () => { if (this.metadata.get(target) === handle) { handle.close(); this.metadata.delete(target); } });
				this.metadata.set(target, handle);
			} catch { /* Watching the metadata parent plus polling covers missing refs/index files. */ }
		}
	}
	scheduleGit() { this.debounce('git', 800, () => this.callbacks.gitChanged()); }
	private debounce(key: string, delay: number, callback: () => void) {
		if (this.stopped) return;
		this.timers.get(key)?.();
		this.timers.set(key, this.environment.after(() => { this.timers.delete(key); if (!this.stopped) callback(); }, delay));
	}
	enablePolling() {
		if (this.stopped || this.cancelPoll) return;
		this.cancelPoll = this.environment.every(() => { if (!this.stopped) { this.watchRoot(); this.callbacks.poll(); } }, 5000);
	}
	stopPolling() { this.cancelPoll?.(); this.cancelPoll = undefined; }
	get watchers(): readonly WatchHandle[] { return [...(this.rootWatch ? [this.rootWatch] : []), ...this.metadata.values()]; }
	diagnostics() { return { watchers: this.watchers.length, timers: this.timers.size, polling: !!this.cancelPoll, disposed: this.stopped }; }
	dispose() {
		this.stopped = true; this.stopPolling();
		for (const cancel of this.timers.values()) cancel(); this.timers.clear();
		for (const watcher of this.watchers) { try { watcher.close(); } catch { /* Already closed by the platform. */ } }
		this.rootWatch = undefined; this.metadata.clear();
	}
}

/** Plugin lifetime owns active folder scopes, including views still awaiting host teardown. */
export class FileObservationRuntime {
	private active = new Set<FileObservation>();
	private stopped = false;
	open(scope: FileScope, callbacks: ObservationCallbacks, environment?: ObservationEnvironment): FileObservation | undefined {
		if (this.stopped) return;
		const observation = new FileObservation(scope, callbacks, environment); this.active.add(observation); return observation;
	}
	close(observation: FileObservation) { observation.dispose(); this.active.delete(observation); }
	diagnostics() {
		const scopes = [...this.active].map(scope => scope.diagnostics());
		return { scopes: scopes.length, watchers: scopes.reduce((total, scope) => total + scope.watchers, 0), timers: scopes.reduce((total, scope) => total + scope.timers, 0), polls: scopes.filter(scope => scope.polling).length, disposed: this.stopped };
	}
	dispose() { this.stopped = true; for (const observation of this.active) observation.dispose(); this.active.clear(); }
}
