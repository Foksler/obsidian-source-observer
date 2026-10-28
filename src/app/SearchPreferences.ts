export type SearchMode = 'vscode' | 'phpstorm';

export function normalizeSearchMode(value: unknown): SearchMode {
	return value === 'phpstorm' ? 'phpstorm' : 'vscode';
}
