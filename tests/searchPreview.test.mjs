import assert from 'node:assert/strict';
import test from 'node:test';
import { searchPreview } from '../src/searchPreview.ts';

test('a megabyte generated line retains the searched token in a bounded preview', () => {
	const prefix = 'x'.repeat(900_000);
	const source = prefix + 'StatsController' + 'y'.repeat(200_000);
	const preview = searchPreview(source, prefix.length + 1);
	assert.ok(preview.includes('StatsController'));
	assert.ok(preview.length <= 242);
	assert.ok(preview.startsWith('…') && preview.endsWith('…'));
});

test('previews leave ordinary lines unchanged and do not split emoji surrogates', () => {
	assert.equal(searchPreview('class StatsController {}', 7), 'class StatsController {}');
	const source = '😀'.repeat(300) + 'StatsController' + '😀'.repeat(300);
	const preview = searchPreview(source, 601);
	assert.ok(preview.includes('StatsController'));
	assert.ok(preview.isWellFormed());
});
