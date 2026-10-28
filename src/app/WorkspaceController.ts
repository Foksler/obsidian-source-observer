import { closeFolderWorkspace } from '../workspace/index.ts';
import type { WorkspaceSession, FolderSession } from '../workspace/index.ts';
import { WorkspaceTransitions, type TransitionTicket } from './WorkspaceTransitions.ts';
import type { CodePaneSession } from '../workspace/index.ts';

export interface WorkspacePorts {
	closed(): boolean;
	prepareDocument(): Promise<boolean>;
	captureFolder(): FolderSession;
	/** Synchronous commit after prepareDocument; false retains the previous renderer. */
	restoreEditor(session: CodePaneSession | null): boolean | void;
	beforeChange(): void;
	presentFolder(dir: string, session: FolderSession | undefined): void;
	presentFolders(): void;
	persistFolders(): Promise<void>;
	loadTree(dir: string): Promise<void>;
	worktrees(dir: string): Promise<string[]>;
	applyWorktrees(roots: string[]): void;
	treeQuery(): string;
	filterTree(query: string): Promise<void>;
	refreshGit(): Promise<void>;
	watch(): void;
	showActive(): Promise<void>;
	poll(enabled: boolean): void;
}

/** Owns the folder transition protocol; adapters perform UI, filesystem and host effects. */
export class WorkspaceController {
	private state: WorkspaceSession;
	private ports: WorkspacePorts;
	private transitions: WorkspaceTransitions;
	constructor(state: WorkspaceSession, ports: WorkspacePorts) {
		this.state = state; this.ports = ports; this.transitions = new WorkspaceTransitions(state, () => ports.closed());
	}
	async open(dirs: string[]) {
		if (this.ports.closed() || !dirs.length) return;
		this.state.folders = [...new Set([...this.state.folders, ...dirs])];
		if (!await this.activate(dirs[0]!) && !this.ports.closed()) {
			this.ports.presentFolders(); await this.ports.persistFolders();
		}
	}
	async close(dir: string) {
		if (this.ports.closed()) return;
		const next = closeFolderWorkspace(this.state.folders, this.state.activeFolder, dir);
		if (next.activePath === this.state.activeFolder) {
			this.state.folders = next.paths; this.state.sessions.delete(dir);
			this.ports.presentFolders(); await this.ports.persistFolders(); return;
		}
		const ticket = this.transitions.folder();
		if (!await ticket.prepare(() => this.ports.prepareDocument())) return;
		const accepted = closeFolderWorkspace(this.state.folders, this.state.activeFolder, dir);
		await this.activate(accepted.activePath, ticket, { paths: accepted.paths, path: dir });
	}
	async activate(dir: string, prepared?: TransitionTicket, closing?: { paths: string[]; path: string }): Promise<boolean> {
		if (this.ports.closed()) return false;
		const ticket = prepared ?? this.transitions.folder();
		if (dir === this.state.activeFolder) {
			this.ports.presentFolders(); await this.ports.persistFolders(); return ticket.current();
		}
		if (!prepared && !await ticket.prepare(() => this.ports.prepareDocument())) return false;
		if (!ticket.current()) return false;
		const previous = this.state.activeFolder;
		const previousSession = previous && previous !== closing?.path && this.state.folders.includes(previous) ? this.ports.captureFolder() : null;
		const session = this.state.sessions.get(dir);
		// No asynchronous gap between document approval, renderer detach and committing folder identity.
		if (this.ports.restoreEditor(session?.editor ?? null) === false) return false;
		if (closing) { this.state.folders = closing.paths; this.state.sessions.delete(closing.path); }
		if (previousSession) this.state.sessions.set(previous, previousSession);
		this.state.activeFolder = dir; this.state.folderEpoch++;
		this.ports.beforeChange(); this.ports.presentFolder(dir, session);
		const tree = this.ports.loadTree(dir);
		await this.ports.persistFolders(); if (!ticket.current()) return false;
		if (!dir) { this.ports.poll(false); await tree; return ticket.current(); }
		const worktrees = await this.ports.worktrees(dir); if (!ticket.current()) return false;
		this.ports.applyWorktrees(worktrees); await tree; if (!ticket.current()) return false;
		const query = this.ports.treeQuery();
		if (query) await this.ports.filterTree(query);
		if (!ticket.current()) return false;
		await this.ports.refreshGit(); if (!ticket.current()) return false;
		this.ports.watch(); await this.ports.showActive(); if (!ticket.current()) return false;
		this.ports.poll(true); return true;
	}
}
