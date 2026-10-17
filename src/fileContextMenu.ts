import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { promisify } from 'util';
import { Menu, Notice, Platform } from 'obsidian';

const execFileAsync = promisify(execFile);
type FileAction = 'copy' | 'copy-relative' | 'reveal' | 'terminal' | 'browser' | 'delete' | 'delete-folder';
interface ElectronFileActions {
	clipboard: { writeText(text: string): void };
	shell: { showItemInFolder(fullPath: string): void; trashItem(fullPath: string): Promise<void>; openExternal(url: string): Promise<void> };
}

const HTML_FILE = /\.html?$/i;
// The http handler, not the .html one: .html is often bound to an editor.
const DEFAULT_BROWSER_SCRIPT = "ObjC.import('AppKit'); const app = $.NSWorkspace.sharedWorkspace"
	+ ".URLForApplicationToOpenURL($.NSURL.URLWithString('https://example.com')); app.isNil() ? '' : app.path.js";

async function defaultBrowser(): Promise<string> {
	try {
		const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', DEFAULT_BROWSER_SCRIPT]);
		return stdout.trim();
	} catch { return ''; }
}

function isInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export type NewEntryKind = 'file' | 'folder';

/** A refusal the user can fix by changing the name; its message is shown as is. */
export class CreateEntryError extends Error {}

