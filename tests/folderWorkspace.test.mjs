import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { closeFolderWorkspace, normalizeFolderWorkspace } from '../src/folderWorkspace.ts';

const folder = (value) => path.resolve(value);

test('migrates a legacy last-opened folder when no folder list was saved', () => {
	assert.deepEqual(normalizeFolderWorkspace(undefined, '/workspace/project'), {
		paths: [folder('/workspace/project')],
		activePath: folder('/workspace/project'),
	});
});

test('preserves an explicitly empty folder list instead of migrating the last path', () => {
	assert.deepEqual(normalizeFolderWorkspace([], '/workspace/project'), { paths: [], activePath: '' });
	assert.deepEqual(normalizeFolderWorkspace({ openedFolderPaths: [] }, '/workspace/project'), { paths: [], activePath: '' });
});

test('normalizes and deduplicates folder paths while selecting the last-opened member', () => {
	const result = normalizeFolderWorkspace(
		['/workspace/project', '/workspace/other', '/workspace/./project', ''],
		'/workspace/other',
	);
	assert.deepEqual(result, {
		paths: [folder('/workspace/project'), folder('/workspace/other')],
		activePath: folder('/workspace/other'),
	});
});

test('falls back to the first saved folder when last-opened is not in the list', () => {
	assert.deepEqual(normalizeFolderWorkspace(['/workspace/a', '/workspace/b'], '/workspace/missing'), {
		paths: [folder('/workspace/a'), folder('/workspace/b')],
		activePath: folder('/workspace/a'),
	});
});

test('closing an active folder selects the tab at the same index or the previous final tab', () => {
	const paths = ['/workspace/a', '/workspace/b', '/workspace/c'].map(folder);
	assert.deepEqual(closeFolderWorkspace(paths, paths[1], paths[1]), {
		paths: [paths[0], paths[2]],
		activePath: paths[2],
	});
	assert.deepEqual(closeFolderWorkspace(paths, paths[2], paths[2]), {
		paths: [paths[0], paths[1]],
		activePath: paths[1],
	});
});

test('closing an inactive folder keeps the active folder and closing the last clears it', () => {
	const paths = ['/workspace/a', '/workspace/b'].map(folder);
	assert.deepEqual(closeFolderWorkspace(paths, paths[1], paths[0]), {
		paths: [paths[1]],
		activePath: paths[1],
	});
	assert.deepEqual(closeFolderWorkspace([paths[1]], paths[1], paths[1]), { paths: [], activePath: '' });
});

test('closing an unknown folder leaves the normalized workspace unchanged', () => {
	const paths = ['/workspace/a', '/workspace/b'].map(folder);
	assert.deepEqual(closeFolderWorkspace(paths, paths[1], '/workspace/missing'), {
		paths,
		activePath: paths[1],
	});
});
