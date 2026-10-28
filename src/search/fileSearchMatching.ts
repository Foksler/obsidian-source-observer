const BASENAME_STEM_EXACT = 10_000;
const MAX_MATCHED_PATH_LENGTH = 8_192;

function normalizePath(path: string): string[] {
	return path.slice(0, MAX_MATCHED_PATH_LENGTH).split(/[\\/]+/).filter(Boolean);
}

function queryTerms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[\s\\/]+/)
		.filter(Boolean);
}

function extensionless(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

function isBoundary(source: string, index: number): boolean {
	if (index === 0) return true;
	const current = source.charCodeAt(index);
	const previous = source.charCodeAt(index - 1);
	const lower = previous >= 97 && previous <= 122;
	return !(lower || (previous >= 65 && previous <= 90) || (previous >= 48 && previous <= 57))
		|| (lower && current >= 65 && current <= 90);
}

function containsSubsequence(source: string, term: string): boolean {
	if (source.includes(term)) return true;
	let position = -1;
	for (let index = 0; index < term.length; index++) {
		position = source.indexOf(term[index]!, position + 1);
		if (position < 0) return false;
	}
	return true;
}

/** Returns a field match score; exact/substring filename matches outrank directory matches. */
function scoreField(source: string, foldedSource: string, term: string, field: 'stem' | 'name' | 'directory'): number {
	if (!source) return 0;
	const base = field === 'stem' ? 520 : field === 'name' ? 500 : 190;
	if (foldedSource === term) return base + 160;

	const index = foldedSource.indexOf(term);
	if (index >= 0) {
		const boundary = isBoundary(source, index) ? 100 : 0;
		const prefix = index === 0 ? 90 : 0;
		return base + 40 + boundary + prefix - Math.min(index, 80);
	}

	// Greedy subsequence matching handles terse camel-case searches such as DshbrdCtrlr.
	let first = -1;
	let previous = -1;
	let gaps = 0;
	let boundaryHits = 0;
	for (let termIndex = 0; termIndex < term.length; termIndex++) {
		const index = foldedSource.indexOf(term[termIndex]!, previous + 1);
		if (index < 0) return 0;
		if (first < 0) first = index;
		if (previous >= 0) gaps += index - previous - 1;
		if (isBoundary(source, index)) boundaryHits++;
		previous = index;
	}
	const density = Math.max(0, term.length * 3 - gaps);
	// Keep any meaningful filename subsequence above an exact directory-only hit.
	return (field === 'stem' ? 405 : field === 'name' ? 390 : 35)
		+ density + boundaryHits * 7 - Math.min(first, 30);
}

/** Precompiles a case-insensitive fuzzy matcher for indexed relative file paths. */
export function createFileMatcher(query: string): (relativePath: string, foldedPath?: string) => number | null {
	const terms = queryTerms(query);
	if (terms.length === 0) return () => null;
	const joinedQuery = terms.join('');

	return (relativePath: string, folded?: string): number | null => {
		const foldedPath = relativePath.length > MAX_MATCHED_PATH_LENGTH
			? relativePath.slice(0, MAX_MATCHED_PATH_LENGTH).toLowerCase()
			: folded ?? relativePath.toLowerCase();
		// Most indexed paths fail here. This scan is cheaper than splitting paths and
		// scoring each basename/directory field, and cannot reject a field match.
		for (const term of terms) {
			if (!containsSubsequence(foldedPath, term)) return null;
		}

		const segments = normalizePath(relativePath);
		const basename = segments[segments.length - 1];
		if (!basename) return null;
		const stem = extensionless(basename);
		const foldedName = basename.toLowerCase();
		const foldedStem = stem.toLowerCase();
		const directories = segments.slice(0, -1);

		let score = 0;
		for (const term of terms) {
			const basenameMatch = Math.max(
				scoreField(stem, foldedStem, term, 'stem'),
				scoreField(basename, foldedName, term, 'name'),
			);
			let directoryMatch = 0;
			// Directory scores cannot exceed 420; avoid rescoring them after a stronger filename hit.
			if (basenameMatch < 420) for (const directory of directories) {
				directoryMatch = Math.max(directoryMatch, scoreField(directory, directory.toLowerCase(), term, 'directory'));
			}
			const best = Math.max(basenameMatch, directoryMatch);
			if (best === 0) return null;
			score += best;
		}

		if (foldedStem === joinedQuery) score += BASENAME_STEM_EXACT;
		return score;
	};
}