/** Creates an empty file or folder; `name` may hold subfolders, which are created too. Never overwrites. */
export async function createEntry(kind: NewEntryKind, parentDir: string, name: string, rootPath: string): Promise<string> {
	const root = path.resolve(rootPath), parent = path.resolve(parentDir);
	if (parent !== root && !isInside(root, parent)) throw new Error('Folder is outside the project root.');
	const trimmed = name.trim();
	if (path.isAbsolute(trimmed)) throw new CreateEntryError('Enter a name relative to this folder.');
	const parts = trimmed.split(/[/\\]/).filter(Boolean);
	if (parts.length === 0) throw new CreateEntryError('Enter a name.');
	if (parts.some((part) => part === '.' || part === '..')) throw new CreateEntryError('A name cannot contain "." or ".." folders.');
	const target = path.join(parent, ...parts);
	try { await fsp.mkdir(path.dirname(target), { recursive: true }); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'EEXIST' || code === 'ENOTDIR') throw new CreateEntryError(`Cannot create folder "${parts.slice(0, -1).join('/')}": a file is in the way.`);
		throw error;
	}
	try {
		// Exclusive creation: an existing path, even one created after the menu opened, is left untouched.
		if (kind === 'folder') await fsp.mkdir(target);
		else await fsp.writeFile(target, '', { flag: 'wx' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CreateEntryError(`"${parts.join('/')}" already exists.`);
		throw error;
	}
	return target;
}

/** Keep filesystem paths as arguments, never as executable shell text. */
export async function runFileAction(action: FileAction, filePath: string, rootPath?: string): Promise<void> {
	const fullPath = path.resolve(filePath);
	if (action === 'delete' || action === 'delete-folder') {
		if (!rootPath || !isInside(path.resolve(rootPath), fullPath)) throw new Error('Path is outside the project root.');
		const info = await fsp.lstat(fullPath);
		// A stale menu must not trash a folder that replaced a file, or the reverse.
		if (action === 'delete' && !info.isFile() && !info.isSymbolicLink()) throw new Error('Only files can be deleted.');
		if (action === 'delete-folder' && !info.isDirectory()) throw new Error('Only folders can be deleted.');
		// Resolve the parent, not the final symlink: trash the link itself, never its target.
		const [root, parent] = await Promise.all([fsp.realpath(rootPath), fsp.realpath(path.dirname(fullPath))]);
		if (parent !== root && !isInside(root, parent)) throw new Error('File parent is outside the project root.');
		const { shell } = window.require('electron') as ElectronFileActions;
		await shell.trashItem(fullPath);
		return;
	}
	if (action === 'copy' || action === 'copy-relative') {
		if (action === 'copy-relative' && !rootPath) throw new Error('No project root is available.');
		const { clipboard } = window.require('electron') as ElectronFileActions;
		clipboard.writeText(action === 'copy-relative' ? path.relative(rootPath!, fullPath) || '.' : fullPath);
		return;
	}
	if (action === 'reveal') {
		await fsp.access(fullPath);
		const { shell } = window.require('electron') as ElectronFileActions;
		shell.showItemInFolder(fullPath);
		return;
	}
	if (action === 'browser') {
		await fsp.access(fullPath);
		const browser = Platform.isMacOS ? await defaultBrowser() : '';
		if (browser) { await execFileAsync('/usr/bin/open', ['-a', browser, fullPath]); return; }
		const { shell } = window.require('electron') as ElectronFileActions;
		await shell.openExternal(pathToFileURL(fullPath).href);
		return;
	}
	if (!Platform.isMacOS) throw new Error('Opening a terminal is supported on macOS.');
	// stat follows symlinks: a link to a directory opens that directory, too.
	const directory = (await fsp.stat(fullPath)).isDirectory() ? fullPath : path.dirname(fullPath);
	await execFileAsync('/usr/bin/open', ['-a', 'Terminal', directory]);
}

export interface FileMenuOptions {
	/** Runs after the path was moved to trash; folders pass the folder path. */
	onDeleted?: (deletedPath: string, rootPath: string) => Promise<void>;
	/** Items placed above the file actions, such as tab closing. */
	addLeadingItems?: (menu: Menu) => void;
	/** Asked before a folder is moved to trash; deletion proceeds only on true. */
	confirmFolderDelete?: (folderPath: string) => Promise<boolean>;
	/**
	 * Asks for a new entry's name and passes it to `submit`, which returns an error to show or null once created.
	 * Resolves true after a successful submit. Without it the menu offers no New file and New folder.
	 */
	promptNewName?: (kind: NewEntryKind, parentDir: string, submit: (name: string) => Promise<string | null>) => Promise<boolean>;
	/** Runs after a file or folder was created. */
	onCreated?: (createdPath: string, kind: NewEntryKind, rootPath: string) => Promise<void>;
}

/** Native Obsidian menu, shared by tree rows, filtered results and source tabs. */
export function showFileContextMenu(
	selection: { path: string; isDirectory: boolean; isSymlink?: boolean; linkTarget?: string },
	event: MouseEvent | KeyboardEvent,
	row: HTMLElement,
	rootPath: string,
	options: FileMenuOptions = {},
) {
	const menu = new Menu();
	if (options.addLeadingItems) {
		options.addLeadingItems(menu);
		menu.addSeparator();
	}
	const promptNewName = options.promptNewName;
	if (promptNewName) {
		// A folder row creates inside itself, a file row next to itself.
		const parentDir = selection.isDirectory ? selection.path : path.dirname(selection.path);
		for (const [title, icon, kind] of [['New file…', 'file-plus', 'file'], ['New folder…', 'folder-plus', 'folder']] as const) {
			menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(async () => {
				let created = '';
				const submitted = await promptNewName(kind, parentDir, async (name) => {
					try { created = await createEntry(kind, parentDir, name, rootPath); return null; }
					catch (error) { return error instanceof CreateEntryError ? error.message : `Could not create this ${kind}.`; }
				});
				if (!submitted) return;
				try { await options.onCreated?.(created, kind, rootPath); }
				catch { new Notice(`${kind === 'file' ? 'File' : 'Folder'} created, but the view could not refresh.`); }
			}));
		}
		menu.addSeparator();
	}
	const addAction = (title: string, icon: string, action: FileAction, failure: string, disabled = false, actionPath?: string) => {
		menu.addItem((item) => item.setTitle(title).setIcon(icon).setDisabled(disabled).onClick(async () => {
			try {
				await runFileAction(action, actionPath ?? selection.path, rootPath);
				if (action === 'copy' || action === 'copy-relative') new Notice('Path copied.');
			} catch { new Notice(failure); }
		}));
	};
	addAction('Copy path', 'copy', 'copy', 'Could not copy the path.');
	addAction('Copy relative path', 'copy', 'copy-relative', 'Could not copy the relative path.');
	const explorer = Platform.isMacOS ? 'Finder' : 'file explorer';
	addAction(`Reveal in ${explorer}`, 'folder-open', 'reveal', 'Could not reveal this path. It may have moved or been deleted.');
	// Reveal in Finder shows the link itself; this shows where it points.
	if (selection.linkTarget) addAction(`Reveal original in ${explorer}`, 'arrow-up-right', 'reveal', 'Could not reveal the original. The link may be broken.', false, selection.linkTarget);
	addAction('Open in terminal', 'terminal', 'terminal', 'Could not open Terminal for this path.', !Platform.isMacOS);
	if (!selection.isDirectory && HTML_FILE.test(selection.path)) addAction('Open in browser', 'globe', 'browser', 'Could not open this file in the browser.');
	// The open folder itself is never offered for deletion.
	if (isInside(path.resolve(rootPath), path.resolve(selection.path))) {
		// A link to a folder is trashed as a link: no folder prompt, and its target stays untouched.
		const folder = selection.isDirectory && !selection.isSymlink;
		const kind = selection.isSymlink ? 'Link' : folder ? 'Folder' : 'File';
		menu.addSeparator();
		menu.addItem((item) => item.setTitle('Delete').setIcon('trash-2').onClick(async () => {
			const targetPath = selection.path;
			if (folder && options.confirmFolderDelete && !await options.confirmFolderDelete(targetPath)) return;
			try { await runFileAction(folder ? 'delete-folder' : 'delete', targetPath, rootPath); }
			catch { new Notice(`Could not move this ${kind.toLowerCase()} to trash.`); return; }
			new Notice(`${kind} moved to trash.`);
			try { await options.onDeleted?.(targetPath, rootPath); }
			catch { new Notice(`${kind} moved to trash, but the view could not refresh.`); }
		}));
	}
	if ('clientX' in event) menu.showAtMouseEvent(event);
	else {
		const bounds = row.getBoundingClientRect();
		menu.showAtPosition({ x: bounds.left + 16, y: bounds.bottom });
	}
}
