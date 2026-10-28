import type { WorkspaceSession } from '../workspace/index.ts';

export interface TransitionTicket {
	generation: number;
	current(): boolean;
	prepare(leave: () => Promise<boolean>): Promise<boolean>;
}

/** Coordinates intent cancellation and document approval without copying feature state. */
export class WorkspaceTransitions {
	private workspace: WorkspaceSession;
	private closed: () => boolean;
	constructor(workspace: WorkspaceSession, closed: () => boolean) { this.workspace = workspace; this.closed = closed; }
	private begin(kind: 'folderGeneration' | 'contentGeneration'): TransitionTicket {
		const generation = ++this.workspace[kind];
		const current = () => !this.closed() && this.workspace[kind] === generation;
		return { generation, current, prepare: async leave => (await leave()) && current() };
	}
	folder() { return this.begin('folderGeneration'); }
	content() { return this.begin('contentGeneration'); }
}
