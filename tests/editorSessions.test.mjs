import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const tempDir = await mkdtemp(path.join(process.cwd(), 'tests', '.editor-sessions-'));
const bundlePath = path.join(tempDir, 'editorSessions.mjs');
await build({
	stdin: {
		contents: `export { CodePane, cloneCodePaneSession } from './src/codePane.ts';\nexport { EditorTabs, cloneEditorTabsState } from './src/editorTabs.ts';`,
		resolveDir: process.cwd(),
		sourcefile: 'editor-sessions-test-entry.ts',
	},
	bundle: true,
	packages: 'external',
	platform: 'node',
	format: 'esm',
	outfile: bundlePath,
	plugins: [{
		name: 'obsidian-test-shim',
		setup(buildApi) {
			buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-shim', namespace: 'test-shim' }));
			buildApi.onLoad({ filter: /.*/, namespace: 'test-shim' }, () => ({ contents: 'export function setIcon() {}', loader: 'js' }));
		},
	}],
});
const { CodePane, cloneCodePaneSession, EditorTabs, cloneEditorTabsState } = await import(pathToFileURL(bundlePath).href);

test.after(async () => rm(tempDir, { recursive: true, force: true }));

function fakeElement() {
	return {
		addClass() {}, setAttribute() {}, addEventListener() {}, empty() {},
		createDiv() { return fakeElement(); },
		createEl() { return fakeElement(); },
	};
}

function deferred() {
	let resolve;
	const promise = new Promise((res) => { resolve = res; });
	return { promise, resolve };
}

test('deleting a file closes its code and diff once, preserving other active tabs', () => {
 const selected = []; let empties = 0;
 const tabs = new EditorTabs(fakeElement(), tab => selected.push(tab), () => { empties++; });
 tabs.show({ filePath: '/keep.ts', kind: 'code' });
 tabs.show({ filePath: '/delete.ts', kind: 'code' });
 tabs.show({ filePath: '/delete.ts', kind: 'diff' });
 tabs.closeFile('/delete.ts');
 assert.deepEqual(selected, [{ filePath: '/keep.ts', kind: 'code' }]);
 assert.deepEqual(tabs.captureState(), { tabs: selected, active: selected[0] });
 tabs.show({ filePath: '/background.ts', kind: 'code' });
 tabs.show({ filePath: '/keep.ts', kind: 'code' });
 tabs.closeFile('/background.ts');
 assert.equal(selected.length, 1);
 assert.equal(tabs.getActive().filePath, '/keep.ts');
 tabs.closeFile('/keep.ts');
 assert.equal(empties, 1);
 assert.deepEqual(tabs.captureState(), { tabs: [], active: null });
});

test('forgetting a deleted file removes cursor/history and cancels its pending read', () => {
 const pane = new CodePane(fakeElement(), 15, 'obsidian', () => {});
 const deleted = { filePath: '/delete.ts', pos: 2, scrollTop: 3 };
 const kept = { filePath: '/keep.ts', pos: 4, scrollTop: 5 };
 pane.restoreSession({ currentPath: deleted.filePath, currentLocation: deleted,
  fileLocations: [deleted, kept], history: [kept, deleted], forwardHistory: [deleted] });
 pane.pendingPath = deleted.filePath;
 const request = pane.openRequestId;
 pane.forgetFile(deleted.filePath);
 assert.ok(pane.openRequestId > request);
 assert.deepEqual(pane.captureSession(), { currentPath: null, currentLocation: null,
  fileLocations: [kept], history: [kept], forwardHistory: [] });
});

test('forgetting the last code file preserves a visible unrelated diff and another pending open', () => {
 const container = fakeElement(); let clears = 0;
 container.empty = () => { clears++; };
 const pane = new CodePane(container, 15, 'obsidian', () => {});
 pane.currentPath = '/deleted.ts'; pane.pendingPath = '/next.ts';
 const request = pane.openRequestId;
 pane.forgetFile('/deleted.ts');
 assert.equal(clears, 0);
 assert.equal(pane.openRequestId, request);
 assert.equal(pane.pendingPath, '/next.ts');
 assert.equal(pane.getCurrentFile(), null);
});

test('CodePane snapshots live cursor, saved files, and both navigation stacks as detached serializable data', () => {
	const pane = new CodePane(fakeElement(), 15, 'cursor-monokai', () => {});
	pane.currentPath = '/vault/active.php';
	pane.fileLocations.set('/vault/other.php', { filePath: '/vault/other.php', pos: 23, scrollTop: 81 });
	pane.history.push({ filePath: '/vault/previous.php', pos: 5, scrollTop: 10 });
	pane.forwardHistory.push({ filePath: '/vault/forward.php', pos: 17, scrollTop: 40 });
	pane.view = {
		state: { selection: { main: { head: 101 } } },
		scrollDOM: { scrollTop: 330 },
		destroy() {},
	};

	const session = pane.captureSession();
	assert.equal(session.currentLocation.filePath, '/vault/active.php');
	assert.deepEqual(session.currentLocation, { filePath: '/vault/active.php', pos: 101, scrollTop: 330 });
	assert.equal(session.fileLocations.find(({ filePath }) => filePath === '/vault/other.php').pos, 23);
	assert.equal(session.history[0].filePath, '/vault/previous.php');
	assert.equal(session.forwardHistory[0].filePath, '/vault/forward.php');
	assert.doesNotThrow(() => JSON.stringify(session));

	session.fileLocations[0].pos = -1;
	assert.notEqual(pane.fileLocations.get(session.fileLocations[0].filePath).pos, -1);
});

