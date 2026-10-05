import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { encodeLspMessage, stdioTransport, takeLspMessages } from '../src/lspTransport.ts';

function fakeProcess({ exitCode = null, killed = false } = {}) {
	const proc = new EventEmitter();
	proc.exitCode = exitCode;
	proc.killed = killed;
	proc.stdin = new PassThrough();
	proc.stdout = new PassThrough();
	proc.stderr = new PassThrough();
	return proc;
}

describe('LSP stdio framing', () => {
	it('answers the selected adapter configuration and leaves other sections empty', async () => {
		const proc = fakeProcess();
		const transport = stdioTransport(proc, async () => ({ directoryFilters: ['-**/worktrees'] }), 'gopls');
		const received = [];
		transport.subscribe((message) => received.push(message));
		proc.stdout.write(encodeLspMessage(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'workspace/configuration',
			params: { items: [{ section: 'gopls' }, { section: 'intelephense' }, {}] } })));
		await new Promise((resolve) => setImmediate(resolve));
		const { messages } = takeLspMessages(proc.stdin.read());
		assert.deepEqual(JSON.parse(messages[0]).result, [{ directoryFilters: ['-**/worktrees'] }, null, { directoryFilters: ['-**/worktrees'] }]);
		assert.deepEqual(received, []);
		proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy();
	});

	it('uses UTF-8 byte length rather than JavaScript character count', () => {
		const encoded = encodeLspMessage('{"text":"λ🙂"}');
		const separator = encoded.indexOf('\r\n\r\n');
		const declared = Number(/Content-Length: (\d+)/.exec(encoded.subarray(0, separator).toString('ascii'))?.[1]);
		assert.equal(declared, Buffer.byteLength('{"text":"λ🙂"}', 'utf8'));
	});

	it('keeps partial messages and parses multiple complete messages', () => {
		const first = encodeLspMessage('{"id":1}');
		const second = encodeLspMessage('{"id":2}');
		const split = first.length - 3;
		const partial = takeLspMessages(Buffer.concat([first.subarray(0, split)]));
		assert.deepEqual(partial.messages, []);
		const rest = takeLspMessages(Buffer.concat([partial.rest, first.subarray(split), second]));
		assert.deepEqual(rest.messages, ['{"id":1}', '{"id":2}']);
		assert.equal(rest.rest.length, 0);
	});

	it('ignores notifications after process exit and rejects a dead-server request', async () => {
		const proc = fakeProcess({ exitCode: 1, killed: true });
		const transport = stdioTransport(proc, async () => ({}));
		const received = [];
		transport.subscribe((message) => received.push(JSON.parse(message)));
		assert.doesNotThrow(() => transport.send(JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/didClose' })));
		assert.doesNotThrow(() => transport.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'textDocument/hover' })));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(received.length, 1);
		assert.equal(received[0].id, 7);
		assert.match(received[0].error.message, /not running/);
		proc.stdin.destroy();
		proc.stdout.destroy();
		proc.stderr.destroy();
	});

	it('rejects in-flight requests after unsubscribe without an unhandled stream error', async () => {
		const proc = fakeProcess();
		const transport = stdioTransport(proc, async () => ({}));
		const received = [];
		const handler = (message) => received.push(JSON.parse(message));
		transport.subscribe(handler);
		transport.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'textDocument/definition' }));
		transport.unsubscribe(handler);
		proc.exitCode = 1;
		proc.emit('exit', 1, null);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(received.length, 1);
		assert.equal(received[0].id, 9);
		assert.match(received[0].error.message, /not running/);
		proc.stdin.destroy();
		proc.stdout.destroy();
		proc.stderr.destroy();
	});
});
