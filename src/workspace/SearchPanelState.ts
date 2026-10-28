export interface SearchPanelState {
	query: string;
	mode: 'content' | 'files';
	caseSensitive: boolean;
	wholeWord: boolean;
	regex: boolean;
	includeGlob: string;
	excludeGlob: string;
}
