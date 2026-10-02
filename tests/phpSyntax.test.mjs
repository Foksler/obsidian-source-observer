import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { getStyleTags } from '@lezer/highlight';

const tempDir = await mkdtemp(path.join(process.cwd(), 'tests', '.php-syntax-'));
const bundlePath = path.join(tempDir, 'phpSyntax.mjs');
await build({
	stdin: {
		contents: `export { phpSemicolonTag, phpTokenMarks, phpWithSemanticHighlighting } from './src/phpSyntax.ts';\nexport { monokaiHighlight } from './src/editorThemes.ts';`,
		resolveDir: process.cwd(),
		sourcefile: 'php-syntax-test-entry.ts',
	},
	bundle: true,
	packages: 'external',
	platform: 'node',
	format: 'esm',
	outfile: bundlePath,
});
const { phpSemicolonTag, phpTokenMarks, phpWithSemanticHighlighting, monokaiHighlight } = await import(pathToFileURL(bundlePath).href);

test.after(async () => rm(tempDir, { recursive: true, force: true }));

function descendants(node, output = []) {
	output.push(node);
	for (let child = node.firstChild; child; child = child.nextSibling) descendants(child, output);
	return output;
}

function tagDescription(node) {
	const match = getStyleTags(node);
	return match?.tags.map((tag) => ({ name: tag.name, modified: tag.modified.map((modifier) => modifier.name) })) ?? [];
}

function renderedColor(node) {
	const tags = getStyleTags(node)?.tags ?? [];
	const className = monokaiHighlight.style(tags);
	if (!className) return null;
	const cssRule = monokaiHighlight.module.rules.find((rule) => rule.startsWith(`.${className} `));
	return cssRule?.match(/color: ([^;]+);/)?.[1] ?? null;
}

test('PHP grammar tags declarations, parameters, types, function calls, and method calls distinctly', () => {
	const source = `<?php
class Sample {
	public readonly string $label;
	public function run($arg, int $size): self {
		$local = Foo::make();
		$obj->method();
		$obj->field;
		foo("$arg");
	}
}`;
	const parser = phpWithSemanticHighlighting().language.parser;
	const nodes = descendants(parser.parse(source).topNode);
	const find = (name, text) => nodes.find((node) => node.name === name && source.slice(node.from, node.to) === text);
	const styles = (name, text) => tagDescription(find(name, text));

	assert.deepEqual(styles('Name', 'Sample')[0], { name: 'className', modified: ['definition'] });
	assert.deepEqual(styles('VariableName', '$arg')[0], { name: 'variableName', modified: ['definition'] });
	assert.deepEqual(styles('VariableName', '$size')[0], { name: 'variableName', modified: ['definition'] });
	assert.deepEqual(styles('Name', 'run')[0], { name: 'variableName', modified: ['definition', 'function'] });
	assert.deepEqual(styles('Name', 'foo')[0], { name: 'variableName', modified: ['function'] });
	assert.deepEqual(styles('Name', 'make')[0], { name: 'variableName', modified: ['function'] });
	assert.deepEqual(styles('Name', 'method')[0], { name: 'variableName', modified: ['function'] });
	assert.notDeepEqual(styles('Name', 'field')[0], { name: 'variableName', modified: ['function'] });
	assert.deepEqual(styles('NamedType', 'int')[0], { name: 'typeName', modified: [] });
	assert.equal(renderedColor(find('Name', 'Sample')), '#e2d08f');
	assert.equal(renderedColor(find('VariableName', '$arg')), '#3482db');
	assert.equal(renderedColor(find('Name', 'run')), '#83e674');
	assert.equal(renderedColor(find('Name', 'foo')), '#83e674');
	assert.equal(renderedColor(find('Name', 'method')), '#83e674');
	assert.equal(renderedColor(find('Name', 'field')), '#FCFCFA');
	assert.equal(renderedColor(find('NamedType', 'int')), '#e2d08f');
	assert.equal(renderedColor(find('readonly', 'readonly')), '#FF6188');

	const semicolon = find(';', ';');
	assert.ok(tagDescription(semicolon).some(({ name }) => name === phpSemicolonTag.name));
	assert.equal(renderedColor(semicolon), '#d6991e');
	assert.equal(find(';', ';') !== undefined, true);
});

test('PHP source marks split dollar sigils and string quote delimiters from variable names', () => {
	const source = `<?php function f($arg) { return "value $arg"; }`;
	const tree = phpWithSemanticHighlighting().language.parser.parse(source);
	const marks = phpTokenMarks(tree, source);
	const markedText = marks.map((mark) => [mark.className, source.slice(mark.from, mark.to)]);
	assert.deepEqual(markedText.filter(([className]) => className === 'so-php-variable-sigil'), [
		['so-php-variable-sigil', '$'],
		['so-php-variable-sigil', '$'],
	]);
	assert.deepEqual(markedText.filter(([className]) => className === 'so-php-string-delimiter'), [
		['so-php-string-delimiter', '"'],
		['so-php-string-delimiter', '"'],
	]);
});

test('Monokai PHP sigil and quote colors override nested syntax token colors', async () => {
	const stylesheet = await readFile(path.resolve('styles.css'), 'utf8');
	assert.match(stylesheet, /\.so-root\.so-cursor-theme \.so-php-variable-sigil[\s\S]*?#d6991e !important;/);
	assert.match(stylesheet, /\.so-root\.so-cursor-theme \.so-php-string-delimiter[\s\S]*?#b4adb4 !important;/);
});
