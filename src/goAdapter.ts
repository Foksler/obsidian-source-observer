import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LspAdapter } from './lspAdapter';
import { findRegisteredWorktrees, findWorkspaceProjectRoots } from './lspWorkspaceRoots';

function detectExecutable(name: string, candidates: string[]): string {
	const onPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
		.map((directory) => path.join(directory, process.platform === 'win32' ? `${name}.exe` : name));
	return [...onPath, ...candidates].find((candidate) => existsSync(candidate)) ?? '';
}

export function detectGo(): string {
	return detectExecutable('go', ['/opt/homebrew/bin/go', '/usr/local/bin/go', '/usr/local/go/bin/go']);
}

export function detectGopls(): string {
	return detectExecutable('gopls', [path.join(os.homedir(), 'go/bin/gopls'),
		path.join(os.homedir(), '.local/bin/gopls'), '/opt/homebrew/bin/gopls', '/usr/local/bin/gopls']);
}

export function goLanguageId(file: string): string | null {
	const name = path.basename(file);
	if (name === 'go.mod') return 'gomod';
	if (name === 'go.work') return 'gowork';
	if (name === 'go.sum' || name === 'go.work.sum') return 'gosum';
	return path.extname(file).toLowerCase() === '.go' ? 'go' : null;
}

/** Prefer a containing Go workspace over its individual module. */
export function findGoRoot(file: string): string | null {
	let directory = path.dirname(path.resolve(file));
	let module: string | null = null;
	for (;;) {
		if (existsSync(path.join(directory, 'go.work'))) return directory;
		if (!module && existsSync(path.join(directory, 'go.mod'))) module = directory;
		const parent = path.dirname(directory);
		if (parent === directory) return module;
		directory = parent;
	}
}

export async function createGoplsSettings(root: string, includeWorktrees = false) {
	const directoryFilters = ['-**/.git', '-**/node_modules', '-**/.beads'];
	if (!includeWorktrees) {
		directoryFilters.push('-**/.worktrees', '-**/worktrees');
		for (const worktree of await findRegisteredWorktrees(root)) {
			const relative = path.relative(root, worktree).split(path.sep).join('/');
			if (relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)) {
				directoryFilters.push(`-${relative}`);
			}
		}
	}
	return { directoryFilters };
}

export function goAdapter(goPath: string, goplsPath: string): LspAdapter {
	return {
		id: 'go', name: 'Go', serverName: 'gopls', configurationSection: 'gopls',
		languageId: goLanguageId, projectRoot: findGoRoot,
		externalFilesUseActiveRoot: true,
		workspaceRoots: (root, includeWorktrees) => findWorkspaceProjectRoots(root, ['go.work', 'go.mod'], includeWorktrees),
		command: () => goPath && goplsPath ? {
			executable: goplsPath, args: ['serve'],
			env: { ...process.env, PATH: `${path.dirname(goPath)}${path.delimiter}${process.env.PATH ?? ''}` },
		} : null,
		missingMessage: 'Go navigation needs Go and gopls; install them and set their paths in settings.',
		settings: createGoplsSettings,
	};
}
