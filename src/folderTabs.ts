import * as path from 'path';

/** Accessible tab strip for open source folders. */
export class FolderTabs {
	private paths: string[] = [];
	private activePath = '';
	private disposed = false;
	private readonly keydownHandler = (event: KeyboardEvent) => this.onKeydown(event);

	constructor(
		private readonly container: HTMLElement,
		private readonly onSelect: (folderPath: string) => void,
		private readonly onClose: (folderPath: string) => void,
	) {
		container.classList.add('so-folder-tabs');
		container.setAttribute('role', 'tablist');
		container.setAttribute('aria-label', 'Open folders');
		container.addEventListener('keydown', this.keydownHandler);
	}

	setFolders(paths: string[], activePath: string): void {
		if (this.disposed) return;
		const focused = this.focusedTab();
		const seen = new Set<string>();
		this.paths = paths
			.filter((folderPath): folderPath is string => typeof folderPath === 'string' && folderPath.trim().length > 0)
			.map((folderPath) => path.resolve(folderPath))
			.filter((folderPath) => {
				if (seen.has(folderPath)) return false;
				seen.add(folderPath);
				return true;
			});
		const requestedActive = typeof activePath === 'string' && activePath.trim() ? path.resolve(activePath) : '';
		this.activePath = this.paths.includes(requestedActive) ? requestedActive : (this.paths[0] ?? '');
		this.render();
		this.revealActive();

		if (focused && this.paths.length) {
			const focusPath = this.paths.includes(focused.folderPath) ? focused.folderPath : this.activePath;
			const selector = focused.part === 'close' ? '.so-folder-tab-close' : '.so-folder-tab-select';
			const button = this.findButton(focusPath, selector);
			(button ?? this.findButton(this.activePath, '.so-folder-tab-select'))?.focus();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.container.removeEventListener('keydown', this.keydownHandler);
		this.container.replaceChildren();
	}

	private render(): void {
		this.container.replaceChildren();
		if (this.paths.length === 0) {
			const empty = this.container.ownerDocument.createElement('span');
			empty.className = 'so-folder-tabs-empty';
			empty.textContent = 'No open folders';
			this.container.append(empty);
			return;
		}

		const labels = this.labelsForPaths();
		for (const folderPath of this.paths) {
			const selected = folderPath === this.activePath;
			const wrapper = this.container.ownerDocument.createElement('div');
			wrapper.className = `so-folder-tab${selected ? ' so-folder-tab-active' : ''}`;

			const select = this.container.ownerDocument.createElement('button');
			select.type = 'button';
			select.className = 'so-folder-tab-select';
			select.setAttribute('role', 'tab');
			select.setAttribute('aria-selected', String(selected));
			select.tabIndex = selected ? 0 : -1;
			select.dataset.folderPath = folderPath;
			select.title = folderPath;
			select.textContent = labels.get(folderPath) ?? path.basename(folderPath);
			select.addEventListener('click', () => this.selectFolder(folderPath));

			const close = this.container.ownerDocument.createElement('button');
			close.type = 'button';
			close.className = 'so-folder-tab-close';
			close.dataset.folderPath = folderPath;
			close.textContent = '×';
			close.setAttribute('aria-label', `Close ${labels.get(folderPath) ?? path.basename(folderPath)}`);
			close.title = `Close ${folderPath}`;
			close.addEventListener('click', (event) => {
				event.stopPropagation();
				this.onClose(folderPath);
			});

			wrapper.append(select, close);
			this.container.append(wrapper);
		}
	}

	private labelsForPaths(): Map<string, string> {
		const labels = new Map<string, string>();
		const nameCounts = new Map<string, number>();
		for (const folderPath of this.paths) {
			const basename = path.basename(folderPath) || folderPath;
			const key = basename.toLocaleLowerCase();
			nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
		}
		for (const folderPath of this.paths) {
			const basename = path.basename(folderPath) || folderPath;
			const duplicate = (nameCounts.get(basename.toLocaleLowerCase()) ?? 0) > 1;
			labels.set(folderPath, duplicate
				? `${basename} — ${path.basename(path.dirname(folderPath)) || path.dirname(folderPath)}`
				: basename);
		}

		const labelCounts = new Map<string, number>();
		for (const label of labels.values()) {
			const key = label.toLocaleLowerCase();
			labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
		}
		for (const folderPath of this.paths) {
			const label = labels.get(folderPath) ?? folderPath;
			if ((labelCounts.get(label.toLocaleLowerCase()) ?? 0) > 1) {
				labels.set(folderPath, `${path.basename(folderPath) || folderPath} — ${path.dirname(folderPath)}`);
			}
		}
		return labels;
	}

	private selectFolder(folderPath: string): void {
		if (!this.paths.includes(folderPath)) return;
		this.activePath = folderPath;
		this.updateSelection();
		this.revealActive();
		this.onSelect(folderPath);
	}

	private revealActive(): void {
		this.findButton(this.activePath, '.so-folder-tab-select')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	private updateSelection(): void {
		for (const wrapper of Array.from(this.container.querySelectorAll<HTMLElement>('.so-folder-tab'))) {
			const select = wrapper.querySelector<HTMLButtonElement>('.so-folder-tab-select');
			const selected = select?.dataset.folderPath === this.activePath;
			wrapper.classList.toggle('so-folder-tab-active', Boolean(selected));
			select?.setAttribute('aria-selected', String(Boolean(selected)));
			if (select) select.tabIndex = selected ? 0 : -1;
		}
	}

	private onKeydown(event: KeyboardEvent): void {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || this.paths.length === 0) return;
		const activeElement = this.container.ownerDocument.activeElement as HTMLElement | null;
		const wrapper = activeElement?.closest<HTMLElement>('.so-folder-tab');
		const pathOnFocus = wrapper?.querySelector<HTMLButtonElement>('.so-folder-tab-select')?.dataset.folderPath;
		const currentIndex = Math.max(0, this.paths.indexOf(pathOnFocus ?? this.activePath));
		const nextIndex = event.key === 'Home' ? 0
			: event.key === 'End' ? this.paths.length - 1
			: (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + this.paths.length) % this.paths.length;
		const nextPath = this.paths[nextIndex];
		if (!nextPath) return;
		event.preventDefault();
		this.selectFolder(nextPath);
		this.findButton(nextPath, '.so-folder-tab-select')?.focus();
	}

	private focusedTab(): { folderPath: string; part: 'select' | 'close' } | null {
		const activeElement = this.container.ownerDocument.activeElement as HTMLElement | null;
		if (!activeElement || !this.container.contains(activeElement)) return null;
		const folderPath = activeElement.dataset.folderPath;
		if (!folderPath) return null;
		return {
			folderPath,
			part: activeElement.classList.contains('so-folder-tab-close') ? 'close' : 'select',
		};
	}

	private findButton(folderPath: string, selector: string): HTMLButtonElement | null {
		return Array.from(this.container.querySelectorAll<HTMLButtonElement>(selector))
			.find((button) => button.dataset.folderPath === folderPath) ?? null;
	}
}
