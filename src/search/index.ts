// Public interface: cross-module consumers import only these contracts.
export type {SearchMatch, SearchOptions, SearchResultSet} from './Contracts.ts';
export {SearchRuntime} from './SearchRuntime.ts';
export {FILE_SEARCH_RESULTS_CAP} from './filePathIndex.ts';
export {findModules, initialFindState, moduleForPath, searchFindInFiles} from './findInFilesScope.ts';
export type {FindArea, FindInFilesContext, FindInFilesState, NamedFindScope} from './findInFilesScope.ts';
export {SEARCH_TABS, SEARCH_TAB_LABELS, searchEverywhere} from './searchEverywhere.ts';
export type {EverywhereBatch, EverywhereContext, EverywhereResult, SearchAction, SearchTab} from './searchEverywhere.ts';
export {searchPreview} from './searchPreview.ts';
