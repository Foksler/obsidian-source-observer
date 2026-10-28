// Public interface: cross-module consumers import only these contracts.
export {createCodeMirrorEndpoint} from './CodeMirrorEndpoint.ts';
export {showFileContextMenu} from './fileContextMenu.ts';
export type {FileMenuOptions} from './fileContextMenu.ts';
export {SourceObserverView, VIEW_TYPE} from './view.ts';
