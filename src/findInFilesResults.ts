import * as path from 'path';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { phpLanguage } from '@codemirror/lang-php';
import { javascriptLanguage, typescriptLanguage, jsxLanguage, tsxLanguage } from '@codemirror/lang-javascript';
import { jsonLanguage } from '@codemirror/lang-json';
import { pythonLanguage } from '@codemirror/lang-python';
import { rustLanguage } from '@codemirror/lang-rust';
import { cssLanguage } from '@codemirror/lang-css';
import { htmlLanguage } from '@codemirror/lang-html';
import { searchHighlightRanges } from './searchEverywhereResults';
import type { SearchMatch, SearchOptions } from './searchEngine';

const phpSnippet = phpLanguage.configure({ top: 'Program' });
const languages = {
	php: phpSnippet, js: javascriptLanguage, mjs: javascriptLanguage, cjs: javascriptLanguage,
	ts: typescriptLanguage, jsx: jsxLanguage, tsx: tsxLanguage, json: jsonLanguage,
	jsonc: jsonLanguage, py: pythonLanguage, rs: rustLanguage, css: cssLanguage,
	html: htmlLanguage, htm: htmlLanguage,
};
interface SyntaxRange { from: number; to: number; className: string }
export interface FindSnippetPart { text: string; className: string; matched: boolean }

/** Merge syntax and query ranges before rendering, including queries spanning tokens. */
export function findSnippetParts(text: string, file: string, query: string, options: Omit<SearchOptions, 'query'>): FindSnippetPart[] {
	const syntax: SyntaxRange[] = [];
	const extension = path.extname(file).slice(1).toLowerCase() as keyof typeof languages;
	const language = languages[extension];
	if (language) highlightTree(language.parser.parse(text), classHighlighter,
		(from, to, className) => syntax.push({ from, to, className }));
	const matches = searchHighlightRanges(text, query, options);
	const boundaries = [...new Set([0, text.length, ...syntax.flatMap(({ from, to }) => [from, to]), ...matches.flatMap(({ from, to }) => [from, to])])].sort((a, b) => a - b);
	const parts: FindSnippetPart[] = [];
	let token = 0, match = 0;
	for (let i = 0; i < boundaries.length - 1; i++) {
		const from = boundaries[i]!, to = boundaries[i + 1]!;
		while (syntax[token] && syntax[token]!.to <= from) token++;
		while (matches[match] && matches[match]!.to <= from) match++;
		parts.push({ text: text.slice(from, to), className: syntax[token] && syntax[token]!.from <= from ? syntax[token]!.className : '',
			matched: !!matches[match] && matches[match]!.from <= from });
	}
	return parts;
}

export function renderFindSnippet(target: HTMLElement, match: SearchMatch, query: string, options: Omit<SearchOptions, 'query'>) {
	for (const part of findSnippetParts(match.text, match.filePath, query, options)) {
		target.createEl(part.matched ? 'mark' : 'span', { text: part.text, cls: part.matched ? 'so-find-match' : part.className });
	}
}

export function renderFindLocation(target: HTMLElement, root: string, match: SearchMatch) {
	const relative = path.relative(root, match.filePath);
	const parent = path.dirname(relative);
	const folders = parent === '.' ? [] : parent.split(path.sep);
	const directory = folders.length > 2 ? `${folders[0]}/…/` : folders.length ? `${folders.join('/')}/` : '';
	target.setAttribute('title', `${match.filePath}:${match.line}:${match.column}`);
	target.createSpan({ cls: 'so-find-path', text: directory });
	target.createSpan({ cls: 'so-find-file-name', text: path.basename(match.filePath) });
	target.createSpan({ cls: 'so-find-line', text: String(match.line) });
}

export function renderFindFileHeader(header: HTMLElement, root: string, match: SearchMatch) {
	header.empty();
	header.setAttribute('title', `${match.filePath}:${match.line}:${match.column}`);
	header.createSpan({ cls: 'so-find-preview-name', text: path.basename(match.filePath) });
	const directory = path.relative(root, path.dirname(match.filePath));
	header.createSpan({ cls: 'so-find-preview-directory', text: directory || path.basename(root) });
}
