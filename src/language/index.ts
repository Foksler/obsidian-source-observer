// Public interface: cross-module consumers import only these contracts.
export type {ConnectionEvents, LanguageConnectionSpec, MessageTransport, ProtocolEndpoint} from './Connection.ts';
export {LanguageRuntime} from './LanguageRuntime.ts';
export type {LanguageEvent} from './LanguageRuntime.ts';
export {createIntelephenseSettings, findWorkspaceComposerRoots, findWorkspaceProjectRoots} from './ProjectDiscovery.ts';
export type {ManagedServer, ServerLease} from './ServerRegistry.ts';
export {toLspSymbols} from './Symbols.ts';
export type {DocumentSymbol, LspLocation, LspSymbol, Position, Range, SymbolInformation} from './Symbols.ts';
export type {LspAdapter} from './lspAdapter.ts';
