// Public interface: cross-module consumers import only these contracts.
export {DocumentSession} from './DocumentSession.ts';
export type {ConflictDecision, DocumentIO, DocumentRecovery, SaveOutcome} from './DocumentSession.ts';
export {DocumentStore} from './DocumentStore.ts';
