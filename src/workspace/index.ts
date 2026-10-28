// Public interface: cross-module consumers import only these contracts.
export {NavigationSession} from './NavigationSession.ts';
export type {CodePaneSession, CodePaneSessionLocation} from './NavigationSession.ts';
export type {SearchPanelState} from './SearchPanelState.ts';
export {TabSession} from './TabSession.ts';
export type {EditorTabsState, SourceTab, TabCloseScope} from './TabSession.ts';
export {WorkspaceSession} from './WorkspaceSession.ts';
export type {FolderSession} from './WorkspaceSession.ts';
export {closeFolderWorkspace, normalizeFolderWorkspace} from './folderWorkspace.ts';
