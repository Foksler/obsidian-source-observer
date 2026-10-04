import { spawn } from 'child_process';
import { constants as fsConstants } from 'fs';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RgOutput { text: string; truncated: boolean; }

let rgExecutablePromise: Promise<string | null> | null = null;

export function resolveRgExecutable(): Promise<string | null> {
	if (!rgExecutablePromise) {
		rgExecutablePromise = (async () => {
			const home = os.homedir();
			const candidates = [
				...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'rg')),
				'/opt/homebrew/bin/rg',
				'/usr/local/bin/rg',
				'/usr/bin/rg',
				'/opt/local/bin/rg',
				'/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg',
				'/Applications/Cursor - Insiders.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg',
				'/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg',
				'/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg',
				path.join(home, 'Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg'),
				path.join(home, 'Applications/Cursor - Insiders.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg'),
				path.join(home, 'Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg'),
				path.join(home, 'Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg'),
				path.join(home, '.local/bin/rg'),
				path.join(home, '.cargo/bin/rg'),
			];
			for (const candidate of [...new Set(candidates)]) {
				try {
					await fsp.access(candidate, fsConstants.X_OK);
					return candidate;
				} catch { /* Try the next conventional location. */ }
			}
			return null;
		})();
	}
	return rgExecutablePromise;
}

export async function runRipgrep(args: string[], signal: AbortSignal, maxBytes = 8 * 1024 * 1024, cwd?: string): Promise<RgOutput> {
	if (signal.aborted) throw new Error('Search cancelled');
	const executable = await resolveRgExecutable();
	if (signal.aborted) throw new Error('Search cancelled');
	if (!executable) {
		const error = new Error('ripgrep executable was not found') as NodeJS.ErrnoException;
		error.code = 'ENOENT';
		throw error;
	}
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let stdout = '';
		let stderr = '';
		let bytes = 0;
		let truncated = false;
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			if (truncated) return;
			const chunkBytes = Buffer.byteLength(chunk, 'utf8');
			if (bytes + chunkBytes <= maxBytes) {
				stdout += chunk;
				bytes += chunkBytes;
				return;
			}
			const remaining = Math.max(0, maxBytes - bytes);
			stdout += Buffer.from(chunk).subarray(0, remaining).toString('utf8');
			truncated = true;
			child.kill();
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => { stderr += chunk; });
		child.once('error', reject);
		child.once('close', (code) => {
			signal.removeEventListener('abort', abort);
			if (signal.aborted) reject(new Error('Search cancelled'));
			else if (truncated || code === 0 || code === 1) resolve({ text: stdout, truncated });
			else reject(new Error(stderr.trim() || `rg exited with code ${code}`));
		});
		const abort = () => child.kill();
		if (signal.aborted) abort();
		else signal.addEventListener('abort', abort, { once: true });
	});
}

/** Consume JSON events without collecting or cutting off the complete result stream. */
export async function streamRipgrep(args: string[], signal: AbortSignal, line: (json: string) => void, separator = '\n', cwd?: string): Promise<void> {
	if (signal.aborted) throw new Error('Search cancelled');
	const executable = await resolveRgExecutable();
	if (signal.aborted) throw new Error('Search cancelled');
	if (!executable) throw Object.assign(new Error('ripgrep executable was not found'), { code: 'ENOENT' });
	await new Promise<void>((resolve, reject) => {
		const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let buffer = '';
		let stderr = '';
		let failed = false;
		const abort = () => child.kill();
		const cleanup = () => signal.removeEventListener('abort', abort);
		const consume = (value: string) => {
			try { line(value); }
			catch (error) { failed = true; cleanup(); child.kill(); reject(error instanceof Error ? error : new Error(String(error))); }
		};
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			if (signal.aborted || failed) return;
			buffer += chunk;
			let end: number;
			while ((end = buffer.indexOf(separator)) >= 0) {
				consume(buffer.slice(0, end));
				if (failed) return;
				buffer = buffer.slice(end + separator.length);
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-65536); });
		child.once('error', (error) => { failed = true; cleanup(); reject(error); });
		child.once('close', (code) => {
			cleanup();
			if (failed) return;
			if (signal.aborted) { reject(new Error('Search cancelled')); return; }
			if (buffer) consume(buffer);
			if (failed) return;
			if (code === 0 || code === 1) resolve();
			else reject(new Error(stderr.trim() || `rg exited with code ${code}`));
		});
		if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
	});
}
