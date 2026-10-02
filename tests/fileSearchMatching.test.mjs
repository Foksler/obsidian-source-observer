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
