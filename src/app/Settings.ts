import type {SearchMode} from './SearchPreferences.ts';
import type {SearchShortcuts} from './Shortcuts.ts';
import {DEFAULT_SHORTCUTS} from './Shortcuts.ts';
import {DEFAULT_EXCLUDED_FILES} from '../files/index.ts';

export type SyntaxTheme = 'obsidian' | 'cursor-monokai' | 'dark-plus' | 'one-dark';

/** Persisted plugin settings stored in `data.json`. */
export interface SourceObserverSettings {
	replaceFileExplorer: boolean;
	searchMode: SearchMode;
	shortcuts: SearchShortcuts;
	doubleShiftSearch: boolean;
	lastOpenedPath: string;
	openedFolderPaths: string[] | null;
	fontSize: number;
	sidebarFontSize: number;
	editorFontFamily: string;
	editorFontLigatures: boolean;
	showHidden: boolean;
	excludedFiles: string[];
	includeWorktrees: boolean;
	gitPanelHidden: boolean;
	syntaxTheme: SyntaxTheme;
	phpLsp: boolean;
	nodePath: string;
	intelephensePath: string;
	intelephenseLicence: string;
	goLsp: boolean;
	goPath: string;
	goplsPath: string;
}

export const DEFAULT_SETTINGS: SourceObserverSettings = {
	replaceFileExplorer: false,
	searchMode: 'vscode',
	shortcuts: DEFAULT_SHORTCUTS,
	doubleShiftSearch: true,
	lastOpenedPath: '',
	openedFolderPaths: null,
	fontSize: 15,
	sidebarFontSize: 12,
	editorFontFamily: 'JetBrains Mono',
	editorFontLigatures: true,
	showHidden: true,
	excludedFiles: DEFAULT_EXCLUDED_FILES,
	includeWorktrees: false,
	gitPanelHidden: false,
	syntaxTheme: 'cursor-monokai',
	phpLsp: true,
	nodePath: '',
	intelephensePath: '',
	intelephenseLicence: '',
	goLsp: false,
	goPath: '',
	goplsPath: '',
};
