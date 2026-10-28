// Test-only adapter for historical harness field names; production uses owned sessions.
import {SourceObserverView} from '../../src/ui/view.ts';
export * from '../../src/ui/view.ts';
const aliases={"repoPath": "workspaceSession.activeFolder", "previewFiles": "workspaceSession.previews", "recentFiles": "workspaceSession.recents", "folderPaths": "workspaceSession.folders", "folderSessions": "workspaceSession.sessions", "folderRequestId": "workspaceSession.folderGeneration", "diffRequestId": "workspaceSession.contentGeneration"};
for(const [key,value] of Object.entries(aliases))Object.defineProperty(SourceObserverView.prototype,key,{configurable:true,get(){const [owner,field]=value.split('.');return (this as unknown as Record<string,Record<string,unknown>>)[owner!]![field!];},set(value:unknown){const [owner,field]=aliases[key as keyof typeof aliases].split('.');(this as unknown as Record<string,Record<string,unknown>>)[owner!]![field!]=value;}});
Object.defineProperty(SourceObserverView.prototype,'watchers',{get(){return (this as unknown as {observation?:{watchers:unknown[]}}).observation?.watchers??[];}});
