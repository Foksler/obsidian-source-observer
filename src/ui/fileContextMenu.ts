import * as path from 'path';
import { Menu, Notice } from 'obsidian';
import {createEntry,CreateEntryError,trashEntry,type NewEntryKind} from '../files/index.ts';
import type {DesktopAction} from '../desktop/index.ts';
function isInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const HTML_FILE=/\.html?$/i;
type FileAction=DesktopAction;
export interface FileMenuServices {
 desktop:{readonly isMac:boolean;run(action:DesktopAction,filePath:string,rootPath?:string):Promise<void>;trash(filePath:string):Promise<void>};
 vault?:{canOpenMarkdown(filePath:string):boolean;openMarkdown(filePath:string):Promise<void>};
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

/** Native Obsidian menu, shared by tree rows, filtered results, Changes and source tabs. */
export function showFileContextMenu(
	selection: { path: string; isDirectory: boolean; isSymlink?: boolean; linkTarget?: string },
	event: MouseEvent | KeyboardEvent,
	row: HTMLElement,
	rootPath: string,
	options: FileMenuOptions,
 services:FileMenuServices,
) {
	const menu = new Menu();
	if (options.addLeadingItems) {
		options.addLeadingItems(menu);
		menu.addSeparator();
	}
	const vault=services.vault;
	if (vault && !selection.isDirectory && vault.canOpenMarkdown(selection.path)) {
		const filePath = selection.path;
		menu.addItem((item) => item.setTitle('Open in Obsidian').setIcon('file-text').onClick(async () => {
			try {
				// Resolve again: a file may have been removed or renamed while the menu was open.
				await vault.openMarkdown(filePath);
			} catch { new Notice('Could not open this note in Obsidian. It may have moved or been deleted.'); }
		}));
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
				await services.desktop.run(action, actionPath ?? selection.path, rootPath);
				if (action === 'copy' || action === 'copy-relative') new Notice('Path copied.');
			} catch { new Notice(failure); }
		}));
	};
	addAction('Copy path', 'copy', 'copy', 'Could not copy the path.');
	addAction('Copy relative path', 'copy', 'copy-relative', 'Could not copy the relative path.');
	const explorer = services.desktop.isMac ? 'Finder' : 'file explorer';
	addAction(`Reveal in ${explorer}`, 'folder-open', 'reveal', 'Could not reveal this path. It may have moved or been deleted.');
	// Reveal in Finder shows the link itself; this shows where it points.
	if (selection.linkTarget) addAction(`Reveal original in ${explorer}`, 'arrow-up-right', 'reveal', 'Could not reveal the original. The link may be broken.', false, selection.linkTarget);
	addAction('Open in terminal', 'terminal', 'terminal', 'Could not open Terminal for this path.', !services.desktop.isMac);
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
			try { await trashEntry(folder?'folder':'file',targetPath,rootPath,path=>services.desktop.trash(path)); }
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
