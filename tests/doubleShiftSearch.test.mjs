import assert from 'node:assert/strict';
import test from 'node:test';
import { registerDoubleShiftSearch } from '../src/searchMode.ts';

function setup(docked = false) {
	const listeners = new Map();
	const body = {}, html = {}, editor = {}, sidebar = {}, otherPane = {}, window = {};
	let modal = false, enabled = true, active = true, opened = 0;
	const document = { body, documentElement: html, defaultView: window, querySelector() { return modal ? {} : null; } };
	const root = { ownerDocument: document, contains(node) { return node === editor || node === root; } };
	registerDoubleShiftSearch({ registerDomEvent(target, type, callback, capture) { listeners.set(type, { target, callback, capture }); } },
		root, () => enabled, () => active, () => opened++,
		(target) => root.contains(target) || (docked && target === sidebar));
	const event = (target, key = 'Shift') => ({ target, key, repeat: false, ctrlKey: false, metaKey: false, altKey: false });
	const tap = (target) => {
		listeners.get('keydown').callback(event(target));
		listeners.get('keyup').callback(event(target));
	};
	return { listeners, document, window, body, html, editor, sidebar, otherPane, tap, event,
		opened: () => opened, modal: (value) => { modal = value; },
		enabled: (value) => { enabled = value; }, active: (value) => { active = value; } };
}

test('double Shift recognizes a focused tree moved outside the main source view', () => {
	const h = setup(true);
	h.active(false);
	h.tap(h.sidebar); h.tap(h.sidebar);
	assert.equal(h.opened(), 1);
	h.tap(h.otherPane); h.tap(h.otherPane);
	assert.equal(h.opened(), 1);
	h.modal(true); h.tap(h.sidebar); h.tap(h.sidebar);
	assert.equal(h.opened(), 1);
});

test('double Shift works when an active source view has focus on the document body', () => {
	const h = setup();
	h.tap(h.body); h.tap(h.body);
	assert.equal(h.opened(), 1);
	h.tap(h.editor); h.tap(h.editor);
	assert.equal(h.opened(), 2);
	assert.equal(h.listeners.get('keydown').capture, true);
	assert.equal(h.listeners.get('keyup').capture, true);
	assert.equal(h.listeners.get('keydown').target, h.window);
	assert.equal(h.listeners.get('keyup').target, h.window);
});

test('editor focus opens search even while Obsidian has a stale active leaf', () => {
	const h = setup();
	h.active(false);
	h.tap(h.editor); h.tap(h.editor);
	assert.equal(h.opened(), 1);
	h.tap(h.body); h.tap(h.body);
	assert.equal(h.opened(), 1);
});

test('shortcut ignores other panes, dialogs, inactive views and VS Code mode', () => {
	const h = setup();
	h.tap(h.otherPane); h.tap(h.otherPane);
	h.modal(true); h.tap(h.body); h.tap(h.body);
	h.modal(false); h.active(false); h.tap(h.body); h.tap(h.body);
	h.active(true); h.enabled(false); h.tap(h.editor); h.tap(h.editor);
	assert.equal(h.opened(), 0);
	h.enabled(true); h.tap(h.editor); h.tap(h.editor);
	assert.equal(h.opened(), 1);
});

test('typing and switching windows cancel half-completed Shift gestures', () => {
	const h = setup();
	h.tap(h.editor);
	h.listeners.get('keydown').callback(h.event(h.editor, 'A'));
	h.tap(h.editor);
	assert.equal(h.opened(), 0);
	h.listeners.get('blur').callback();
	h.tap(h.body);
	assert.equal(h.opened(), 0);
	h.tap(h.body);
	assert.equal(h.opened(), 1);
});
