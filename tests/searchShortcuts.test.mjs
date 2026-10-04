import assert from 'node:assert/strict';
import test from 'node:test';
import { bindShortcuts, normalizeShortcuts, shortcutFromEvent, sameShortcut } from '../src/searchShortcuts.ts';

test('shortcut migration clones defaults, preserves cleared keys and rejects modifier-only or plain typing bindings', () => {
	const first = normalizeShortcuts({ quickOpen: null, findInFiles: { key: 'Shift', modifiers: [] }, findInFile: { key: 's', modifiers: [] } });
	assert.equal(first.quickOpen, null);
	assert.deepEqual(first.findInFiles, { key: 'f', modifiers: ['Mod', 'Shift'] });
	assert.deepEqual(first.findInFile, { key: 'f', modifiers: ['Mod'] });
	first.findInFiles.modifiers.push('Alt');
	assert.deepEqual(normalizeShortcuts(undefined).findInFiles.modifiers, ['Mod', 'Shift']);
});

test('shortcut capture maps Cmd/Ctrl by platform and conflict comparison ignores modifier order', () => {
	const key = { key: 'G', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true };
	assert.deepEqual(shortcutFromEvent(key, true), { key: 'g', modifiers: ['Mod', 'Shift'] });
	assert.deepEqual(shortcutFromEvent({ ...key, ctrlKey: true, metaKey: false }, false), { key: 'g', modifiers: ['Mod', 'Shift'] });
	assert.equal(shortcutFromEvent({ ...key, key: 'Shift', metaKey: false }, true), null);
	assert.deepEqual(shortcutFromEvent({ ...key, code: 'KeyG', key: '©', altKey: true, shiftKey: false }, true), { key: 'g', modifiers: ['Mod', 'Alt'] });
	assert.equal(sameShortcut({ key: 'G', modifiers: ['Shift', 'Mod'] }, { key: 'g', modifiers: ['Mod', 'Shift'] }), true);
});

test('changed shortcuts remove every old scope handler and invoke only the assigned action', () => {
	const handlers = new Map(); const called = [];
	const scope = { register(modifiers, key, fn) { const token = [...modifiers, key].join('+'); handlers.set(token, fn); return token; }, unregister(token) { handlers.delete(token); } };
	const config = normalizeShortcuts(undefined);
	const clear = bindShortcuts(scope, config, new Proxy({}, { get: (_, key) => () => called.push(key) }));
	assert.equal(handlers.get('Mod+Shift+f')(), false);
	assert.deepEqual(called, ['findInFiles']);
	clear(); assert.equal(handlers.size, 0);
	config.findInFiles = { modifiers: ['Mod', 'Alt'], key: 'g' };
	bindShortcuts(scope, config, {});
	assert.equal(handlers.has('Mod+Shift+f'), false); assert.equal(handlers.has('Mod+Alt+g'), true);
});

test('macOS Option shortcuts bind normal letters but recognize the emitted symbols without swallowing other keys', () => {
	const handlers = new Map(), called = [];
	const scope = { register(modifiers, key, fn) { const token = [...modifiers, key ?? '*'].join('+'); handlers.set(token, fn); return token; }, unregister(token) { handlers.delete(token); } };
	const config = normalizeShortcuts(undefined);
	config.findInFiles = { modifiers: ['Mod', 'Alt'], key: 'g' };
	const clear = bindShortcuts(scope, config, new Proxy({}, { get: (_, key) => () => called.push(key) }), true);
	const handler = handlers.get('Mod+Alt+*');
	const event = { metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, code: 'KeyG', key: '©' };
	assert.equal(handler(event), false);
	assert.equal(handler({ ...event, code: 'KeyO', key: 'ø' }), false);
	assert.deepEqual(called, ['findInFiles', 'documentSymbols']);
	assert.equal(handler({ ...event, code: 'KeyK', key: '˚' }), undefined);
	clear(); assert.equal(handlers.size, 0);
});
