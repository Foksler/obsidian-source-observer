import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Menu, Notice, Platform } from 'obsidian';

const execFileAsync = promisify(execFile);
type FileAction = 'copy' | 'copy-relative' | 'reveal' | 'terminal';
interface ElectronFileActions {
	clipboard: { writeText(text: string): void };
	shell: { showItemInFolder(fullPath: string): void };
}

/** Keep filesystem paths as arguments, never as executable shell text. */
export async function runFileAction(action: FileAction, filePath: string, rootPath?: string): Promise<void> {
	const fullPath = path.resolve(filePath);
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
	if (!Platform.isMacOS) throw new Error('Opening a terminal is supported on macOS.');
	// stat follows symlinks: a link to a directory opens that directory, too.
	const directory = (await fsp.stat(fullPath)).isDirectory() ? fullPath : path.dirname(fullPath);
	await execFileAsync('/usr/bin/open', ['-a', 'Terminal', directory]);
}

/** Native Obsidian menu, shared by ordinary tree rows and filtered results. */
export function showFileContextMenu(
	selection: { path: string; isDirectory: boolean },
	event: MouseEvent | KeyboardEvent,
	row: HTMLElement,
	rootPath: string,
) {
	const menu = new Menu();
	const addAction = (title: string, icon: string, action: FileAction, failure: string, disabled = false) => {
		menu.addItem((item) => item.setTitle(title).setIcon(icon).setDisabled(disabled).onClick(async () => {
			try {
				await runFileAction(action, selection.path, rootPath);
				if (action === 'copy' || action === 'copy-relative') new Notice('Path copied.');
			} catch { new Notice(failure); }
		}));
	};
	addAction('Copy path', 'copy', 'copy', 'Could not copy the path.');
	addAction('Copy relative path', 'copy', 'copy-relative', 'Could not copy the relative path.');
	addAction(Platform.isMacOS ? 'Reveal in Finder' : 'Reveal in file explorer', 'folder-open', 'reveal', 'Could not reveal this path. It may have moved or been deleted.');
	addAction('Open in terminal', 'terminal', 'terminal', 'Could not open Terminal for this path.', !Platform.isMacOS);
	if ('clientX' in event) menu.showAtMouseEvent(event);
	else {
		const bounds = row.getBoundingClientRect();
		menu.showAtPosition({ x: bounds.left + 16, y: bounds.bottom });
	}
}
