// Test-only adapter for historical harness field names; production uses owned sessions.
import {CodePane} from '../../src/ui/codePane.ts';
export * from '../../src/ui/codePane.ts';
const aliases={"currentPath": "navigation.currentPath", "fileLocations": "navigation.fileLocations", "history": "navigation.history", "forwardHistory": "navigation.forwardHistory"};
for(const [key,value] of Object.entries(aliases))Object.defineProperty(CodePane.prototype,key,{configurable:true,get(){const [owner,field]=value.split('.');return (this as unknown as Record<string,Record<string,unknown>>)[owner!]![field!];},set(value:unknown){const [owner,field]=aliases[key as keyof typeof aliases].split('.');(this as unknown as Record<string,Record<string,unknown>>)[owner!]![field!]=value;}});
export {cloneCodePaneSession} from '../../src/workspace/NavigationSession.ts';
