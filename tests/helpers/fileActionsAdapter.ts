// Test-only legacy shape keeps existing UX assertions while exercising separated public seams.
import {Platform,type App} from 'obsidian';
import {DesktopActions,type ElectronFileActions} from '../../src/desktop/DesktopActions';
import {createEntry,trashEntry} from '../../src/files/FileOperations';
import {VaultNavigation} from '../../src/obsidian/VaultNavigation';
import {showFileContextMenu as showMenu,type FileMenuOptions} from '../../src/ui/fileContextMenu.ts';
export {createEntry};
function desktop(){return new DesktopActions(()=>window.require('electron') as ElectronFileActions,Platform.isMacOS);}
export async function runFileAction(action:'delete'|'delete-folder'|'copy'|'copy-relative'|'reveal'|'terminal'|'browser',file:string,root?:string){
 const actions=desktop();
 if(action==='delete'||action==='delete-folder')return trashEntry(action==='delete'?'file':'folder',file,root??'',path=>actions.trash(path));
 return actions.run(action,file,root);
}
export function showFileContextMenu(selection:Parameters<typeof showMenu>[0],event:MouseEvent|KeyboardEvent,row:HTMLElement,root:string,options:FileMenuOptions&{app?:App}={}){
 return showMenu(selection,event,row,root,options,{desktop:desktop(),vault:options.app?new VaultNavigation(options.app):undefined});
}
