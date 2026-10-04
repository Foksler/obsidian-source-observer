import * as path from 'path';
import { promises as fs } from 'fs';
import { containsFile } from './searchRoots.ts';
import { findWorkspaceComposerRoots } from './lspWorkspaceRoots.ts';
import { getRegisteredWorktrees, type SearchOptions } from './searchEngine.ts';
import { searchContentPage, type ContentSearchPage } from './contentSearchPage.ts';

export type FindArea = 'project' | 'module' | 'directory' | 'scope';
export type NamedFindScope = 'project' | 'open' | 'current' | 'custom';
export interface FindInFilesState {
	query: string;
	area: FindArea;
	directory: string;
	module: string;
	namedScope: NamedFindScope;
	fileMask: string;
	maskEnabled: boolean;
	recursive: boolean;
	options: Omit<SearchOptions, 'query'>;
}
export interface FindInFilesContext {
	root: string;
	selectedPath?: { path: string; isDirectory: boolean } | null;
	treeFocused: boolean;
	openFiles: string[];
	currentFile: string | null;
	showHidden: boolean;
	includeWorktrees: boolean;
}

export function initialFindState(context: FindInFilesContext, saved?: FindInFilesState): FindInFilesState {
	const selected = context.selectedPath;
	const directory = selected ? selected.isDirectory ? selected.path : path.dirname(selected.path)
		: context.currentFile ? path.dirname(context.currentFile) : context.root;
	return { query: '', module: context.root, namedScope: 'project', fileMask: '*.php',
		maskEnabled: false, recursive: true, ...saved,
		directory, area: context.treeFocused && selected ? 'directory' : saved?.area ?? 'project',
		options: { ...saved?.options, showHidden: context.showHidden, includeWorktrees: context.includeWorktrees } };
}

export async function findModules(context: FindInFilesContext): Promise<string[]> {
	const composer = await findWorkspaceComposerRoots(context.root, context.includeWorktrees);
	return composer.length ? composer : [context.root];
}

export function moduleForPath(modules: string[], selected: string): string {
	return [...modules].sort((a, b) => b.length - a.length).find((root) => containsFile(root, selected)) ?? modules[0] ?? '';
}

/** Mask names are matched independently from scope globs, so the filters intersect. */
function matchesMask(file: string, mask: string): boolean {
	return mask.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean).some((part) => {
		const source = part.split('').map((char) => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
		return new RegExp(`^${source}$`, 'i').test(path.basename(file));
	});
}

export async function searchFindInFiles(context: FindInFilesContext, state: FindInFilesState, signal: AbortSignal,
	limit = 200): Promise<ContentSearchPage> {
	const selectedRoot = state.area === 'directory' ? path.resolve(context.root, state.directory)
		: state.area === 'module' ? state.module : context.root;
	const root = await fs.realpath(selectedRoot);
	const activeRoot = await fs.realpath(context.root);
	if (!containsFile(activeRoot, root) || !(await fs.stat(root)).isDirectory()) throw new Error('Choose a directory inside the active folder.');
	if (!state.options.includeWorktrees && (await getRegisteredWorktrees(activeRoot)).some((tree) => containsFile(tree, root))) {
		throw new Error('Enable include worktrees to search this directory.');
	}
	const options = { ...state.options, query: state.query };
	if (state.area === 'scope' && state.namedScope !== 'custom') { options.includeGlob = ''; options.excludeGlob = ''; }
	const openFiles = new Set(await Promise.all(context.openFiles.map((file) => fs.realpath(file).catch(() => file))));
	const current = context.currentFile ? await fs.realpath(context.currentFile).catch(() => context.currentFile) : null;
	return searchContentPage(root, options, signal, limit, 0, (file) => {
		if (state.area === 'directory' && !state.recursive && path.dirname(file) !== root) return false;
		if (state.maskEnabled && !matchesMask(file, state.fileMask)) return false;
		if (state.area !== 'scope') return true;
		return state.namedScope === 'open' ? openFiles.has(file) : state.namedScope === 'current' ? file === current : true;
	});
}
