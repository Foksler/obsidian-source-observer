import * as path from 'path';

export interface FolderWorkspace {
	paths: string[];
	activePath: string;
}

function normalizedPath(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	return path.resolve(value);
}

function uniquePaths(values: unknown[]): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const value of values) {
		const normalized = normalizedPath(value);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		paths.push(normalized);
	}
	return paths;
}

/** Normalize persisted folder tabs, migrating older settings that only saved lastOpenedPath. */
export function normalizeFolderWorkspace(input: unknown, lastOpenedPath: string): FolderWorkspace {
	let savedPaths: unknown[] | null = null;
	if (Array.isArray(input)) {
		savedPaths = input;
	} else if (input && typeof input === 'object' && 'openedFolderPaths' in input) {
		const stored = (input as { openedFolderPaths?: unknown }).openedFolderPaths;
		if (Array.isArray(stored)) savedPaths = stored;
	}

	const legacyPath = normalizedPath(lastOpenedPath);
	const paths = savedPaths === null
		? (legacyPath ? [legacyPath] : [])
		: uniquePaths(savedPaths);
	const activePath = legacyPath && paths.includes(legacyPath) ? legacyPath : (paths[0] ?? '');
	return { paths, activePath };
}

/** Remove one folder tab and choose its right-hand neighbor, or the previous last tab. */
export function closeFolderWorkspace(
	paths: string[],
	activePath: string,
	closedPath: string,
): FolderWorkspace {
	const normalizedPaths = uniquePaths(paths);
	const normalizedActive = normalizedPath(activePath) ?? '';
	const normalizedClosed = normalizedPath(closedPath);
	if (!normalizedClosed) {
		return {
			paths: normalizedPaths,
			activePath: normalizedPaths.includes(normalizedActive) ? normalizedActive : (normalizedPaths[0] ?? ''),
		};
	}

	const closedIndex = normalizedPaths.indexOf(normalizedClosed);
	if (closedIndex < 0) {
		return {
			paths: normalizedPaths,
			activePath: normalizedPaths.includes(normalizedActive) ? normalizedActive : (normalizedPaths[0] ?? ''),
		};
	}

	const remaining = normalizedPaths.filter((folderPath) => folderPath !== normalizedClosed);
	if (normalizedActive !== normalizedClosed && remaining.includes(normalizedActive)) {
		return { paths: remaining, activePath: normalizedActive };
	}
	const next = remaining[Math.min(closedIndex, remaining.length - 1)] ?? '';
	return { paths: remaining, activePath: next };
}
