import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import type { DocumentRecovery } from '../documents/index.ts';

/** Local crash/close recovery beside plugin data, never part of settings or project files. */
export class DocumentRecoveryJournal {
	private filePath: string;
	private readable = true;
	constructor(filePath: string) { this.filePath = filePath; }
	read(): DocumentRecovery[] {
		if (!existsSync(this.filePath)) return [];
		let input: unknown;
		try {
			input = JSON.parse(readFileSync(this.filePath, 'utf8'));
			if (!Array.isArray(input)) throw new Error('Invalid document recovery journal.');
			if (!input.every(isRecovery)) throw new Error('Invalid document recovery entry.');
		} catch (error) { this.readable = false; throw error; }
		return input;
	}
	write(documents: DocumentRecovery[]) {
		if (!this.readable) throw new Error('Resolve the existing recovery journal before replacing it.');
		if (documents.length) {
			const temporary = `${this.filePath}.tmp`;
			try { writeFileSync(temporary, JSON.stringify(documents), { encoding: 'utf8', mode: 0o600 }); renameSync(temporary, this.filePath); }
			finally { if (existsSync(temporary)) unlinkSync(temporary); }
		}
		else if (existsSync(this.filePath)) unlinkSync(this.filePath);
	}
}

function isRecovery(entry: unknown): entry is DocumentRecovery {
	return !!entry && typeof entry === 'object'
		&& 'path' in entry && typeof entry.path === 'string' && 'text' in entry && typeof entry.text === 'string'
		&& 'baseline' in entry && typeof entry.baseline === 'string' && 'revision' in entry
		&& typeof entry.revision === 'number' && Number.isInteger(entry.revision) && entry.revision > 0;
}
