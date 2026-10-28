import {LanguageRuntime} from '../../src/language/LanguageRuntime.ts';
import {LanguageConnection} from '../../src/desktop/LanguageConnection.ts';
import {createCodeMirrorEndpoint} from '../../src/ui/CodeMirrorEndpoint.ts';
import {readDocumentText} from '../../src/files/sourceFile.ts';
export function createTestLanguageRuntime(){return new LanguageRuntime((spec,events)=>new LanguageConnection(spec.root,spec.adapter,spec.includeWorktrees,events,createCodeMirrorEndpoint(spec,events,readDocumentText)));}
