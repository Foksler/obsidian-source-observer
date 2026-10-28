import type {Events} from 'obsidian';
import type {SourceObserverSettings} from '../app/index.ts';
import type {DocumentStore} from '../documents/index.ts';
import type {FileObservationRuntime} from '../files/index.ts';
import type {GitRepositoryStore} from '../git/index.ts';
import type {WorktreeDiscovery} from '../git/index.ts';
import type {SearchRuntime} from '../search/index.ts';
import type {CodeMirrorLanguageRuntime} from './CodeMirrorEndpoint.ts';
import type {ExplorerDock} from '../obsidian/index.ts';
import type {showFileContextMenu} from './fileContextMenu.ts';
/** Services required by a view. The plugin composition root satisfies this structurally. */
export interface PluginContext {
 settings:SourceObserverSettings;settingsEvents:Events;documents:DocumentStore;
 observations:FileObservationRuntime;repositories:GitRepositoryStore;worktrees:WorktreeDiscovery;
 search:SearchRuntime;languages:CodeMirrorLanguageRuntime;explorerDock:ExplorerDock;
 saveSettings():Promise<void>;persistDocumentRecovery():void;
 showFileMenu(...args:Parameters<typeof showFileContextMenu> extends [...infer A,unknown] ? A : never):void;
}
