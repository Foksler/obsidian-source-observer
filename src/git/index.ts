// Public interface: cross-module consumers import only these contracts.
export {GitRepositoryStore} from './GitRepositoryStore.ts';
export type {ChangedFile, RepositoryContext, RepositoryReader} from './GitRepositoryStore.ts';
export {WorktreeDiscovery, clearWorktreeCaches, findLanguageWorktrees, getRegisteredWorktrees} from './WorktreeDiscovery.ts';
export {getFileDiff} from './gitDiff.ts';
export {getTreeGitStatuses} from './treeGitStatus.ts';
export type {TreeGitStatus} from './treeGitStatus.ts';
