import { execFile } from 'child_process';
import { promisify } from 'util';
import { realpath } from 'fs/promises';
import * as path from 'path';

export interface ChangedFile { code: string; file: string }
export interface RepositoryContext { root: string; gitDir: string; commonDir: string }
export interface GitCommandResult { ok: boolean; stdout: string; stderr: string }
export type GitCommand = (cwd: string, args: string[]) => Promise<GitCommandResult>;
export type RepositoryDiscovery = { state: 'ready'; context: RepositoryContext } | { state: 'outside' } | { state: 'error'; error: string };
export interface ReadyGitSnapshot { state: 'ready'; context: RepositoryContext; changes: readonly ChangedFile[]; revision: number }
export type GitSnapshot = ReadyGitSnapshot | { state: 'error'; context: RepositoryContext; error: string; lastGood: ReadyGitSnapshot | null };
export interface RepositoryReader {
	resolve(target: string, isDirectory: boolean): Promise<RepositoryDiscovery>;
	read(context: RepositoryContext): Promise<GitSnapshot>;
}
const exec = promisify(execFile);
export const runGitCommand: GitCommand = async (cwd, args) => {
	try {
		const { stdout, stderr } = await exec('git', ['--no-optional-locks', ...args], { cwd, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
		return { ok: true, stdout, stderr };
	} catch (error) {
		const result = error as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, stdout: result.stdout ?? '', stderr: result.stderr || result.message || String(error) };
	}
};
const outputPath = (stdout: string) => stdout.replace(/\r?\n$/, '');
export function parseGitStatus(stdout: string): ChangedFile[] {
	const entries = stdout.split('\0'), changes: ChangedFile[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index] ?? ''; if (!entry) continue;
		const code = entry.slice(0, 2); changes.push({ code, file: entry.slice(3) });
		if (code.includes('R') || code.includes('C')) index++;
	}
	return changes;
}
interface StatusEntry { context: RepositoryContext; generation: number; updated: number; snapshot?: GitSnapshot; lastGood?: ReadyGitSnapshot; pending?: Promise<GitSnapshot> }

