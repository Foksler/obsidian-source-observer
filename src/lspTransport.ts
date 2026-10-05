import type { ChildProcess } from 'child_process';
import type { Transport } from '@codemirror/lsp-client';

export interface LspMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
}

/** Parse complete Content-Length framed messages, retaining any partial tail. */
export function takeLspMessages(buffer: Buffer): { messages: string[]; rest: Buffer } {
	const messages: string[] = [];
	let rest = buffer;
	for (;;) {
		const sep = rest.indexOf('\r\n\r\n');
		if (sep < 0) break;
		const header = /(?:^|\r\n)Content-Length\s*:\s*(\d+)/i.exec(rest.subarray(0, sep).toString('ascii'));
		const start = sep + 4;
		if (!header) {
			rest = rest.subarray(start);
			continue;
		}
		const size = Number(header[1]);
		if (!Number.isSafeInteger(size) || size < 0) {
			rest = rest.subarray(start);
			continue;
		}
		const end = start + size;
		if (rest.length < end) break;
		messages.push(rest.subarray(start, end).toString('utf8'));
		rest = rest.subarray(end);
	}
	return { messages, rest };
}

export function encodeLspMessage(message: string): Buffer {
	const body = Buffer.from(message, 'utf8');
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Answers the adapter's settings request before it reaches CodeMirror's LSP
 * client, which treats server-initiated requests as unsupported.
 */
export function answerWorkspaceConfiguration(
	proc: ChildProcess,
	message: string,
	settings: () => Promise<unknown>,
	section = '',
): boolean {
	let req: LspMessage;
	try { req = JSON.parse(message) as LspMessage; } catch { return false; }
	if (req.method !== 'workspace/configuration' || req.id === undefined) return false;
	const params = req.params as { items?: { section?: string }[] } | undefined;
	const sendResult = (intelephenseSettings: unknown) => {
		if (proc.exitCode !== null || proc.killed || !proc.stdin?.writable) return;
		const result = (params?.items ?? []).map((item) => (!item.section || item.section === section) ? intelephenseSettings : null);
		proc.stdin.write(encodeLspMessage(JSON.stringify({ jsonrpc: '2.0', id: req.id, result })));
	};
	try { void settings().then(sendResult, () => sendResult(null)); }
	catch { sendResult(null); }
	return true;
}

/** LSP over stdio with bounded buffering and safe event delivery. */
export function stdioTransport(proc: ChildProcess, settings: () => Promise<unknown>, section = ''): Transport {
	const handlers = new Set<(value: string) => void>();
	const pendingRequests = new Map<string, Set<(value: string) => void>>();
	let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let closed = false;
	const requestKey = (id: string | number) => `${typeof id}:${id}`;
	const deliver = (message: string, targets: Iterable<(value: string) => void>) => {
		queueMicrotask(() => { for (const handler of targets) handler(message); });
	};
	const failRequest = (id: string | number, error: unknown) => {
		const key = requestKey(id);
		const targets = pendingRequests.get(key);
		if (!targets) return;
		pendingRequests.delete(key);
		const message = JSON.stringify({
			jsonrpc: '2.0', id,
			error: { code: -32000, message: error instanceof Error ? error.message : 'Language server is not running' },
		});
		deliver(message, targets);
	};
	const failAll = (error: Error) => {
		closed = true;
		for (const key of [...pendingRequests.keys()]) {
			const [type, ...rest] = key.split(':');
			const value = rest.join(':');
			const id = type === 'number' ? Number(value) : value;
			failRequest(id, error);
		}
	};
	const isDead = () => closed || proc.exitCode !== null || proc.killed || !proc.stdin?.writable;
	const processClosedError = () => new Error('Language server is not running');
	proc.once('exit', () => failAll(processClosedError()));
	proc.once('close', () => failAll(processClosedError()));
	proc.once('error', (error) => failAll(error));
	proc.stdin?.on('error', (error) => failAll(error));
	proc.stdout?.on('data', (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		const parsed = takeLspMessages(buffer);
		buffer = parsed.rest;
		for (const message of parsed.messages) {
			try {
				const value = JSON.parse(message) as LspMessage;
				if (value.id !== undefined && !value.method) pendingRequests.delete(requestKey(value.id));
			} catch { /* Let the LSP client report malformed server responses. */ }
			if (answerWorkspaceConfiguration(proc, message, settings, section)) continue;
			for (const handler of handlers) handler(message);
		}
	});
	return {
		send(message: string) {
			let value: LspMessage | null = null;
			try { value = JSON.parse(message) as LspMessage; } catch { /* Forward valid transport payloads below. */ }
			const isRequest = value?.method !== undefined && value.id !== undefined;
			if (handlers.size === 0 && !isRequest) return;
			if (isDead()) {
				if (isRequest && value?.id !== undefined) {
					deliver(JSON.stringify({ jsonrpc: '2.0', id: value.id, error: { code: -32000, message: 'Language server is not running' } }), handlers);
				}
				return;
			}
			const targets = isRequest ? new Set(handlers) : null;
			if (isRequest && value?.id !== undefined && targets) pendingRequests.set(requestKey(value.id), targets);
			const stdin = proc.stdin;
			if (!stdin?.writable) {
				closed = true;
				if (isRequest && value?.id !== undefined) failRequest(value.id, processClosedError());
				return;
			}
			try {
				stdin.write(encodeLspMessage(message), (error?: Error | null) => {
					if (error && isRequest && value?.id !== undefined) failRequest(value.id, error);
				});
			} catch (error) {
				if (isRequest && value?.id !== undefined) failRequest(value.id, error);
				else closed = true;
			}
		},
		subscribe(handler) { handlers.add(handler); },
		unsubscribe(handler) { handlers.delete(handler); },
	};
}
