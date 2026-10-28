// Public interface: cross-module consumers import only these contracts.
export {FileObservation, FileObservationRuntime} from './FileObservation.ts';
export {CreateEntryError, createEntry, trashEntry} from './FileOperations.ts';
export type {NewEntryKind} from './FileOperations.ts';
export {CONVENTIONAL_WORKTREE_PATHS, FILE_POLICY_PROFILES, FileScope, GO_INDEX_EXCLUDED_DIRECTORIES, pathIdentity} from './FileScope.ts';
export {DEFAULT_EXCLUDED_FILES, activeExclusionPolicy, createExclusionPolicy, isExcludedFile, normalizeExcludedFiles, setExcludedFiles} from './fileExclusions.ts';
export type {ExclusionPolicy} from './fileExclusions.ts';
export {collectFilePaths, inventoryFilePaths} from './fileInventory.ts';
export {isPhpFile} from './phpFiles.ts';
export {runRipgrep, streamRipgrep} from './rgRunner.ts';
export {globToRegExp, splitGlobs} from './searchGlobs.ts';
export {containsFile, searchRoots} from './searchRoots.ts';
export {lineBreakFor, readDocumentText, sourceDocumentIO} from './sourceFile.ts';
export type {SourceText} from './sourceFile.ts';
