import * as path from 'path';
import { realpathSync } from 'fs';

function canonical(root: string): string {
	try { return realpathSync(root); } catch { return path.resolve(root); }
}

export function containsFile(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Overlapping folders and symlink aliases must not duplicate occurrences. */
export function searchRoots(roots: string[]): string[] {
	const unique = new Map<string, string>();
	for (const root of roots) if (root) unique.set(canonical(root), path.resolve(root));
	return [...unique].filter(([root]) => ![...unique.keys()].some((parent) => parent !== root && containsFile(parent, root)))
		.map(([, root]) => root);
}
