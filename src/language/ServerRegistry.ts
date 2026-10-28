import { setTimeout, clearTimeout } from 'timers';
import { realpathSync } from 'fs';
import * as path from 'path';
export interface ServerIdentity {
    language: string;
    root: string;
    configuration: string;
}
export interface ManagedServer {
    start(): Promise<void>;
    stop(): Promise<void>;
}
export interface ServerLease<T> {
    readonly value: T;
    readonly ready: Promise<void>;
    readonly current: boolean;
    release(): void;
}
interface Entry<T> {
    key: string;
    value: T;
    leases: Map<symbol, 'editor' | 'query'>;
    state: 'queued' | 'initializing' | 'ready' | 'stopping';
    ready: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
    lastUsed: number;
    closing?: Promise<void>;
}
export interface RegistryLimits {
    maxRunning: number;
    maxInitializing: number;
    idleMs: number;
    maxEntries: number;
}
/** Owns shared servers, admission, idle eviction and shutdown. No UI or protocol dependency. */
export class ServerRegistry<T extends ManagedServer> {
    private entries = new Map<string, Entry<T>>();
    private closing = new Map<string, Promise<void>>();
    private starts = new Set<Promise<void>>();
    private shutdownErrors: Error[] = [];
    private running = 0;
    private initializing = 0;
    private stopped = false;
    private limits: RegistryLimits;
    constructor(limits: Partial<RegistryLimits> = {}) {
        this.limits = { maxRunning: 8, maxInitializing: 2, idleMs: 30000, maxEntries: 128, ...limits };
        if (this.limits.maxRunning < 1 || this.limits.maxInitializing < 1 || this.limits.maxEntries < 1 || this.limits.idleMs < 0)
            throw Error('Invalid server limits');
    }
    private key(identity: ServerIdentity) {
        let root = path.resolve(identity.root);
        try {
            root = realpathSync(root);
        }
        catch { /* Launcher reports unavailable roots. */ }
        return JSON.stringify([identity.language, root, identity.configuration]);
    }
    acquire(identity: ServerIdentity, usage: 'editor' | 'query', create: () => T): ServerLease<T> {
        if (this.stopped)
            throw Error('Language registry disposed');
        const key = this.key(identity);
        let entry = this.entries.get(key);
        if (!entry) {
            if (this.entries.size >= this.limits.maxEntries) {
                const idle = [...this.entries.values()].filter(e => !e.leases.size).sort((a, b) => a.lastUsed - b.lastUsed)[0];
                if (idle)
                    void this.close(idle);
                else
                    throw Error('Language server queue is full');
            }
            let resolve!: () => void, reject!: (error: Error) => void;
            const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
            void ready.catch(() => { });
            entry = { key, value: create(), leases: new Map(), state: 'queued', ready, resolve, reject, lastUsed: Date.now() };
            this.entries.set(key, entry);
        }
        const current = entry, token = Symbol();
        current.leases.set(token, usage);
        if (current.timer) {
            clearTimeout(current.timer);
            current.timer = undefined;
        }
        this.pump();
        let released = false;
        let cancel!: (error: Error) => void;
        const cancelled = new Promise<void>((_, reject) => { cancel = reject; });
        const ready = Promise.race([current.ready, cancelled]);
        void ready.catch(() => { });
        return {
            value: current.value, ready,
            get current() { return !released && current.state !== 'stopping'; },
            release: () => {
                if (released)
                    return;
                released = true;
                cancel(new Error('Language lease released'));
                current.leases.delete(token);
                current.lastUsed = Date.now();
                if (!current.leases.size) {
                    if (current.state === 'queued' || current.state === 'initializing' || this.limits.idleMs === 0)
                        void this.close(current);
                    else if (current.state === 'ready') {
                        current.timer = setTimeout(() => { current.timer = undefined; void this.close(current); }, this.limits.idleMs);
                        current.timer.unref?.();
                    }
                }
                this.pump();
            }
        };
    }
    private pump() {
        if (this.stopped)
            return;
        while (this.initializing < this.limits.maxInitializing) {
            const waiting = [...this.entries.values()].filter(e => e.state === 'queued' && e.leases.size && !this.closing.has(e.key))
                .sort((a, b) => Number([...b.leases.values()].includes('editor')) - Number([...a.leases.values()].includes('editor')));
            const entry = waiting[0];
            if (!entry)
                return;
            if (this.running >= this.limits.maxRunning) {
                const idle = [...this.entries.values()].filter(e => e.state === 'ready' && !e.leases.size).sort((a, b) => a.lastUsed - b.lastUsed)[0];
                if (idle)
                    void this.close(idle);
                return;
            }
            entry.state = 'initializing';
            this.running++;
            this.initializing++;
            const start = Promise.race([Promise.resolve().then(() => entry.state === 'initializing' ? entry.value.start() : undefined), entry.ready]).then(() => {
                if (entry.state !== 'initializing')
                    return;
                entry.state = 'ready';
                entry.resolve();
            }, error => {
                entry.reject(error instanceof Error ? error : new Error(String(error)));
                void this.close(entry);
            }).finally(() => { this.initializing--; this.starts.delete(start); this.pump(); });
            this.starts.add(start);
        }
    }
    private close(entry: Entry<T>): Promise<void> {
        if (entry.closing)
            return entry.closing;
        const hadSlot = entry.state === 'ready' || entry.state === 'initializing';
        entry.state = 'stopping';
        entry.reject(new Error('Language server released'));
        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = undefined;
        }
        if (this.entries.get(entry.key) === entry)
            this.entries.delete(entry.key);
        let confirmed = false;
        const closed = Promise.resolve().then(() => entry.value.stop()).then(() => { confirmed = true; }, error => { this.shutdownErrors.push(error instanceof Error ? error : new Error(String(error))); }).finally(() => {
            if (hadSlot && confirmed)
                this.running--;
            if (this.closing.get(entry.key) === closed)
                this.closing.delete(entry.key);
            this.pump();
        });
        entry.closing = closed;
        this.closing.set(entry.key, closed);
        return closed;
    }
    retire(value: T, reason: Error) {
        const entry = [...this.entries.values()].find(e => e.value === value);
        if (entry) {
            entry.reject(reason);
            void this.close(entry);
        }
    }
    async dispose(): Promise<void> {
        this.stopped = true;
        for (const entry of [...this.entries.values()])
            void this.close(entry);
        while (this.closing.size)
            await Promise.all([...this.closing.values()]);
        await Promise.all([...this.starts]);
        if (this.shutdownErrors.length)
            throw new AggregateError(this.shutdownErrors, 'Language server shutdown incomplete');
    }
    diagnostics() {
        return {
            running: this.running, initializing: this.initializing, queued: [...this.entries.values()].filter(e => e.state === 'queued').length,
            entries: this.entries.size, leases: [...this.entries.values()].reduce((sum, e) => sum + e.leases.size, 0), idleTimers: [...this.entries.values()].filter(e => e.timer).length, closing: this.closing.size, shutdownFailures: this.shutdownErrors.length, stopped: this.stopped
        };
    }
}
