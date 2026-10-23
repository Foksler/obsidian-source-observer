import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { lineBreakFor, readSourceText, saveIfUnchanged } from '../src/sourceFile.ts';

test('only UTF-8 text that round-trips byte for byte is editable', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'source-observer-source-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(path.join(root, 'text.php'), '﻿<?php echo "данные";\r\n');
	await writeFile(path.join(root, 'binary.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]));
	assert.deepEqual(await readSourceText(path.join(root, 'text.php')), { content: '﻿<?php echo "данные";\r\n', editable: true });
	assert.equal((await readSourceText(path.join(root, 'binary.png'))).editable, false);
	assert.equal(await readSourceText(path.join(root, 'missing.php')), null);
});

test('CRLF is kept only for files that use it on every line', () => {
	assert.equal(lineBreakFor('a\r\nb\r\n'), '\r\n');
	assert.equal(lineBreakFor('a\nb\n'), '\n');
	assert.equal(lineBreakFor('a\r\nb\nc'), '\n');
	assert.equal(lineBreakFor('\na\r\n'), '\n');
	assert.equal(lineBreakFor('one line'), '\n');
});

test('saving never overwrites a file that changed or disappeared since it was loaded', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'source-observer-save-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = path.join(root, 'app.ts');
	await writeFile(file, 'loaded\n');
	assert.equal(saveIfUnchanged(file, 'edited\n', 'loaded\n'), 'saved');
	assert.equal(await readFile(file, 'utf8'), 'edited\n');
	await writeFile(file, 'agent edit\n');
	assert.equal(saveIfUnchanged(file, 'mine\n', 'edited\n'), 'changed');
	assert.equal(await readFile(file, 'utf8'), 'agent edit\n');
	await rm(file);
	assert.equal(saveIfUnchanged(file, 'mine\n', 'agent edit\n'), 'missing');
	await assert.rejects(readFile(file));
});
