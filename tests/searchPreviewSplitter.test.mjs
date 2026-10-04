import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/verticalSplitter.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { addVerticalSplitter } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function setup(options = {}) {
	const handlers = new Map(), cleanups = [], attrs = {}, props = {};
	let capture = null;
	const handle = {
		ownerDocument: { defaultView: {} },
		focus() {},
		setAttribute: (name, value) => { attrs[name] = value; },
		setPointerCapture: id => { capture = id; },
		hasPointerCapture: id => capture === id,
		releasePointerCapture: () => { capture = null; },
	};
	const body = { createDiv: () => handle, getBoundingClientRect: () => ({ top: 100, height: 600 }),
		setCssProps: values => Object.assign(props, values) };
	const lifecycle = { register: fn => cleanups.push(fn), registerDomEvent: (_, key, fn) => {
		handlers.set(key, fn); cleanups.push(() => handlers.delete(key));
	} };
	addVerticalSplitter(lifecycle, body, options);
	const event = (values = {}) => ({ button: 0, buttons: 1, pointerId: 7, preventDefault() {}, stopPropagation() {}, ...values });
	return { handlers, props, attrs, event, capture: () => capture, unload: () => cleanups.forEach(fn => fn()) };
}

test('dragging respects minimum pane sizes and ignores other pointers; cancellation stops resizing', () => {
	const { handlers, props, attrs, event, capture } = setup();
	handlers.get('pointerdown')(event());
	assert.equal(capture(), 7);
	handlers.get('pointermove')(event({ clientY: 400 }));
	assert.equal(props['--so-search-results-size'], '50%');
	handlers.get('pointermove')(event({ clientY: 500, pointerId: 8 }));
	assert.equal(props['--so-search-results-size'], '50%');
	handlers.get('pointermove')(event({ clientY: 2000 }));
	assert.ok(parseFloat(props['--so-search-results-size']) < 74);
	assert.equal(attrs['aria-valuenow'], '74');
	handlers.get('pointermove')(event({ clientY: -1000 }));
	assert.equal(props['--so-search-results-size'], '15%');
	handlers.get('pointercancel')(event());
	assert.equal(capture(), null);
	handlers.get('pointermove')(event({ clientY: 400 }));
	assert.equal(props['--so-search-results-size'], '15%');
});

test('keyboard resizing works and closing mid-drag releases capture and removes listeners', () => {
	const { handlers, props, event, capture, unload } = setup();
	handlers.get('keydown')(event({ key: 'ArrowUp' }));
	assert.equal(props['--so-search-results-size'], '37%');
	handlers.get('keydown')(event({ key: 'ArrowDown' }));
	assert.equal(props['--so-search-results-size'], '42%');
	handlers.get('pointerdown')(event());
	unload();
	assert.equal(capture(), null);
	assert.equal(handlers.size, 0);
});


test('Git pane grows when dragging the divider up and restores keyboard direction from the bottom', () => {
 const { handlers, props, event, attrs, unload } = setup({ label: 'Resize Git changes', sizeProperty: '--so-git-size', fromBottom: true, initial: 40, minLast: 80 });
 handlers.get('pointerdown')(event());
 handlers.get('pointermove')(event({ clientY: 280 }));
 assert.equal(props['--so-git-size'], '70%');
 handlers.get('pointermove')(event({ clientY: 580 }));
 assert.equal(props['--so-git-size'], '20%');
 handlers.get('pointerup')(event());
 handlers.get('keydown')(event({ key: 'ArrowUp' }));
 assert.equal(props['--so-git-size'], '25%');
 assert.equal(attrs['aria-valuenow'], '25');
 unload();
});

test('Git starts at its minimum and grows on the first keyboard step', () => {
	const { handlers, props, event } = setup({ sizeProperty: '--so-git-size', fromBottom: true,
		initial: 0, minLast: 80, minRatio: 0, maxRatio: 100 });
	handlers.get('keydown')(event({ key: 'ArrowUp' }));
	assert.ok(Math.abs(parseFloat(props['--so-git-size']) - (80 / 600 * 100 + 5)) < 0.001);
	handlers.get('keydown')(event({ key: 'ArrowDown' }));
	assert.ok(Math.abs(parseFloat(props['--so-git-size']) - 80 / 600 * 100) < 0.001);
});

test('a missed pointerup cannot keep dragging on hover or restart without another press', () => {
	const { handlers, props, event, capture } = setup();
	handlers.get('pointermove')(event({ clientY: 400, buttons: 0 }));
	assert.deepEqual(props, {});
	handlers.get('pointerdown')(event());
	handlers.get('pointermove')(event({ clientY: 400 }));
	handlers.get('pointermove')(event({ clientY: 500, buttons: 0 }));
	assert.equal(capture(), null);
	assert.equal(props['--so-search-results-size'], '50%');
	handlers.get('pointermove')(event({ clientY: 600 }));
	assert.equal(props['--so-search-results-size'], '50%');
	handlers.get('pointerdown')(event());
	handlers.get('pointermove')(event({ clientY: 460 }));
	assert.equal(props['--so-search-results-size'], '60%');
});

test('release and window blur stop dragging; other pointers do not end the gesture', () => {
	const { handlers, props, event, capture } = setup();
	handlers.get('pointerdown')(event());
	handlers.get('pointerup')(event({ pointerId: 8 }));
	assert.equal(capture(), 7);
	handlers.get('pointerup')(event({ buttons: 0 }));
	assert.equal(capture(), null);
	handlers.get('pointermove')(event({ clientY: 400 }));
	assert.deepEqual(props, {});
	handlers.get('pointerdown')(event());
	handlers.get('blur')();
	assert.equal(capture(), null);
	handlers.get('pointermove')(event({ clientY: 500 }));
	assert.deepEqual(props, {});
});

test('Git divider can move below 15 percent and above 80 percent while keeping both panes usable', () => {
	const { handlers, props, event } = setup({ sizeProperty: '--so-git-size', fromBottom: true,
		initial: 40, minLast: 80, minRatio: 0, maxRatio: 100 });
	handlers.get('pointerdown')(event());
	handlers.get('pointermove')(event({ clientY: 1000 }));
	assert.ok(parseFloat(props['--so-git-size']) < 15);
	assert.ok(parseFloat(props['--so-git-size']) * 6 >= 80);
	handlers.get('pointermove')(event({ clientY: 0 }));
	assert.ok(parseFloat(props['--so-git-size']) > 80);
	assert.ok(600 - parseFloat(props['--so-git-size']) * 6 >= 88);
});
