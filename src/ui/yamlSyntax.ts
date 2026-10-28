import { LanguageSupport } from '@codemirror/language';
import { yamlLanguage } from '@codemirror/lang-yaml';
import { styleTags, Tag, tags as t } from '@lezer/highlight';

export const yamlKeyTag = Tag.define('yamlKey', t.propertyName);

// The stock grammar tags mapping keys as property definitions, which Monokai
// Pro leaves uncoloured. A dedicated tag colours keys like its YAML scope;
// other themes fall back to their property name colour.
const language = yamlLanguage.configure({
	props: [styleTags({ 'Key/Literal Key/QuotedLiteral': yamlKeyTag })],
});

export function yamlWithKeyHighlighting() {
	return new LanguageSupport(language);
}
