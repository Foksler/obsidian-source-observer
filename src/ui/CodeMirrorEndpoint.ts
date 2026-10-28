import {LSPClient} from '@codemirror/lsp-client';
import {pathToFileURL} from 'url';
import {ViewerWorkspace} from './lspWorkspace.ts';
import type {LanguageRuntime} from '../language/index.ts';
import type {ManagedServer} from '../language/index.ts';
import type {ProtocolEndpoint,LanguageConnectionSpec,ConnectionEvents} from '../language/index.ts';
export interface CodeMirrorEndpoint extends ProtocolEndpoint {readonly client:LSPClient;readonly workspace:ViewerWorkspace}
export interface CodeMirrorLanguageResource extends ManagedServer {readonly endpoint:CodeMirrorEndpoint}
export type CodeMirrorLanguageRuntime=LanguageRuntime<CodeMirrorLanguageResource>;
export function createCodeMirrorEndpoint(spec:LanguageConnectionSpec,events:ConnectionEvents,readDocument:(uri:string)=>Promise<string>):CodeMirrorEndpoint {
 const adapter=spec.adapter;
 const client=new LSPClient({rootUri:pathToFileURL(spec.root).href,timeout:20000,initializationOptions:adapter.initializationOptions?.(spec.root),
  workspace:current=>new ViewerWorkspace(current,async()=>null,adapter.languageId,readDocument),
  notificationHandlers:{
   [adapter.indexingNotifications?.start??'$/sourceObserver/unusedStart']:()=>{events.indexing(true);return true;},
   [adapter.indexingNotifications?.end??'$/sourceObserver/unusedEnd']:()=>{events.indexing(false);return true;},
  },extensions:[{clientCapabilities:{workspace:{configuration:true}}}],
 });
 const workspace=client.workspace as ViewerWorkspace;void client.initializing.catch(()=>{});
 return {client,workspace,connect(transport){client.connect(transport);return client.initializing.then(()=>{});},disposeWorkspace(){workspace.dispose();},disconnect(){client.disconnect();}};
}
