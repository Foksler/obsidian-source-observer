import * as path from 'path';
import { promises as fs } from 'fs';
import { streamRipgrep } from './rgRunner.ts';
import { getRegisteredWorktrees, makeRgArgs, searchContentFallback, type SearchMatch, type SearchOptions } from './searchEngine.ts';
import { createRgParser } from './rgParser.ts';
import { searchPreview } from './searchPreview.ts';

export interface ContentSearchPage {
	matches: SearchMatch[];
	totalMatches: number;
	totalFiles: number;
}

/** Count every occurrence, keeping only the requested page of bounded previews. */
export async function searchContentPage(root: string, options: SearchOptions, signal: AbortSignal,
	limit = 1000, offset = 0, includeFile?: (filePath: string) => boolean): Promise<ContentSearchPage> {
	const page: ContentSearchPage = { matches: [], totalMatches: 0, totalFiles: 0 };
	if (!options.query) return page;
	await fs.access(root);
	const worktrees = await getRegisteredWorktrees(root);
	const seen = new Set<string>();
	const files = new Set<string>();
	const accept = (match: SearchMatch) => {
		if (includeFile && !includeFile(match.filePath)) return;
		if (!options.includeWorktrees && worktrees.some((tree) => match.filePath === tree || match.filePath.startsWith(`${tree}${path.sep}`))) return;
		// Both scans resolve into the selected root and never follow nested symlinks.
		const file = match.filePath;
		const key = `${file}:${match.line}:${match.column}`;
		if (seen.has(key)) return;
		seen.add(key);
		files.add(file);
		const index = page.totalMatches++;
		if (index >= offset && page.matches.length < limit) page.matches.push({ ...match, text: searchPreview(match.text, match.column) });
	};
	const parse = createRgParser(root);
	const consume = (line: string) => {
		const group = parse(line);
		if (group) for (const match of group.matches) accept(match);
	};
	try {
		await streamRipgrep(['--sort', 'path', ...makeRgArgs(root, options, worktrees)], signal, consume, '\n', root);
		if (options.includeWorktrees) {
			const visible = options.showHidden === false
				? worktrees.filter((tree) => !path.relative(root, tree).split(path.sep).some((part) => part.startsWith('.')))
				: worktrees;
			if (visible.length) await streamRipgrep(['--sort', 'path', ...makeRgArgs(root, options, [], true, visible)], signal, consume, '\n', root);
		}
	} catch (error) {
		if (signal.aborted || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		const groups = await searchContentFallback(root, { ...options, limit: Number.MAX_SAFE_INTEGER }, signal);
		for (const group of groups) for (const match of group.matches) accept(match);
	}
	page.totalFiles = files.size;
	return page;
}
