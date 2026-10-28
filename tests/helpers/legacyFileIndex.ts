import {createFilePathIndex} from '../../src/search/filePathIndex.ts';
export * from '../../src/search/filePathIndex.ts';
const standalone=createFilePathIndex();
export const {searchFilePathIndex,warmFileIndex,invalidateFilePathIndex,invalidateFileIndex,clearFilePathIndexes,getFilePathIndexStats}=standalone;
