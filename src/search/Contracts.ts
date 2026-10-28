export interface SearchOptions {
	query: string;
	caseSensitive?: boolean;
	wholeWord?: boolean;
	regex?: boolean;
	includeGlob?: string;
	excludeGlob?: string;
	includeWorktrees?: boolean;
	showHidden?: boolean;
	limit?: number;
}

export interface SearchMatch {
	filePath: string;
	line: number;
	column: number;
	text: string;
}

export interface SearchResultGroup {
	filePath: string;
	matches: SearchMatch[];
}

export type SearchResultSet = SearchResultGroup[] & { truncated: boolean; totalKind: 'exact' | 'unknown' };
