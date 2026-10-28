import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';
import {pathToFileURL} from 'url';
import {promisify} from 'util';
const execFileAsync=promisify(execFile);
export interface ElectronFileActions {
	clipboard: { writeText(text: string): void };
	shell: { showItemInFolder(fullPath: string): void; trashItem(fullPath: string): Promise<void>; openExternal(url: string): Promise<void> };
}

// The http handler, not the .html one: .html is often bound to an editor.
const DEFAULT_BROWSER_SCRIPT = "ObjC.import('AppKit'); const app = $.NSWorkspace.sharedWorkspace"
	+ ".URLForApplicationToOpenURL($.NSURL.URLWithString('https://example.com')); app.isNil() ? '' : app.path.js";

async function defaultBrowser(): Promise<string> {
	try {
		const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', DEFAULT_BROWSER_SCRIPT]);
		return stdout.trim();
	} catch { return ''; }
}

export type DesktopAction='copy'|'copy-relative'|'reveal'|'terminal'|'browser';
export class DesktopActions {
 readonly isMac:boolean;
 private electron:()=>ElectronFileActions;
 constructor(electron:()=>ElectronFileActions,isMac:boolean){this.electron=electron;this.isMac=isMac;}
 trash(filePath:string):Promise<void>{return this.electron().shell.trashItem(filePath);}
 async run(action:DesktopAction,filePath:string,rootPath?:string):Promise<void>{
 const fullPath=path.resolve(filePath);
	if (action === 'copy' || action === 'copy-relative') {
		if (action === 'copy-relative' && !rootPath) throw new Error('No project root is available.');
const {clipboard}=this.electron();
		clipboard.writeText(action === 'copy-relative' ? path.relative(rootPath!, fullPath) || '.' : fullPath);
		return;
	}
	if (action === 'reveal') {
		await fsp.access(fullPath);
const {shell}=this.electron();
		shell.showItemInFolder(fullPath);
		return;
	}
	if (action === 'browser') {
		await fsp.access(fullPath);
		const browser = this.isMac ? await defaultBrowser() : '';
		if (browser) { await execFileAsync('/usr/bin/open', ['-a', browser, fullPath]); return; }
const {shell}=this.electron();
		await shell.openExternal(pathToFileURL(fullPath).href);
		return;
	}
	if (!this.isMac) throw new Error('Opening a terminal is supported on macOS.');
	// stat follows symlinks: a link to a directory opens that directory, too.
	const directory = (await fsp.stat(fullPath)).isDirectory() ? fullPath : path.dirname(fullPath);
	await execFileAsync('/usr/bin/open', ['-a', 'Terminal', directory]);
 }
}
