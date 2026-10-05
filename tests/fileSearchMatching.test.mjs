import assert from 'node:assert/strict';
import test from 'node:test';
import { createFileMatcher } from '../src/fileSearchMatching.ts';

test('exact basename stem outranks a basename substring, which outranks directory-only hits', () => {
	const match = createFileMatcher('controller');
	const exact = match('src/Controller.php');
	const substring = match('src/DashboardController.php');
	const directory = match('controllers/Dashboard.php');

	assert.ok(exact !== null && substring !== null && directory !== null);
	assert.ok(exact > substring);
	assert.ok(substring > directory);
});

test('path length cutoff precedes Unicode case folding, including cached folded paths', () => {
	const match = createFileMatcher('needle');
	const withinLimit = `İ${'x'.repeat(8184)}needle`;
	assert.notEqual(match(withinLimit), null);
	assert.equal(match(withinLimit, withinLimit.toLowerCase()), match(withinLimit));
	const outsideLimit = `${'x'.repeat(8192)}needle`;
	assert.equal(match(outsideLimit), null);
	assert.equal(match(outsideLimit, outsideLimit.toLowerCase()), null);
});

test('matches case-insensitively and supports path/name terms in either order', () => {
	const match = createFileMatcher('controllers dashboard');
	assert.notEqual(match('app/Http/Controllers/DashboardController.php'), null);
	assert.notEqual(match('app\\http\\controllers\\dashboard.php'), null);
	assert.equal(match('app/Http/Controllers/ReportsController.php'), null);
});

test('camel-case subsequence queries find compact filename abbreviations', () => {
	const match = createFileMatcher('DshbrdCtrlr');
	assert.notEqual(match('src/DashboardController.php'), null);
	assert.equal(match('src/DatabaseController.php'), null);
});

test('compound filename query tolerates an intervening camel-case segment but ranks exact stem first', () => {
	const match = createFileMatcher('DashboardController');
	const exact = match('src/DashboardController.php');
	const gapped = match('src/DashboardStatsController.php');
	const directoryOnly = match('DashboardController/OtherFile.ts');

	assert.ok(exact !== null && gapped !== null && directoryOnly !== null);
	assert.ok(exact > gapped);
	assert.ok(gapped > directoryOnly);
});

test('empty query and empty path never produce a match', () => {
	assert.equal(createFileMatcher('   / \\ ')('src/anything.ts'), null);
	assert.equal(createFileMatcher('anything')(''), null);
});

test('optimized matching preserves original scores for boundaries, Unicode, directories and multi-term queries', () => {
	const cases = [
		['controller', 'src/Controller.php', 10730], ['controller', 'controllers/Dashboard.php', 420],
		['DshbrdCtrlr', 'src/DashboardController.php', 444],
		['dashboardcontroller', 'vendor/Http/Controllers/DashboardStatsController.php', 471],
		['app service', 'app/Services/OrderService.php', 1005], ['foo', 'foo/prefixFoo.ts', 654],
		['fbr', 'foobar/FooBar.vue', 425], ['bar', 'bar/ABCBar.ts', 557],
		['httpclient', 'src/HTTPClient.php', 10730], ['data', 'данные/😀Data.php', 658],
		['язык', 'данные/Язык.ts', 10730], ['c c', 'a/CamelCase.vue', 1500],
		['env', '.env', 659], ['read me', 'README', 11306], ['abc', 'a/b/c/File.ts', null],
		['foo', 'foo-bar/abc.ts', 420],
	];
	for (const [query, file, score] of cases) {
		const match = createFileMatcher(query);
		assert.equal(match(file), score, `${query}: ${file}`);
		assert.equal(match(file, file.toLowerCase()), score);
	}
});
