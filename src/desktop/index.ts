// Public interface: cross-module consumers import only these contracts.
export {DesktopActions} from './DesktopActions.ts';
export type {DesktopAction, ElectronFileActions} from './DesktopActions.ts';
export {LanguageConnection} from './LanguageConnection.ts';
export {detectGo, detectGopls, goAdapter} from './goAdapter.ts';
export {detectIntelephense, detectNode, phpAdapter} from './phpAdapter.ts';
