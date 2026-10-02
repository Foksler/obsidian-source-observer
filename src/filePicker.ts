import { App, Notice, SuggestModal } from 'obsidian';
import * as path from 'path';
import { getRegisteredWorktrees } from './searchEngine';
import { searchFilePathIndex } from './filePathIndex';

export interface FilePickerOptions {
	includeWorktrees: boolean;
	showHidden: boolean;
}

/** Files from the selected source folder, independent of PHP indexing and sidebar filters. */
export class FilePicker extends SuggestModal<string> {
	private sequence = 0;
	private closed = false;
	private latest: string[] = [];
	private worktrees: Promise<string[]>;

	constructor(app: App, private rootPath: string, private options: FilePickerOptions,
		private select: (filePath: string) => void, private didClose: () => void) {
		super(app);
		this.limit = 100;
		this.emptyStateText = 'No matching files in the selected folder.';
		this.setPlaceholder('Go to file…');
		this.setInstructions([
			{ command: '↑↓', purpose: 'Select file' },
			{ command: '↵', purpose: 'Open file' },
			{ command: 'esc', purpose: 'Close' },
		]);
		this.modalEl.addClass('so-file-picker');
		this.worktrees = getRegisteredWorktrees(rootPath).catch(() => []);
	}

	async getSuggestions(query: string): Promise<string[]> {
		const sequence = ++this.sequence;
		try {
			const { files } = await searchFilePathIndex(this.rootPath, query, {
				...this.options,
				matchMode: 'fuzzy',
				limit: this.limit,
				worktreeRoots: await this.worktrees,
			});
			if (this.closed) return [];
			if (sequence !== this.sequence) return this.latest;
			this.latest = files;
			return files;
		} catch {
			if (this.closed) return [];
			if (sequence !== this.sequence) return this.latest;
			new Notice('Could not search files. Try opening the folder again.');
			this.latest = [];
			return [];
		}
	}

	renderSuggestion(filePath: string, el: HTMLElement) {
		el.createDiv({ cls: 'so-file-picker-name', text: path.basename(filePath) });
		el.createDiv({ cls: 'so-file-picker-path', text: path.relative(this.rootPath, filePath) });
	}

	onChooseSuggestion(filePath: string) { this.select(filePath); }

	onClose() {
		this.closed = true;
		++this.sequence;
		this.didClose();
	}
}
