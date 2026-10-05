import * as path from 'path';
import { realpathSync } from 'fs';
import type { SearchResultGroup } from './searchEngine.ts';

interface RgJsonEvent {
	type: string;
	data?: {
		path?: { text?: string };
		lines?: { text?: string };
		line_number?: number;
		submatches?: Array<{ start: number }>;
	};
}

function canonical(value: string): string {
	try { return realpathSync(value); } catch { return path.resolve(value); }
}

/** Reuse path resolution across the events of one search, including symlinked roots. */
export function createRgParser(root?: string): (line: string, limit?: number) => SearchResultGroup | null {
	const canonicalRoot = root ? canonical(root) : '';
	const paths = new Map<string, string>();
	const resolve = (raw: string) => {
		if (!root) return raw;
		const cached = paths.get(raw);
		if (cached) return cached;
		const candidate = path.resolve(root, raw);
		const local = path.relative(root, candidate);
		let filePath = candidate;
		if (local === '..' || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)) {
			const relative = path.relative(canonicalRoot, canonical(candidate));
			if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) filePath = path.resolve(root, relative);
		}
		paths.set(raw, filePath);
		return filePath;
	};
	return (line, limit = Infinity) => {
		let event: RgJsonEvent;
		try { event = JSON.parse(line) as RgJsonEvent; } catch { return null; }
		if (event?.type !== 'match') return null;
		const data = event.data;
		if (data?.path?.text === undefined || data.lines?.text === undefined || typeof data.line_number !== 'number') return null;
		const filePath = resolve(data.path.text);
		const text = data.lines.text.replace(/[\r\n]+$/, '');
		// ASCII byte offsets already are UTF-16 columns. Decode only non-ASCII lines.
		const utf8 = Buffer.byteLength(text, 'utf8') === text.length ? null : Buffer.from(text, 'utf8');
		const matches = [];
		for (const submatch of data.submatches ?? []) {
			if (matches.length >= limit) break;
			const column = utf8 ? utf8.subarray(0, submatch.start).toString('utf8').length + 1 : submatch.start + 1;
			matches.push({ filePath, line: data.line_number, column, text });
		}
		return { filePath, matches };
	};
}

export function parseRgJson(output: string, limit = 1000, root?: string): SearchResultGroup[] {
	const parse = createRgParser(root);
	const groups = new Map<string, SearchResultGroup>();
	let count = 0;
	for (const line of output.split(/\r?\n/)) {
		if (count >= limit) break;
		const group = parse(line, limit - count);
		if (!group) continue;
		const previous = groups.get(group.filePath);
		if (previous) for (const match of group.matches) previous.matches.push(match);
		else groups.set(group.filePath, group);
		count += group.matches.length;
	}
	return [...groups.values()];
}
