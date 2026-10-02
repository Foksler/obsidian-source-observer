import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { createIntelephenseSettings, findWorkspaceComposerRoots } from '../src/lspWorkspaceRoots.ts';

it('finds nested Composer roots lazily and excludes generic and registered worktrees by default', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'source-observer-roots-'));
	try {
		const appRoot = path.join(root, 'predictions');
		const conventionalWorktree = path.join(root, 'worktrees', 'copy');
		const linkedWorktree = path.join(root, 'linked-copy');
		await mkdir(appRoot, { recursive: true });
		await mkdir(conventionalWorktree, { recursive: true });
		await writeFile(path.join(appRoot, 'composer.json'), '{}');
		await writeFile(path.join(conventionalWorktree, 'composer.json'), '{}');

		execFileSync('git', ['-C', root, 'init', '-q']);
		execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
		execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
		await writeFile(path.join(root, 'tracked.txt'), 'tracked');
		execFileSync('git', ['-C', root, 'add', 'tracked.txt']);
		execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
		execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', linkedWorktree, 'HEAD']);
		await writeFile(path.join(linkedWorktree, 'composer.json'), '{}');

		assert.deepEqual(await findWorkspaceComposerRoots(root), [appRoot]);
		assert.deepEqual((await findWorkspaceComposerRoots(root, true)).sort(), [appRoot, conventionalWorktree, linkedWorktree].sort());
		const defaultSettings = await createIntelephenseSettings(root);
		assert.ok(defaultSettings.files.exclude.includes('linked-copy/**'));
		assert.equal(defaultSettings.telemetry.enabled, false);
		assert.equal(defaultSettings.environment.phpVersion, '8.4');
		assert.equal(defaultSettings.files.maxSize, 5_000_000);
		const inclusiveSettings = await createIntelephenseSettings(root, true);
		assert.equal(inclusiveSettings.files.exclude.some((glob) => glob.includes('worktrees')), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('finds registered worktrees when the selected parent is not itself a Git repository', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'source-observer-container-'));
	const repository = path.join(root, 'predictions');
	const linked = path.join(root, 'predictions-author-stats');
	try {
		await mkdir(repository, { recursive: true });
		execFileSync('git', ['-C', repository, 'init', '-q']);
		execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid']);
		execFileSync('git', ['-C', repository, 'config', 'user.name', 'Test']);
		await writeFile(path.join(repository, 'tracked.txt'), 'tracked');
		execFileSync('git', ['-C', repository, 'add', 'tracked.txt']);
		execFileSync('git', ['-C', repository, 'commit', '-qm', 'fixture']);
		execFileSync('git', ['-C', repository, 'worktree', 'add', '-q', '--detach', linked, 'HEAD']);
		await writeFile(path.join(repository, 'composer.json'), '{}');
		await writeFile(path.join(linked, 'composer.json'), '{}');

		assert.deepEqual(await findWorkspaceComposerRoots(root), [repository]);
		assert.deepEqual((await findWorkspaceComposerRoots(root, true)).sort(), [linked, repository].sort());
		assert.ok((await createIntelephenseSettings(repository)).files.exclude.every((glob) => !glob.startsWith('../')));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
