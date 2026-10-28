import { realpathSync } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { LspAdapter } from './lspAdapter.ts';
import type {ConnectionFactory} from './Connection.ts';
import type {ManagedServer} from './ServerRegistry.ts';
import { ServerRegistry, type RegistryLimits } from './ServerRegistry.ts';
export interface LanguageEvent {
    type: 'indexing' | 'failed' | 'message';
    key: string;
    root: string;
    language: string;
    name: string;
    active?: boolean;
    error?: Error;
    message?: string;
    severity?: number;
}
/** Plugin-owned registry and configuration identity; UI callbacks never enter a shared client. */
export class LanguageRuntime<T extends ManagedServer> {
    readonly registry: ServerRegistry<T>;
    private generation = 0;
    private failed = new Set<string>();
    private create:ConnectionFactory<T>;
    private notify: (event: LanguageEvent) => void;
    constructor(create:ConnectionFactory<T>,notify: (event: LanguageEvent) => void = () => { }, limits: Partial<RegistryLimits> = {}) {
        this.create=create;this.notify = notify;
        this.registry = new ServerRegistry(limits);
    }
    acquire(adapter: LspAdapter, root: string, includeWorktrees: boolean, usage: 'editor' | 'query') {
        try {
            root = realpathSync(root);
        }
        catch {
            root = path.resolve(root);
        }
        const command = adapter.command();
        const configuration = createHash('sha256').update(JSON.stringify([this.generation, command?.executable, command?.args,
            includeWorktrees, adapter.configurationKey, adapter.initializationOptions?.(root)])).digest('hex');
        const key = JSON.stringify([adapter.id, root, configuration]);
        if (this.failed.has(key))
            throw Error(`${adapter.serverName} unavailable; restart navigation to retry`);
        return this.registry.acquire({ language: adapter.id, root, configuration }, usage, () => {
            const connection = this.create({root,adapter,includeWorktrees}, {
                message: (message, severity) => this.notify({ type: 'message', key, root, language: adapter.id, name: adapter.name, message, severity }),
                indexing: active => this.notify({ type: 'indexing', key, root, language: adapter.id, name: adapter.name, active }),
                failed: error => {
                    if (this.failed.has(key))
                        return;
                    if (this.failed.size >= 128)
                        this.failed.delete(this.failed.values().next().value!);
                    this.failed.add(key);
                    this.registry.retire(connection, error);
                    this.notify({ type: 'failed', key, root, language: adapter.id, name: adapter.name, error });
                },
            });
            return connection;
        });
    }
    restart() { this.generation++; this.failed.clear(); }
    diagnostics() { return this.registry.diagnostics(); }
    dispose() { return this.registry.dispose(); }
}
