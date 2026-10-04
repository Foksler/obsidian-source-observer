import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inventoryFilePaths } from '../src/fileInventory.ts';

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
