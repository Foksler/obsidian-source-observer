import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isPhpFile } from './phpFiles';
import type { LspAdapter } from './lspAdapter';
import { createIntelephenseSettings, findWorkspaceComposerRoots } from './lspWorkspaceRoots';

function firstExisting(candidates: string[]): string {
	return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? '';
}

/** Finds a `node` binary; Obsidian's own Electron refuses ELECTRON_RUN_AS_NODE. */
export function detectNode(): string {
	const home = os.homedir();
	return firstExisting([
		path.join(home, '.local/bin/node'), '/opt/homebrew/bin/node',
		'/usr/local/bin/node', '/usr/bin/node',
	]);
}

/** Finds the newest Intelephense server bundled with Cursor or VS Code. */
export function detectIntelephense(): string {
	const home = os.homedir();
	for (const editorDir of ['.cursor/extensions', '.vscode/extensions']) {
		let entries: string[];
		try { entries = fs.readdirSync(path.join(home, editorDir)); } catch { continue; }
		const ext = entries.filter((entry) => entry.startsWith('bmewburn.vscode-intelephense-client-'))
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
		if (!ext) continue;
		const server = path.join(home, editorDir, ext, 'node_modules/intelephense/lib/intelephense.js');
		if (fs.existsSync(server)) return server;
	}
	return '';
}

/**
 * Nearest Composer folder above a file. Files in vendor belong to the project
 * owning that vendor tree, rather than a package's own composer.json.
 */
export function findComposerRoot(filePath: string): string | null {
	const parts = path.dirname(path.resolve(filePath)).split(path.sep);
	const vendorAt = parts.indexOf('vendor');
	let dir = vendorAt > 0 ? parts.slice(0, vendorAt).join(path.sep) : parts.join(path.sep);
	if (!dir) dir = path.parse(path.resolve(filePath)).root;
	for (;;) {
		if (fs.existsSync(path.join(dir, 'composer.json'))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function phpAdapter(nodePath: string, serverPath: string, licenceKey: string): LspAdapter {
	return {
		id: 'php', name: 'PHP', serverName: 'Intelephense', configurationSection: 'intelephense',
		languageId: (file) => isPhpFile(file) ? 'php' : null,
		projectRoot: findComposerRoot,
		workspaceRoots: findWorkspaceComposerRoots,
		command: () => nodePath && serverPath ? { executable: nodePath, args: [serverPath, '--stdio'] } : null,
		missingMessage: 'PHP navigation needs Node.js and Intelephense; set their paths in settings.',
		initializationOptions(root) {
			const cache = path.join(os.homedir(), '.cache', 'source-observer-intelephense');
			const storage = path.join(cache, createHash('sha256').update(root).digest('hex'));
			return { storagePath: path.join(storage, 'workspace'), globalStoragePath: path.join(storage, 'global'),
				...(licenceKey ? { licenceKey } : {}) };
		},
		settings: createIntelephenseSettings,
		indexingNotifications: { start: 'indexingStarted', end: 'indexingEnded' },
	};
}
