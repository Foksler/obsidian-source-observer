// Explicit test-only adapter for the frozen pre-registry benchmark constructor shape.
import {LspNavigation as Navigation} from '../../src/ui/lspNavigation.ts';
import type {LanguageLspOptions} from '../../src/ui/languageLsp.ts';
import type {LspAdapter} from '../../src/language/lspAdapter.ts';
import {createTestLanguageRuntime} from './languageRuntime.ts';
export {phpAdapter} from '../../src/desktop/phpAdapter.ts';
export {goAdapter} from '../../src/desktop/goAdapter.ts';
export class LspNavigation extends Navigation {
 private owned:ReturnType<typeof createTestLanguageRuntime>;
 constructor(options:Omit<LanguageLspOptions,'adapter'|'runtime'>,adapters:LspAdapter[]){const runtime=createTestLanguageRuntime();super({...options,runtime},adapters);this.owned=runtime;}
 dispose(){super.dispose();void this.owned.dispose();}
}
