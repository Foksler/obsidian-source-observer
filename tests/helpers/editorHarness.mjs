import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Real DOM + CodeMirror; only the host-specific icon adapter is replaced.
export async function editorHarness() {
 const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
 const window = dom.window;
 for (const key of ['window', 'document', 'Window', 'MutationObserver', 'HTMLElement', 'Element', 'Node', 'Range', 'DOMRect']) globalThis[key] = key === 'window' ? window : window[key];
 globalThis.getComputedStyle = window.getComputedStyle.bind(window);
 globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
 globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
 globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
 window.Range.prototype.getClientRects = () => [];
 window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
 window.HTMLElement.prototype.addClass = function (...names) { this.classList.add(...names); };
 window.HTMLElement.prototype.empty = function () { this.replaceChildren(); };
 const temp = await mkdtemp(path.join(process.cwd(), 'tests', '.editor-dom-'));
 const outfile = path.join(temp, 'editor.mjs');
 await build({ entryPoints: ['tests/helpers/codePaneAdapter.ts'], bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile,
  plugins: [{ name: 'host-icons', setup(api) {
   api.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host' }));
   api.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ contents: 'export function setIcon() {}' }));
  } }] });
 const { CodePane } = await import(pathToFileURL(outfile).href);
 return { CodePane, container() { const el = window.document.createElement('div'); window.document.body.append(el); return el; },
  async dispose() { dom.window.close(); await rm(temp, { recursive: true, force: true }); } };
}
