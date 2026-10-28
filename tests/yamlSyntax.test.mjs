import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { highlightTree, tags as t } from '@lezer/highlight';

const tempDir = await mkdtemp(path.join(process.cwd(), 'tests', '.yaml-syntax-'));
const bundlePath = path.join(tempDir, 'yamlSyntax.mjs');
await build({
	stdin: {
		contents: `export { yamlKeyTag, yamlWithKeyHighlighting } from './src/ui/yamlSyntax.ts';\nexport { monokaiHighlight } from './src/ui/editorThemes.ts';`,
		resolveDir: process.cwd(),
		sourcefile: 'yaml-syntax-test-entry.ts',
	},
	bundle: true,
	packages: 'external',
	platform: 'node',
	format: 'esm',
	outfile: bundlePath,
});
const { yamlKeyTag, yamlWithKeyHighlighting, monokaiHighlight } = await import(pathToFileURL(bundlePath).href);

test.after(async () => rm(tempDir, { recursive: true, force: true }));

test('YAML keys get their own tag, coloured by Monokai, while values, strings and comments keep theirs', () => {
	const source = '# helm values\nimage:\n  repository: bitnami/redis\n"quoted key": "quoted value"\nlist:\n  - item\n';
	const tree = yamlWithKeyHighlighting().language.parser.parse(source);
	const tokens = new Map();
	const highlighter = { style(tags) {
		const name = tags.includes(yamlKeyTag) ? 'key' : tags.includes(t.string) ? 'string'
			: tags.includes(t.lineComment) ? 'comment' : null;
		return name;
	} };
	highlightTree(tree, highlighter, (from, to, name) => {
		for (const part of name.split(' ')) tokens.set(part, [...(tokens.get(part) ?? []), source.slice(from, to)]);
	});
	assert.deepEqual(tokens.get('key'), ['image', 'repository', '"quoted key"', 'list']);
	assert.deepEqual(tokens.get('string'), ['"quoted value"']);
	assert.deepEqual(tokens.get('comment'), ['# helm values']);
	assert.ok(monokaiHighlight.style([yamlKeyTag]), 'Monokai colours YAML keys');
});
