import { promises as fsp } from 'fs';
import * as path from 'path';
import { Component, FileSystemAdapter, MarkdownRenderer, type App } from 'obsidian';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

export function isMarkdownFile(filePath: string): boolean {
	return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Files inside the vault render with their vault path so embeds resolve as in reading view. */
function vaultSourcePath(app: App, filePath: string): string {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) return '';
	const relative = path.relative(adapter.getBasePath(), filePath);
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return '';
	return relative.split(path.sep).join('/');
}

/** Read-only rendering of a Markdown file with Obsidian's reading view styles. */
export class MarkdownPreview extends Component {
	private app: App;
	private rendered: Component | null = null;

	constructor(app: App) {
		super();
		this.app = app;
	}

	/** Replaces the container's content unless `isCurrent` reports a newer request. */
	async show(container: HTMLElement, filePath: string, isCurrent: () => boolean): Promise<void> {
		let markdown: string;
		try {
			markdown = await fsp.readFile(filePath, 'utf-8');
		} catch {
			markdown = '(cannot read file)';
		}
		if (!isCurrent()) return;
		this.clear();
		container.empty();
		const view = container.createDiv({ cls: 'so-markdown-preview markdown-preview-view markdown-rendered' });
		const sizer = view.createDiv({ cls: 'markdown-preview-sizer markdown-preview-section' });
		const rendered = this.addChild(new Component());
		this.rendered = rendered;
		await MarkdownRenderer.render(this.app, markdown, sizer, vaultSourcePath(this.app, filePath), rendered);
	}

	/** Unloads children registered by the last render, such as embeds and code block processors. */
	clear() {
		if (this.rendered) this.removeChild(this.rendered);
		this.rendered = null;
	}
}