test('CodePane restore invalidates pending opens and replaces folder navigation without opening a file', () => {
	const container = fakeElement();
	const pane = new CodePane(container, 15, 'cursor-monokai', () => {});
	let destroyed = 0;
	pane.currentPath = '/old-folder/old.php';
	pane.history.push({ filePath: '/old-folder/prior.php', pos: 4, scrollTop: 0 });
	pane.view = { state: { selection: { main: { head: 9 } } }, scrollDOM: { scrollTop: 12 }, destroy() { destroyed++; } };
	const pendingRequestId = pane.openRequestId;
	const incoming = {
		currentPath: '/new-folder/active.php',
		currentLocation: { filePath: '/new-folder/active.php', pos: 88, scrollTop: 44 },
		fileLocations: [{ filePath: '/new-folder/active.php', pos: 88, scrollTop: 44 }],
		history: [{ filePath: '/new-folder/prior.php', pos: 7, scrollTop: 21 }],
		forwardHistory: [],
	};

	pane.restoreSession(incoming);
	assert.equal(destroyed, 1);
	assert.equal(pane.view, null);
	assert.ok(pane.openRequestId > pendingRequestId);
	assert.equal(pane.currentPath, '/new-folder/active.php');
	assert.deepEqual(pane.history, incoming.history);
	assert.deepEqual(pane.forwardHistory, []);
	assert.equal(pane.fileLocations.has('/old-folder/old.php'), false);
	assert.equal(pane.fileLocations.get('/new-folder/active.php').pos, 88);
});

test('cancelled navigation cannot move a same-path editor restored by another folder session', async (t) => {
	const cases = [
		{
			name: 'goBack',
			start(pane, target) { pane.history.push({ filePath: target, pos: 3, scrollTop: 10 }); return pane.goBack(); },
		},
		{
			name: 'goForward',
			start(pane, target) { pane.forwardHistory.push({ filePath: target, pos: 3, scrollTop: 10 }); return pane.goForward(); },
		},
		{
			name: 'restoreLocation',
			start(pane, target) { return pane.restoreLocation({ filePath: target, line: 1, column: 4, scrollTop: 10 }); },
		},
	];

	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			const pane = new CodePane(fakeElement(), 15, 'cursor-monokai', () => {});
			const target = '/shared/nested/active.php';
			const pendingOpen = deferred();
			pane.currentPath = '/old/session/current.php';
			pane.view = { state: { doc: { length: 200 }, selection: { main: { head: 70 } } }, scrollDOM: { scrollTop: 700 }, dispatch() { throw new Error('Old view should not receive navigation'); } };
			pane.open = async () => pendingOpen.promise;
			const navigation = scenario.start(pane, target);

			// A folder restore has since opened the same absolute path with its own location.
			let staleDispatches = 0;
			pane.currentPath = target;
			pane.view = {
				state: { doc: { length: 200 }, selection: { main: { head: 140 } } },
				scrollDOM: { scrollTop: 990 },
				dispatch() { staleDispatches++; },
			};
			pendingOpen.resolve(null);

			assert.equal(await navigation, false);
			assert.equal(staleDispatches, 0);
			assert.equal(pane.view.scrollDOM.scrollTop, 990);
		});
	}
});

test('EditorTabs captures and restores a detached active-tab state without selection callbacks', () => {
	let selections = 0;
	let empties = 0;
	const tabs = new EditorTabs(fakeElement(), () => selections++, () => empties++);
	tabs.show({ filePath: '/one/A.php', kind: 'code' });
	tabs.show({ filePath: '/one/A.php', kind: 'diff' });
	const state = tabs.captureState();
	assert.deepEqual(state, {
		tabs: [{ filePath: '/one/A.php', kind: 'code' }, { filePath: '/one/A.php', kind: 'diff' }],
		active: { filePath: '/one/A.php', kind: 'diff' },
	});
	assert.deepEqual(cloneEditorTabsState(null), { tabs: [], active: null });
	assert.doesNotThrow(() => JSON.stringify(state));

	tabs.restoreState({
		tabs: [{ filePath: '/two/B.php', kind: 'code' }],
		active: { filePath: '/two/B.php', kind: 'code' },
	});
	assert.deepEqual(tabs.getActive(), { filePath: '/two/B.php', kind: 'code' });
	assert.equal(selections, 0);
	assert.equal(empties, 0);

	state.tabs[0].filePath = '/mutated.php';
	assert.equal(tabs.captureState().tabs[0].filePath, '/two/B.php');
});
