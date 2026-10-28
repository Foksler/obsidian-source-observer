import { LanguageSupport, syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { styleTags, Tag, tags as t } from '@lezer/highlight';
import { phpLanguage } from '@codemirror/lang-php';

export const phpSemicolonTag = Tag.define('phpSemicolon', t.punctuation);

// The stock PHP grammar leaves several names untagged. Add PHP-aware node
// mappings so declarations, parameters, types, and calls can use distinct
// Monokai Pro colours instead of inheriting generic text styling.
const language = phpLanguage.configure({
	props: [styleTags({
		'ClassDeclaration/Name InterfaceDeclaration/Name TraitDeclaration/Name EnumDeclaration/Name': t.definition(t.className),
		'FunctionDeclaration/Name MethodDeclaration/Name': t.definition(t.function(t.variableName)),
		'CallExpression/Name CallExpression/MemberExpression/Name CallExpression/ScopedExpression/ClassMemberName/Name': t.function(t.variableName),
		'NewExpression/Name': t.className,
		'Parameter/VariableName': t.definition(t.variableName),
		'VariableName': t.variableName,
		'NamedType/Name': t.typeName,
		'ClassMemberName/Name': t.propertyName,
		'readonly': t.keyword,
		'";"': phpSemicolonTag,
	})],
});

export interface PhpMark {
	from: number;
	to: number;
	className: 'so-php-variable-sigil' | 'so-php-string-delimiter';
}

/** Returns exact source ranges for PHP sigils and quote delimiters. */
export function phpTokenMarks(tree: ReturnType<typeof language.parser.parse>, source: string): PhpMark[] {
	const marks: PhpMark[] = [];
	tree.iterate({ enter(node) {
		if (node.name === 'VariableName' && source[node.from] === '$') {
			marks.push({ from: node.from, to: node.from + 1, className: 'so-php-variable-sigil' });
		}
		if (node.name === 'String' && node.to - node.from >= 2) {
			const opening = source[node.from];
			const closing = source[node.to - 1];
			if ((opening === '"' || opening === "'") && closing === opening) {
				marks.push({ from: node.from, to: node.from + 1, className: 'so-php-string-delimiter' });
				marks.push({ from: node.to - 1, to: node.to, className: 'so-php-string-delimiter' });
			}
		}
	} });
	return marks.sort((a, b) => a.from - b.from);
}

const phpTokenHighlight = ViewPlugin.fromClass(class {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.build(view);
	}

	update(update: ViewUpdate) {
		if (
			update.docChanged ||
			update.viewportChanged ||
			syntaxTree(update.state) !== syntaxTree(update.startState)
		) {
			this.decorations = this.build(update.view);
		}
	}

	private build(view: EditorView): DecorationSet {
		const source = view.state.doc.toString();
		const marks = phpTokenMarks(syntaxTree(view.state), source);
		return Decoration.set(marks.map((mark) =>
			Decoration.mark({ class: mark.className }).range(mark.from, mark.to),
		));
	}
}, { decorations: (plugin) => plugin.decorations });

export function phpWithSemanticHighlighting(): LanguageSupport {
	return new LanguageSupport(language, phpTokenHighlight);
}
