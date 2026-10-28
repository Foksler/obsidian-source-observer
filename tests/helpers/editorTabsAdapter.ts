// Test-only adapter for historical harness field names; production uses owned sessions.
import {EditorTabs} from '../../src/ui/editorTabs.ts';
export * from '../../src/ui/editorTabs.ts';
const aliases={"tabs": "session.tabs", "active": "session.active"};
for(const [key,value] of Object.entries(aliases))Object.defineProperty(EditorTabs.prototype,key,{configurable:true,get(){const [owner,field]=value.split('.');return (this as unknown as Record<string,Record<string,unknown>>)[owner!]![field!];},set(value:unknown){const [owner,field]=aliases[key as keyof typeof aliases].split('.');(this as unknown as Record<string,Record<string,unknown>>)[owner!]![field!]=value;}});
export {cloneEditorTabsState} from '../../src/workspace/TabSession.ts';
