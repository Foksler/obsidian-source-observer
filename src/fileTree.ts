import { promises as fsp } from 'fs';
import * as path from 'path';
import { setIcon } from 'obsidian';
import { setFolderIcon } from './folderIcons';
import { getRegisteredWorktrees } from './searchEngine';
import { FILE_SEARCH_RESULTS_CAP, searchFilePathIndex } from './filePathIndex.ts';
import { refreshTree, type TreeNode } from './fileTreeRefresh';

/** Maximum number of search results before showing a "more results" hint. */
export const SEARCH_RESULTS_CAP = FILE_SEARCH_RESULTS_CAP;

// [lucide icon name, css colour class]
const EXT_ICON: Record<string, [string, string]> = {
	ts:    ['file-code-2', 'so-icon-ts'],
	tsx:   ['file-code-2', 'so-icon-ts'],
	js:    ['file-code-2', 'so-icon-js'],
	jsx:   ['file-code-2', 'so-icon-js'],
	mjs:   ['file-code-2', 'so-icon-js'],
	cjs:   ['file-code-2', 'so-icon-js'],
	py:    ['file-code-2', 'so-icon-py'],
	rs:    ['file-code-2', 'so-icon-rs'],
	go:    ['file-code-2', 'so-icon-go'],
	rb:    ['file-code-2', 'so-icon-rb'],
	java:  ['file-code-2', 'so-icon-java'],
	c:     ['file-code-2', 'so-icon-c'],
	cpp:   ['file-code-2', 'so-icon-c'],
	cs:    ['file-code-2', 'so-icon-c'],
	css:   ['paintbrush',  'so-icon-css'],
	scss:  ['paintbrush',  'so-icon-css'],
	less:  ['paintbrush',  'so-icon-css'],
	html:  ['code',        'so-icon-html'],
	htm:   ['code',        'so-icon-html'],
	xml:   ['code',        'so-icon-html'],
	vue:   ['code',        'so-icon-vue'],
	svelte:['code',        'so-icon-svelte'],
	json:  ['braces',      'so-icon-json'],
	jsonc: ['braces',      'so-icon-json'],
	yaml:  ['braces',      'so-icon-json'],
	yml:   ['braces',      'so-icon-json'],
	toml:  ['braces',      'so-icon-json'],
	md:    ['file-text',   'so-icon-md'],
	mdx:   ['file-text',   'so-icon-md'],
	txt:   ['file-text',   'so-icon-txt'],
	sh:    ['terminal',    'so-icon-sh'],
	bash:  ['terminal',    'so-icon-sh'],
	zsh:   ['terminal',    'so-icon-sh'],
	fish:  ['terminal',    'so-icon-sh'],
	env:   ['lock',        'so-icon-env'],
	png:   ['image',       'so-icon-img'],
	jpg:   ['image',       'so-icon-img'],
	jpeg:  ['image',       'so-icon-img'],
	gif:   ['image',       'so-icon-img'],
	svg:   ['image',       'so-icon-img'],
	webp:  ['image',       'so-icon-img'],
	ico:   ['image',       'so-icon-img'],
	php:   ['file-code-2', 'so-icon-php'],
};

function fileIcon(name: string): [string, string] {
	const ext = name.split('.').pop()?.toLowerCase() ?? '';
	return EXT_ICON[ext] ?? ['file', 'so-icon-default'];
}

/** Renders a lazy-expanding directory tree and notifies the caller when a file is selected. */
export class FileTree {
	private container: HTMLElement;
	private showHidden: boolean;
	private onSelect: (filePath: string) => void;
	private rootPath = '';
	private treeRoot: TreeNode | null = null;
	private searchSeq = 0;
	private loadSeq = 0;
	private refreshSeq = 0;
	private searchQuery = '';
	private disposed = false;
	private includeWorktrees = false;
	private worktreeRoots: string[] | null = null;
	private selectedPath: { path: string; isDirectory: boolean } | null = null;

	constructor(
		container: HTMLElement,
		showHidden: boolean,
		onSelect: (filePath: string) => void,
		private onPathSelect?: (selection: { path: string; isDirectory: boolean }) => void,
	) {
		this.container = container;
		container.setAttribute('role', 'tree');
		container.setAttribute('aria-label', 'Source files');
		this.showHidden = showHidden;
		this.onSelect = onSelect;
	}

	/** Updates hidden-file visibility and re-renders if the value changed. */
	setShowHidden(showHidden: boolean) {
		if (this.showHidden === showHidden) return;
		this.showHidden = showHidden;
		this.treeRoot = null;
		if (this.rootPath) void this.loadPath(this.rootPath);
	}

