import type {LspAdapter} from './lspAdapter.ts';
import type {ManagedServer} from './ServerRegistry.ts';
export interface MessageTransport {
 send(message:string):void;
 subscribe(handler:(message:string)=>void):void;
 unsubscribe(handler:(message:string)=>void):void;
}
export interface ProtocolEndpoint {
 connect(transport:MessageTransport):Promise<void>;
 disposeWorkspace():void;
 disconnect():void;
}
export interface LanguageConnectionSpec {root:string;adapter:LspAdapter;includeWorktrees:boolean}
export interface ConnectionEvents {indexing(active:boolean):void;failed(error:Error):void;message?(message:string,type:number):void}
export type ConnectionFactory<T extends ManagedServer>=(spec:LanguageConnectionSpec,events:ConnectionEvents)=>T;
