import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { oneDarkHighlightStyle, oneDarkTheme } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { SyntaxTheme } from './settings';
import { phpSemicolonTag } from './phpSyntax';

export const monokaiHighlight = HighlightStyle.define([
	{ tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword], color: '#FF6188' },
	{ tag: [t.typeName, t.className, t.namespace], color: '#e2d08f' },
	{ tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: '#83e674' },
	{ tag: t.definition(t.function(t.variableName)), color: '#83e674' },
	{ tag: [t.definition(t.variableName)], color: '#3482db' },
	{ tag: [t.name, t.variableName], color: '#FCFCFA' },
	{ tag: [t.propertyName, t.attributeName], color: '#FCFCFA' },
	{ tag: [t.constant(t.name), t.standard(t.name), t.atom, t.bool, t.null, t.self], color: '#AB9DF2' },
	{ tag: t.number, color: '#AB9DF2' },
	{ tag: [t.string, t.special(t.string), t.inserted], color: '#FFD866' },
	{ tag: [t.regexp, t.escape], color: '#FC9867' },
	{ tag: [t.operator, t.operatorKeyword], color: '#78DCE8' },
	{ tag: [t.punctuation, t.separator], color: '#b4adb4' },
	{ tag: phpSemicolonTag, color: '#d6991e' },
	{ tag: [t.comment, t.meta], color: '#727072', fontStyle: 'italic' },
	{ tag: [t.annotation, t.processingInstruction], color: '#AB9DF2' },
	{ tag: t.heading, color: '#FF6188', fontWeight: 'bold' },
	{ tag: t.strong, fontWeight: 'bold' },
	{ tag: t.emphasis, fontStyle: 'italic' },
	{ tag: t.link, color: '#78DCE8', textDecoration: 'underline' },
	{ tag: [t.deleted, t.invalid], color: '#FF6188' },
]);

const monokaiTheme = EditorView.theme({
	'&': { backgroundColor: '#2c2a2ed9', color: '#FCFCFA' },
	'.cm-scroller': { backgroundColor: '#2c2a2ed9' },
	'.cm-gutters': { backgroundColor: '#2c2a2ed9', color: '#727072', border: 'none' },
	'.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#403e41' },
	'.cm-selectionBackground, ::selection': { backgroundColor: '#5b595c' },
	'&.cm-focused .cm-selectionBackground': { backgroundColor: '#5b595c' },
	'.cm-cursor': { borderLeftColor: '#FCFCFA' },
	'.cm-line .so-php-variable-sigil': { color: '#d6991e' },
	'.cm-line .so-php-string-delimiter': { color: '#b4adb4' },
	'.cm-matchingBracket': { backgroundColor: '#d6991e33', outline: '1px solid #d6991e88' },
}, { dark: true });

export const cursorMonokaiExtensions = [syntaxHighlighting(monokaiHighlight), monokaiTheme];

const obsidianHighlight = HighlightStyle.define([
	{ tag: t.keyword, color: 'var(--code-keyword)' },
	{ tag: [t.name, t.deleted, t.character, t.macroName], color: 'var(--code-normal)' },
	{ tag: [t.propertyName, t.labelName], color: 'var(--code-property)' },
	{ tag: [t.color, t.constant(t.name), t.standard(t.name)], color: 'var(--code-value)' },
	{ tag: [t.definition(t.name), t.separator], color: 'var(--code-normal)' },
	{ tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: 'var(--code-tag)' },
	{ tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: 'var(--code-operator)' },
	{ tag: [t.meta, t.comment], color: 'var(--code-comment)', fontStyle: 'italic' },
	{ tag: t.strong, fontWeight: 'bold' },
	{ tag: t.emphasis, fontStyle: 'italic' },
	{ tag: t.strikethrough, textDecoration: 'line-through' },
	{ tag: t.link, color: 'var(--code-value)', textDecoration: 'underline' },
	{ tag: t.heading, fontWeight: 'bold', color: 'var(--code-tag)' },
	{ tag: [t.atom, t.bool, t.special(t.variableName)], color: 'var(--code-value)' },
	{ tag: [t.processingInstruction, t.string, t.inserted], color: 'var(--code-string)' },
	{ tag: t.invalid, color: 'var(--text-error)' },
]);