	/** Includes conventional and Git-registered nested worktrees in tree operations. */
	setIncludeWorktrees(includeWorktrees: boolean) {
		if (this.includeWorktrees === includeWorktrees) return;
		this.includeWorktrees = includeWorktrees;
		this.treeRoot = null;
		if (this.rootPath) void this.loadPath(this.rootPath);
	}

	/** Loads `dirPath` as the new root and re-renders the tree. */
	async loadPath(dirPath: string) {
		const seq = ++this.loadSeq;
		this.searchSeq++;
		this.searchQuery = '';
		if (dirPath !== this.rootPath) this.selectedPath = null;
		this.rootPath = dirPath;
		this.treeRoot = null;
		this.worktreeRoots = [];
		this.container.empty();
		if (!dirPath || this.disposed) return;
		const discoveredWorktrees = await getRegisteredWorktrees(dirPath);
		if (seq !== this.loadSeq || this.disposed) return;
		this.worktreeRoots = await this.normalizeWorktreeRoots(dirPath, discoveredWorktrees);
		if (seq !== this.loadSeq || this.disposed) return;
		const treeRoot = await this.buildNode(dirPath, true, seq);
		if (!treeRoot || seq !== this.loadSeq || this.disposed) return;
		this.treeRoot = treeRoot;
		this.renderTree();
	}

	/** Update paths on disk while retaining disclosure, selection, focus and scroll. */
	async refresh() {
		const root = this.treeRoot;
		if (!root || this.disposed) return;
		const generation = this.loadSeq, request = ++this.refreshSeq;
		const refreshed = await refreshTree(root, (dir) => this.readDir(dir, generation));
		if (this.disposed || generation !== this.loadSeq || request !== this.refreshSeq || root !== this.treeRoot) return;
		if (!refreshed.changed && !this.searchQuery) return;
		const selection = this.selectedPath;
		let selectionExists = true;
		if (selection) {
			try { await fsp.access(selection.path); }
			catch { selectionExists = false; }
		}
		if (this.disposed || generation !== this.loadSeq || request !== this.refreshSeq || root !== this.treeRoot) return;
		this.treeRoot = refreshed.node;
		if (!selectionExists && this.selectedPath === selection) this.selectedPath = null;
		const active = this.container.ownerDocument.activeElement;
		const focusedPath = this.container.contains(active) ? (active as HTMLElement | null)?.dataset?.path : undefined;
		const scrollTop = this.container.scrollTop;
		if (this.searchQuery) await this.search(this.searchQuery);
		else this.renderTree();
		if (this.disposed || generation !== this.loadSeq || request !== this.refreshSeq) return;
		if (focusedPath) {
			const rows = Array.from(this.container.querySelectorAll<HTMLElement>('.so-tree-row'));
			const focused = rows.find((row) => row.dataset.path === focusedPath);
			(focused ?? rows.find((row) => row.tabIndex === 0))?.focus({ preventScroll: true });
		}
		this.container.scrollTop = scrollTop;
	}

	getSelectedPath() { return this.selectedPath ? { ...this.selectedPath } : null; }
	hasFocus() { return this.container.contains(this.container.ownerDocument.activeElement); }

	/** Reveal the current file without opening it again or changing the editor. */
	async reveal(filePath: string): Promise<boolean> {
		this.refreshSeq++;
		let node = this.treeRoot;
		if (!node || this.disposed) return false;
		const target = path.resolve(filePath), relative = path.relative(this.rootPath, target);
		if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
		const generation = this.loadSeq, request = ++this.searchSeq;
		const current = () => !this.disposed && generation === this.loadSeq && request === this.searchSeq;
		const ancestors: TreeNode[] = [];
		for (const part of relative.split(path.sep)) {
			if (!node.isDir) return false;
			ancestors.push(node);
			if (!node.children?.some((child) => child.name === part)) {
				const children = await this.readDir(node.fullPath, generation);
				if (!current()) return false;
				node.children = children;
			}
			const child: TreeNode | undefined = node.children?.find((entry) => entry.name === part);
			if (!child) return false;
			node = child;
		}
		if (!current() || node.isDir) return false;
		for (const ancestor of ancestors) ancestor.expanded = true;
		this.selectedPath = { path: target, isDirectory: false };
		this.renderTree();
		const row = Array.from(this.container.querySelectorAll<HTMLElement>('.so-tree-row')).find((item) => item.dataset.path === target);
		row?.focus({ preventScroll: true });
		row?.scrollIntoView({ block: 'nearest' });
		return !!row;
	}

