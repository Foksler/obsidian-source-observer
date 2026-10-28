import {FileSystemAdapter,TFile,type App} from 'obsidian';
import * as path from 'path';
function isInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function vaultMarkdownFile(app: App, filePath: string): TFile | null {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter) || path.extname(filePath).toLowerCase() !== '.md') return null;
	const root = adapter.getBasePath();
	if (!isInside(root, path.resolve(filePath))) return null;
	const relative = path.relative(root, filePath).split(path.sep).join('/');
	const file = app.vault.getAbstractFileByPath(relative);
	return file instanceof TFile ? file : null;
}

export class VaultNavigation {
 private app:App;
 constructor(app:App){this.app=app;}
 canOpenMarkdown(filePath:string):boolean{return vaultMarkdownFile(this.app,filePath)!==null;}
 async openMarkdown(filePath:string):Promise<void>{
  const file=vaultMarkdownFile(this.app,filePath);if(!file)throw Error('Note is no longer available in this vault.');
  await this.app.workspace.getLeaf('tab').openFile(file,{active:true});
 }
}
