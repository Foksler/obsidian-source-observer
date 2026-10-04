import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const temp = await mkdtemp(path.join(process.cwd(), 'tests', '.find-results-'));
const bundle = path.join(temp, 'results.mjs');
await build({ entryPoints: ['src/findInFilesResults.ts'], bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: bundle });
const { findSnippetParts, renderFindSnippet, renderFindFileHeader, renderFindLocation } = await import(pathToFileURL(bundle).href);
test.after(() => rm(temp, { recursive: true, force: true }));

test('PHP snippets color declarations, class references and route strings while highlighting the exact query', () => {
	const declaration = 'class GoogleAuthController extends Controller';
	const parts = findSnippetParts(declaration, '/project/Controller.php', 'AuthController', {});
	assert.equal(parts.map(part => part.text).join(''), declaration);
	assert.ok(parts.some(part => part.text === 'class' && part.className.includes('tok-keyword')));
	assert.ok(parts.some(part => part.text === 'extends' && part.className.includes('tok-keyword')));
	assert.equal(parts.filter(part => part.matched).map(part => part.text).join(''), 'AuthController');
	const route = "Route::post('/auth/google', [AuthController::class, 'login']);";
	const routeParts = findSnippetParts(route, '/project/routes/api.php', 'AuthController::class', {});
	assert.ok(routeParts.some(part => part.text === "'/auth/google'" && part.className.includes('tok-string')));
	assert.equal(routeParts.filter(part => part.matched).map(part => part.text).join(''), 'AuthController::class');
	assert.equal(routeParts.map(part => part.text).join(''), route);
});

test('query matching spans syntax boundaries and keeps whole-word, regex and Unicode semantics', () => {
	const code = 'class AuthController extends Controller';
	const literal = findSnippetParts(code, '/project/a.ts', 'class AuthController', {});
	assert.equal(literal.filter(part => part.matched).map(part => part.text).join(''), 'class AuthController');
	const regex = findSnippetParts(code, '/project/a.php', 'class\\s+AuthController', { regex: true });
	assert.equal(regex.filter(part => part.matched).map(part => part.text).join(''), 'class AuthController');
	assert.equal(findSnippetParts('AuthController Controller контроллер', '/project/a.txt', 'Controller', { wholeWord: true }).filter(part => part.matched).map(part => part.text).join(''), 'Controller');
	assert.equal(findSnippetParts('AuthController', '/project/a.php', 'authcontroller', { caseSensitive: true }).filter(part => part.matched).length, 0);
	assert.equal(findSnippetParts('🚀 контроллер', '/project/a.txt', 'контроллер', {}).map(part => part.text).join(''), '🚀 контроллер');
	assert.equal(findSnippetParts(code, '/project/a.php', '[', { regex: true }).filter(part => part.matched).length, 0);
});

class Element {
	children = []; attrs = {};
	empty() { this.children = []; }
	setAttribute(key, value) { this.attrs[key] = value; }
	createEl(tag, options) { const child = { tag, ...options }; this.children.push(child); return child; }
	createSpan(options) { return this.createEl('span', options); }
}

test('code rendering treats markup as text and wraps only matches in mark elements', () => {
	const target = new Element();
	const match = { filePath: '/project/file.txt', text: '<script>needle</script>', line: 1, column: 9 };
	renderFindSnippet(target, match, 'needle', {});
	assert.equal(target.children.map(child => child.text).join(''), match.text);
	assert.deepEqual(target.children.filter(child => child.tag === 'mark').map(child => child.text), ['needle']);
	assert.equal(target.children.some(child => child.tag === 'script'), false);
});

test('preview header separates basename from root-relative directory; result locations retain exact navigation in the tooltip', () => {
	const match = { filePath: '/project/predictions/app/Controllers/AuthController.php', line: 17, column: 7 };
	const header = new Element();
	renderFindFileHeader(header, '/project', match);
	assert.deepEqual(header.children.map(child => child.text), ['AuthController.php', 'predictions/app/Controllers']);
	assert.equal(header.attrs.title, `${match.filePath}:17:7`);
	const row = new Element(); renderFindLocation(row, '/project', match);
	assert.deepEqual(row.children.map(child => child.text), ['predictions/…/', 'AuthController.php', '17']);
	assert.equal(row.attrs.title, `${match.filePath}:17:7`);
});