	private prepareRow(row: HTMLElement, filePath: string, isDirectory: boolean) {
		row.dataset.path = filePath; row.dataset.directory = String(isDirectory);
		row.setAttribute('role', 'treeitem');
		row.setAttribute('aria-selected', String(this.selectedPath?.path === filePath));
		row.tabIndex = this.selectedPath?.path === filePath || (!this.selectedPath && filePath === this.rootPath) ? 0 : -1;
		row.toggleClass('so-tree-row-active', this.selectedPath?.path === filePath);
		const select = () => {
			const changed = this.selectedPath?.path !== filePath;
			this.selectedPath = { path: filePath, isDirectory };
			for (const item of Array.from(this.container.querySelectorAll<HTMLElement>('.so-tree-row'))) {
				item.toggleClass('so-tree-row-active', item === row); item.tabIndex = item === row ? 0 : -1;
				item.setAttribute('aria-selected', String(item === row));
			}
			if (changed) this.onPathSelect?.({ ...this.selectedPath });
		};
		row.addEventListener('focus', select);
		row.addEventListener('click', () => { select(); row.focus(); });
		row.addEventListener('keydown', (event) => {
			if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
			const rows = Array.from(this.container.querySelectorAll<HTMLElement>('.so-tree-row')).filter((item) => !item.closest('.so-tree-children-hidden'));
			const index = rows.indexOf(row);
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
			} else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); }
			else if (event.key === 'ArrowRight' && isDirectory) {
				event.preventDefault(); if (row.getAttribute('aria-expanded') !== 'true') row.click(); else rows[index + 1]?.focus();
			} else if (event.key === 'ArrowLeft') {
				event.preventDefault(); if (isDirectory && row.getAttribute('aria-expanded') === 'true') row.click();
				else rows.find((item) => item.dataset.path === path.dirname(filePath))?.focus();
			}
		});
	}

	dispose() {
		this.disposed = true;
		this.loadSeq++;
		this.searchSeq++;
		this.container.empty();
	}

	/** Filters the tree to files whose name contains `query`; clears filter when query is empty. */
	async search(query: string) {
		const seq = ++this.searchSeq;
		this.searchQuery = query;
		if (this.disposed) return;
		if (!this.rootPath) {
			this.container.empty();
			this.container.createEl('span', { cls: 'so-search-empty', text: 'Open a folder first.' });
			return;
		}
		if (query.length === 0) {
			this.renderTree();
			return;
		}
		const { files: matches, truncated } = await searchFilePathIndex(this.rootPath, query, {
			matchMode: 'fuzzy',
			includeWorktrees: this.includeWorktrees,
			showHidden: this.showHidden,
			limit: SEARCH_RESULTS_CAP,
			worktreeRoots: this.worktreeRoots ?? [],
		});
		// A newer keystroke already replaced the list — drop stale results.
		if (seq !== this.searchSeq || this.disposed) return;
		this.container.empty();
		if (matches.length === 0) {
			this.container.createEl('span', { cls: 'so-search-empty', text: 'No results' });
			return;
		}
		for (const fullPath of matches) {
			const rel = path.relative(this.rootPath, fullPath);
			const row = this.container.createDiv({ cls: 'so-tree-row so-tree-file' });
			this.prepareRow(row, fullPath, false);
			row.setCssProps({ '--so-indent': '6px' });
			row.createSpan({ cls: 'so-tree-chevron', attr: { 'aria-hidden': 'true' } });
			const iconEl = row.createSpan({ cls: 'so-tree-icon' });
			const [icon, cls] = fileIcon(path.basename(fullPath));
			setIcon(iconEl, icon);
			iconEl.addClass(cls);
			row.createSpan({ cls: 'so-tree-label', text: rel });
			row.title = fullPath;
			row.addEventListener('click', () => {
				this.container.querySelectorAll('.so-tree-row-active').forEach((el) =>
					el.removeClass('so-tree-row-active'),
				);
				row.addClass('so-tree-row-active');
				this.onSelect(fullPath);
			});
		}
		if (truncated) {
			this.container.createEl('span', {
				cls: 'so-search-more',
				text: `More than ${SEARCH_RESULTS_CAP} results — refine your search…`,
			});
		}
	}

	private async normalizeWorktreeRoots(root: string, worktrees: string[]): Promise<string[]> {
		let canonicalRoot = path.resolve(root);
		try { canonicalRoot = await fsp.realpath(root); } catch { /* Keep the selected path if it disappeared. */ }
		return Promise.all(worktrees.map(async (worktree) => {
			let canonicalWorktree = path.resolve(worktree);
			try { canonicalWorktree = await fsp.realpath(worktree); } catch { /* Keep the discovered path. */ }
			const relative = path.relative(canonicalRoot, canonicalWorktree);
			return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
				? path.resolve(root, relative)
				: canonicalWorktree;
		}));
	}

	private isWorktreePath(dir: string): boolean {
		const rel = path.relative(this.rootPath, dir).split(path.sep).filter(Boolean);
		if (rel.some((part, index) =>
			(part === '.worktrees' || part === 'worktrees') ||
			(part === '.claude' && rel[index + 1] === 'worktrees'),
		)) return true;
		return (this.worktreeRoots ?? []).some((worktree) => dir === worktree || dir.startsWith(`${worktree}${path.sep}`));
	}

	private renderTree() {
		this.container.empty();
		if (this.treeRoot) this.renderNode(this.treeRoot, this.container, 0);
	}

	private async buildNode(fullPath: string, expanded = false, generation = this.loadSeq): Promise<TreeNode | null> {
		if (generation !== this.loadSeq || this.disposed) return null;
		const name = path.basename(fullPath) || fullPath;
		let isDir = false;
		try {
			const stat = await fsp.lstat(fullPath);
			if (generation !== this.loadSeq || this.disposed) return null;
			if (stat.isSymbolicLink()) return { name, fullPath, isDir: false };
			isDir = stat.isDirectory();
		} catch {
			if (generation !== this.loadSeq || this.disposed) return null;
			return { name, fullPath, isDir: false };
		}
		const node: TreeNode = { name, fullPath, isDir, expanded };
		if (isDir && expanded) node.children = await this.readDir(fullPath, generation);
		return node;
	}

	private async readDir(dirPath: string, generation = this.loadSeq): Promise<TreeNode[]> {
		if (generation !== this.loadSeq || this.disposed) return [];
		if (!this.includeWorktrees && this.isWorktreePath(dirPath)) return [];
		let entries: string[];
		try { entries = await fsp.readdir(dirPath); } catch { return []; }
		if (generation !== this.loadSeq || this.disposed) return [];
		if (!this.showHidden) entries = entries.filter((e) => !e.startsWith('.'));
		const visibleEntries = this.includeWorktrees
			? entries
			: entries.filter((name) => !this.isWorktreePath(path.join(dirPath, name)));
		const loadedNodes = await Promise.all(visibleEntries.map((name) => this.buildNode(path.join(dirPath, name), false, generation)));
		const nodes = loadedNodes.filter((node): node is TreeNode => node !== null);
		if (generation !== this.loadSeq || this.disposed) return [];
		return nodes.sort((a, b) => {
			if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	private renderNode(node: TreeNode, parent: HTMLElement, depth: number) {
		const row = parent.createDiv({ cls: 'so-tree-row' });
		this.prepareRow(row, node.fullPath, node.isDir);
		row.setCssProps({ '--so-indent': `${depth * 14 + 6}px` });

		const chevron = row.createSpan({ cls: 'so-tree-chevron', attr: { 'aria-hidden': 'true' } });
		const iconEl = row.createSpan({ cls: 'so-tree-icon', attr: { 'aria-hidden': 'true' } });

		if (node.isDir) {
			row.setAttribute('aria-expanded', String(!!node.expanded));
			row.addClass('so-tree-dir');
			setIcon(chevron, node.expanded ? 'chevron-down' : 'chevron-right');
			setFolderIcon(iconEl, node.name, !!node.expanded);
			row.createSpan({ cls: 'so-tree-label', text: node.name });

			const childContainer = parent.createDiv({ cls: 'so-tree-children' });
			if (!node.expanded) childContainer.addClass('so-tree-children-hidden');
			if (node.expanded && node.children) {
				for (const child of node.children) this.renderNode(child, childContainer, depth + 1);
			}

			row.addEventListener('click', () => {
				this.refreshSeq++;
				node.expanded = !node.expanded;
				row.setAttribute('aria-expanded', String(node.expanded));
				setIcon(chevron, node.expanded ? 'chevron-down' : 'chevron-right');
				setFolderIcon(iconEl, node.name, node.expanded);
				if (node.expanded) {
					childContainer.removeClass('so-tree-children-hidden');
					if (!node.children) {
						const generation = this.loadSeq;
						void this.readDir(node.fullPath, generation).then((children) => {
							if (generation !== this.loadSeq || this.disposed) return;
							node.children = children;
							childContainer.empty();
							for (const child of children) this.renderNode(child, childContainer, depth + 1);
						});
						return;
					}
					childContainer.empty();
					for (const child of node.children) this.renderNode(child, childContainer, depth + 1);
				} else {
					childContainer.addClass('so-tree-children-hidden');
				}
			});
		} else {
			row.addClass('so-tree-file');
			const [icon, cls] = fileIcon(node.name);
			setIcon(iconEl, icon);
			iconEl.addClass(cls);
			row.createSpan({ cls: 'so-tree-label', text: node.name });
			row.addEventListener('click', () => {
				this.container.querySelectorAll('.so-tree-row-active').forEach((el) =>
					el.removeClass('so-tree-row-active'),
				);
				row.addClass('so-tree-row-active');
				this.onSelect(node.fullPath);
			});
		}
	}
}