/** Base layout follows the active Obsidian theme. */
export const obsidianTheme = EditorView.theme({
	'&': {
		fontSize: 'inherit',
		height: '100%',
		background: 'var(--code-background)',
		color: 'var(--code-normal)',
	},
	'.cm-scroller': {
		overflow: 'auto',
		fontFamily: 'var(--font-monospace)',
		lineHeight: '1.6',
	},
	'.cm-content': { caretColor: 'var(--text-normal)' },
	'.cm-cursor': { borderLeftColor: 'var(--text-normal)' },
	'.cm-activeLine': { background: 'var(--background-modifier-hover)' },
	'.cm-gutters': {
		background: 'var(--code-background)',
		color: 'var(--text-faint)',
		border: 'none',
		borderRight: '1px solid var(--background-modifier-border)',
	},
	'.cm-activeLineGutter': { background: 'var(--background-modifier-hover)' },
	'.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 6px', minWidth: '2ch' },
	'.cm-selectionBackground, ::selection': { background: 'var(--text-selection)' },
	'&.cm-focused .cm-selectionBackground': { background: 'var(--text-selection)' },
});

const darkPlusHighlight = HighlightStyle.define([
	{ tag: [t.keyword, t.modifier, t.operatorKeyword], color: '#569CD6' },
	{ tag: [t.controlKeyword, t.moduleKeyword], color: '#C586C0' },
	{ tag: [t.name, t.variableName, t.character], color: '#9CDCFE' },
	{ tag: [t.propertyName, t.labelName, t.attributeName], color: '#9CDCFE' },
	{ tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: '#DCDCAA' },
	{ tag: [t.typeName, t.className, t.namespace, t.tagName], color: '#4EC9B0' },
	{ tag: [t.constant(t.name), t.standard(t.name), t.atom, t.bool, t.null, t.self], color: '#569CD6' },
	{ tag: t.number, color: '#B5CEA8' },
	{ tag: [t.string, t.special(t.string), t.inserted], color: '#CE9178' },
	{ tag: [t.regexp, t.escape], color: '#D16969' },
	{ tag: [t.operator, t.punctuation, t.separator], color: '#D4D4D4' },
	{ tag: [t.comment, t.meta], color: '#6A9955', fontStyle: 'italic' },
	{ tag: [t.annotation, t.processingInstruction], color: '#569CD6' },
	{ tag: t.heading, color: '#569CD6', fontWeight: 'bold' },
	{ tag: t.strong, fontWeight: 'bold' },
	{ tag: t.emphasis, fontStyle: 'italic' },
	{ tag: t.link, color: '#3794FF', textDecoration: 'underline' },
	{ tag: t.deleted, color: '#F44747' },
	{ tag: t.invalid, color: '#F44747' },
]);

const darkPlusTheme = EditorView.theme({
	'&': { background: '#1E1E1E', color: '#D4D4D4' },
	'.cm-gutters': { background: '#1E1E1E', color: '#858585' },
	'.cm-activeLine, .cm-activeLineGutter': { background: '#2A2D2E' },
	'.cm-selectionBackground, ::selection': { background: '#264F78' },
	'&.cm-focused .cm-selectionBackground': { background: '#264F78' },
}, { dark: true });

export function syntaxTheme(name: SyntaxTheme) {
	switch (name) {
		case 'cursor-monokai': return cursorMonokaiExtensions;
		case 'dark-plus': return [syntaxHighlighting(darkPlusHighlight), darkPlusTheme];
		case 'one-dark': return [syntaxHighlighting(oneDarkHighlightStyle), oneDarkTheme];
		default: return [syntaxHighlighting(obsidianHighlight)];
	}
}
