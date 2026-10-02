interface QueryTerm {
	value: string;
}

const BASENAME_STEM_EXACT = 10_000;
const MAX_MATCHED_PATH_LENGTH = 8_192;

function normalizePath(path: string): string[] {
	return path.slice(0, MAX_MATCHED_PATH_LENGTH).split(/[\\/]+/).filter(Boolean);
}

function queryTerms(query: string): QueryTerm[] {
	return query
		.toLowerCase()
		.split(/[\s\\/]+/)
		.filter(Boolean)
		.map((value) => ({ value }));
}

function extensionless(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

function isBoundary(source: string, index: number): boolean {
	if (index === 0) return true;
	const current = source[index] ?? '';
	const previous = source[index - 1] ?? '';
	return /[^a-zA-Z0-9]/.test(previous) || (/[a-z]/.test(previous) && /[A-Z]/.test(current));
}

function containsSubsequence(source: string, term: string): boolean {
	if (source.includes(term)) return true;
	let termIndex = 0;
	for (let index = 0; index < source.length && termIndex < term.length; index++) {
		if (source[index] === term[termIndex]) termIndex++;
	}
	return termIndex === term.length;
}

/** Returns a field match score; exact/substring filename matches outrank directory matches. */
function scoreField(source: string, term: string, field: 'stem' | 'name' | 'directory'): number {
	if (!source) return 0;
	const foldedSource = source.toLowerCase();
	const base = field === 'stem' ? 520 : field === 'name' ? 500 : 190;
	if (foldedSource === term) return base + 160;

	const index = foldedSource.indexOf(term);
	if (index >= 0) {
		const boundary = isBoundary(source, index) ? 100 : 0;
		const prefix = index === 0 ? 90 : 0;
		return base + 40 + boundary + prefix - Math.min(index, 80);
	}

	// Greedy subsequence matching handles terse camel-case searches such as DshbrdCtrlr.
	let termIndex = 0;
	let first = -1;
	let previous = -1;
	let gaps = 0;
	let boundaryHits = 0;
	for (let index = 0; index < source.length && termIndex < term.length; index++) {
		if (foldedSource[index] !== term[termIndex]) continue;
		if (first < 0) first = index;
		if (previous >= 0) gaps += index - previous - 1;
		if (isBoundary(source, index)) boundaryHits++;
		previous = index;
		termIndex++;
	}
	if (termIndex !== term.length) return 0;
	const density = Math.max(0, term.length * 3 - gaps);
	// Keep any meaningful filename subsequence above an exact directory-only hit.
	return (field === 'stem' ? 405 : field === 'name' ? 390 : 35)
		+ density + boundaryHits * 7 - Math.min(first, 30);
}

/** Precompiles a case-insensitive fuzzy matcher for indexed relative file paths. */
export function createFileMatcher(query: string): (relativePath: string) => number | null {
	const terms = queryTerms(query);
	if (terms.length === 0) return () => null;
	const joinedQuery = terms.map(({ value }) => value).join('');
	const exactStemBonus = joinedQuery.length > 0 ? BASENAME_STEM_EXACT : 0;

	return (relativePath: string): number | null => {
		const foldedPath = relativePath.slice(0, MAX_MATCHED_PATH_LENGTH).toLowerCase();
		// Most indexed paths fail here. This scan is cheaper than splitting paths and
		// scoring each basename/directory field, and cannot reject a field match.
		for (const { value: term } of terms) {
			if (!containsSubsequence(foldedPath, term)) return null;
		}

		const segments = normalizePath(relativePath);
		const basename = segments[segments.length - 1];
		if (!basename) return null;
		const stem = extensionless(basename);
		const directories = segments.slice(0, -1);

		let score = 0;
		for (const { value: term } of terms) {
			const basenameMatch = Math.max(
				scoreField(stem, term, 'stem'),
				scoreField(basename, term, 'name'),
			);
			let directoryMatch = 0;
			for (const directory of directories) {
				directoryMatch = Math.max(directoryMatch, scoreField(directory, term, 'directory'));
			}
			const best = Math.max(basenameMatch, directoryMatch);
			if (best === 0) return null;
			score += best;
		}

		if (stem.toLowerCase() === joinedQuery) score += exactStemBonus;
		return score;
	};
}
