import { setTimeout, clearTimeout } from 'timers';
import { spawn, type ChildProcess } from 'child_process';
import { stdioTransport } from './lspTransport.ts';
import type { LspAdapter } from '../language/index.ts';
import type { ManagedServer } from '../language/index.ts';
import type {ProtocolEndpoint,ConnectionEvents} from '../language/index.ts';
/** Protocol/process adapter. Presentation and navigation are supplied by consumers. */
export class LanguageConnection<TEndpoint extends ProtocolEndpoint> implements ManagedServer {
    readonly endpoint:TEndpoint;
    readonly root: string;
    private adapter: LspAdapter;
    private includeWorktrees: boolean;
    private events: ConnectionEvents;
    private proc?: ChildProcess;
    private closed?: Promise<void>;
    private stopped = false;
    constructor(root:string,adapter:LspAdapter,includeWorktrees:boolean,events:ConnectionEvents,endpoint:TEndpoint){
 this.root=root;this.adapter=adapter;this.includeWorktrees=includeWorktrees;this.events=events;this.endpoint=endpoint;
}

    async start(): Promise<void> {
        if (this.stopped)
            throw Error('Language connection stopped');
        const command = this.adapter.command();
        if (!command)
            throw Error(this.adapter.missingMessage);
        const proc = spawn(command.executable, command.args, { cwd: this.root, env: command.env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.proc = proc;
        this.closed = new Promise(resolve => proc.once('close', () => resolve()));
        proc.stderr?.on('data', () => { });
        proc.once('error', error => {
            if (!this.stopped)
                this.events.failed(error);
        });
        proc.once('close', code => {
            this.events.indexing(false);
            if (!this.stopped)
                this.events.failed(Error(`${this.adapter.serverName} stopped (${code})`));
        });
        let settings: Promise<unknown> | undefined;
        try {
 await this.endpoint.connect(stdioTransport(proc,()=>settings??=this.adapter.settings(this.root,this.includeWorktrees),this.adapter.configurationSection,
  (message,type)=>{if(!this.stopped)this.events.message?.(message,type);}));
} catch(error){if(!this.stopped)this.events.failed(error instanceof Error?error:new Error(String(error)));throw error;}
        if (this.stopped)
            throw Error('Language connection stopped');
    }
    async stop(): Promise<void> {
        if (this.stopped)
            return this.closed;
        this.stopped = true;
        this.events.indexing(false);
        this.endpoint.disposeWorkspace();
        const proc = this.proc;
        // Kill before disconnect so transport can reject outstanding protocol requests.
        if (proc && proc.exitCode === null && proc.signalCode === null)
            proc.kill();
        if (proc && this.closed) {
            let term: ReturnType<typeof setTimeout> | undefined, kill: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([this.closed, new Promise<void>((_, reject) => {
                        term = setTimeout(() => {
                            if (proc.exitCode === null && proc.signalCode === null)
                                proc.kill('SIGKILL');
                        }, 1000);
                        kill = setTimeout(() => reject(Error('Language server did not exit')), 3000);
                    })]);
            }
            finally {
                if (term)
                    clearTimeout(term);
                if (kill)
                    clearTimeout(kill);
            }
        }
        this.endpoint.disconnect();
    }
}
