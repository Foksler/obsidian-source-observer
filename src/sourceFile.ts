import { promises as fsp, readFileSync, writeFileSync } from 'fs';

export interface SourceText {
	content: string;
	/** Whether saving can write back exactly the bytes that were read. */
	editable: boolean;
}

/** Reads a file as UTF-8 text; null when it cannot be read. */
export async function readSourceText(filePath: string): Promise<SourceText | null> {
	try {
		const bytes = await fsp.readFile(filePath);
		const content = bytes.toString('utf8');
		// Binary or non-UTF-8 files would be corrupted by a save, so they stay read-only.
		return { content, editable: Buffer.from(content, 'utf8').equals(bytes) };
	} catch {
		return null;
	}
}

/**
 * The line break the editor joins lines with. CRLF is used only when every
 * line uses it; otherwise LF, so a stray `\r` stays an ordinary character and
 * the file is written back unchanged.
 */
export function lineBreakFor(content: string): '\n' | '\r\n' {
	return content.includes('\r\n') && !/(^|[^\r])\n/.test(content) ? '\r\n' : '\n';
}

export type SaveResult = 'saved' | 'changed' | 'missing';

/**
 * Writes `text` only while the file still holds `expected`, so a change made
 * elsewhere (a terminal agent, git) is never overwritten unseen. Synchronous,
 * so a save cannot interleave with a file switch or a reload.
 */
export function saveIfUnchanged(filePath: string, text: string, expected: string): SaveResult {
	let current: string;
	try {
		current = readFileSync(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
		throw error;
	}
	if (current !== expected) return 'changed';
	writeSourceText(filePath, text);
	return 'saved';
}

export function writeSourceText(filePath: string, text: string): void {
	writeFileSync(filePath, text, 'utf8');
}