/** Shares repository identity/status across consumers. No DOM, watchers or active-folder state. */
export class GitRepositoryStore implements RepositoryReader {
	private command: GitCommand;
	private now: () => number;
	private ttl: number;
	private discoveries = new Map<string, { updated: number; result: Promise<RepositoryDiscovery> }>();
	private contexts = new Map<string, Promise<RepositoryDiscovery>>();
	private statuses = new Map<string, StatusEntry>();
	private stopped = false;
	private discoveryGeneration = 0;
	private commands = 0;
	constructor(command: GitCommand = runGitCommand, now: () => number = Date.now, ttl = 100) { this.command = command; this.now = now; this.ttl = ttl; }
	private async execute(cwd: string, args: string[]): Promise<GitCommandResult> {
		this.commands++;
		try { return await this.command(cwd, args); } catch (error) { return { ok: false, stdout: '', stderr: String(error) }; }
		finally { this.commands--; }
	}
	async resolve(target: string, isDirectory: boolean): Promise<RepositoryDiscovery> {
		if (this.stopped) return { state: 'error', error: 'Git runtime is stopped' };
		const generation = this.discoveryGeneration;
		const directory = isDirectory ? target : path.dirname(target);
		const cwd = await realpath(directory).catch(() => path.resolve(directory));
		if (this.stopped) return { state: 'error', error: 'Git runtime is stopped' };
		if (generation !== this.discoveryGeneration) return this.resolve(target, isDirectory);
		const cached = this.discoveries.get(cwd);
		if (cached && this.now() - cached.updated < 5000) return cached.result;
		const result = this.discover(cwd, generation).then(value => {
			if (this.stopped) return { state: 'error' as const, error: 'Git runtime is stopped' };
			if (generation !== this.discoveryGeneration) return this.resolve(target, isDirectory);
			if (value.state === 'error' && this.discoveries.get(cwd)?.result === result) this.discoveries.delete(cwd);
			return value;
		}); this.discoveries.set(cwd, { updated: this.now(), result });
		while (this.discoveries.size > 128) this.discoveries.delete(this.discoveries.keys().next().value!);
		return result;
	}
	private async discover(cwd: string, generation: number): Promise<RepositoryDiscovery> {
		const root = await this.execute(cwd, ['rev-parse', '--show-toplevel']);
		if (this.stopped) return { state: 'error', error: 'Git runtime is stopped' };
		if (generation !== this.discoveryGeneration) return this.resolve(cwd, true);
		if (!root.ok) return /not a git repository|must be run in a work tree/i.test(root.stderr) ? { state: 'outside' } : { state: 'error', error: root.stderr };
		const directory = outputPath(root.stdout);
		if (!directory) return { state: 'error', error: 'Git returned an empty working-tree root' };
		let context = this.contexts.get(directory);
		if (!context) {
			context = Promise.all([this.execute(directory, ['rev-parse', '--absolute-git-dir']), this.execute(directory, ['rev-parse', '--git-common-dir'])])
				.then(([gitDir, commonDir]): RepositoryDiscovery => gitDir.ok && commonDir.ok
					? { state: 'ready', context: { root: directory, gitDir: path.resolve(directory, outputPath(gitDir.stdout)), commonDir: path.resolve(directory, outputPath(commonDir.stdout)) } }
					: { state: 'error', error: gitDir.stderr || commonDir.stderr });
			this.contexts.set(directory, context);
			while (this.contexts.size > 32) this.contexts.delete(this.contexts.keys().next().value!);
			void context.then(result => { if (result.state === 'error' && this.contexts.get(directory) === context) this.contexts.delete(directory); });
		}
		return context;
	}
	read(context: RepositoryContext): Promise<GitSnapshot> {
		if (this.stopped) return Promise.resolve({ state: 'error', context, error: 'Git runtime is stopped', lastGood: null });
		const identity = [context.root, context.gitDir, context.commonDir].join('\0');
		let entry = this.statuses.get(identity);
		if (!entry) { entry = { context, generation: 0, updated: -Infinity }; this.statuses.set(identity, entry); }
		if (entry.pending) return entry.pending;
		if (entry.snapshot && this.now() - entry.updated < this.ttl) return Promise.resolve(entry.snapshot);
		const owner = entry, generation = entry.generation;
		const pending = this.execute(context.root, ['status', '--porcelain=v1', '-z', '-u']).then(result => {
			if (this.stopped) return { state: 'error' as const, context, error: 'Git runtime is stopped', lastGood: owner.lastGood ?? null };
			if (owner.generation !== generation) {
				if (owner.pending === pending) owner.pending = undefined;
				return this.read(context);
			}
			let snapshot: GitSnapshot;
			if (result.ok) {
				const changes = parseGitStatus(result.stdout), previous = owner.lastGood;
				const unchanged = previous && changes.length === previous.changes.length && changes.every((change, index) => change.code === previous.changes[index]?.code && change.file === previous.changes[index]?.file);
				snapshot = unchanged ? previous : { state: 'ready', context, changes, revision: (previous?.revision ?? 0) + 1 }; owner.lastGood = snapshot;
			} else snapshot = { state: 'error', context, error: result.stderr, lastGood: owner.lastGood ?? null };
			owner.updated = this.now(); owner.snapshot = snapshot;
			// Status data is bounded. In-flight requests retain their own entry until resolution.
			while (this.statuses.size > 32) {
				const key = [...this.statuses.keys()].find(key => key !== identity && !this.statuses.get(key)?.pending);
				if (!key) break; this.statuses.delete(key);
			}
			return snapshot;
		}).finally(() => { if (owner.pending === pending) owner.pending = undefined; });
		owner.pending = pending; return pending;
	}
	/** Filesystem events are hints: invalidate pending generations as well as completed cache entries. */
	invalidate(root?: string) {
		for (const entry of this.statuses.values()) if (!root || entry.context.root === root) { entry.generation++; entry.updated = -Infinity; }
	}
	invalidatePath(target: string) {
		const contains = (root: string) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
		for (const entry of this.statuses.values()) if ([entry.context.root, entry.context.gitDir, entry.context.commonDir].some(contains)) { entry.generation++; entry.updated = -Infinity; }
	}
	invalidateDiscovery() { this.discoveryGeneration++; this.discoveries.clear(); this.contexts.clear(); }
	diagnostics() { return { repositories: this.statuses.size, discoveries: this.discoveries.size, contexts: this.contexts.size, activeCommands: this.commands, disposed: this.stopped }; }
	dispose() { this.stopped = true; this.invalidate(); this.discoveries.clear(); this.contexts.clear(); this.statuses.clear(); }
}
