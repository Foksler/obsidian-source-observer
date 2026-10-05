import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectFilePaths, inventoryFilePaths } from '../src/fileInventory.ts';

test('full filename enumeration preserves newline names and the index ignore, worktree and symlink rules', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'source-observer-inventory-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const names = ['src/first\nsecond.php', 'vendor/Hidden.php', '.git/Metadata.php', '.obsidian/Metadata.php',
		'node_modules/Metadata.php', 'worktrees/branch/Linked.php', 'unusual-checkout/Linked.php'];
	for (const name of names) {
		await mkdir(path.dirname(path.join(root, name)), { recursive: true });
		await writeFile(path.join(root, name), '');
	}
	await symlink(path.join(root, 'src'), path.join(root, 'alias'));
	const scan = async (include) => {
		const files = [];
		await inventoryFilePaths(root, include, [path.join(root, 'unusual-checkout')], new AbortController().signal,
			(file, relative) => { assert.equal(file, path.join(root, relative)); files.push(relative); });
		return files.sort();
	};
	assert.deepEqual(await scan(false), ['src/first\nsecond.php', 'vendor/Hidden.php']);
	assert.deepEqual(await scan(true), ['src/first\nsecond.php', 'unusual-checkout/Linked.php', 'vendor/Hidden.php', 'worktrees/branch/Linked.php']);
});

test('bounded enumeration detects overflow only after another file, keeping complete filenames', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'source-observer-bounded-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const names = ['first\nsecond.php', 'данные.php'];
	await Promise.all(names.map((name) => writeFile(path.join(root, name), '')));
	const signal = new AbortController().signal;
	const exact = await collectFilePaths(root, false, [], signal, 2);
	assert.deepEqual(exact.paths.sort(), names.sort());
	assert.equal(exact.truncated, false);
	const capped = await collectFilePaths(root, false, [], signal, 1);
	assert.equal(capped.paths.length, 1);
	assert.ok(names.includes(capped.paths[0]));
	assert.equal(capped.truncated, true);
});

test('an explicitly selected worktree root stays searchable while nested worktrees remain excluded', async (t) => {
	const parent = await mkdtemp(path.join(os.tmpdir(), 'source-observer-selected-worktree-'));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = path.join(parent, 'worktrees', 'selected');
	await mkdir(path.join(root, 'worktrees', 'nested'), { recursive: true });
	await writeFile(path.join(root, 'Source.php'), '');
	await writeFile(path.join(root, 'worktrees', 'nested', 'Skip.php'), '');
	const files = [];
	const signal = new AbortController().signal;
	await inventoryFilePaths(root, false, [], signal, (_file, relative) => files.push(relative));
	assert.deepEqual(files, ['Source.php']);
	assert.deepEqual((await collectFilePaths(root, false, [], signal, 10)).paths, ['Source.php']);
});
