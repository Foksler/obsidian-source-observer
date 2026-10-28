/** Lines appended per presentation batch. */
const DIFF_BATCH_SIZE=500;

function diffLineClass(line: string): string | null {
	if (line.startsWith('\\')) return 'so-diff-nonewline';
	if (line.startsWith('+++') || line.startsWith('---')) return 'so-diff-file';
	if (line.startsWith('+')) return 'so-diff-add';
	if (line.startsWith('-')) return 'so-diff-del';
	if (line.startsWith('@@')) return 'so-diff-hunk';
	if (line.startsWith('diff --git')) return 'so-diff-header';
	return null;
}

/**
 * Renders a unified diff string into `container` with syntax-coloured spans.
 * Large diffs are appended in batches as the user scrolls instead of
 * building one span per line up front.
 */
export function renderDiff(container: HTMLElement, diff: string) {
	container.empty();
	if (!diff.trim()) {
		container.createEl('p', { cls: 'so-diff-clean', text: 'No diff to show' });
		return;
	}

	const pre = container.createEl('pre', { cls: 'so-diff-pre' });
	const lines = diff.split('\n');
	let rendered = 0;

	const sentinel = container.createDiv({ cls: 'so-diff-more' });

	const renderBatch = () => {
		const end = Math.min(rendered + DIFF_BATCH_SIZE, lines.length);
		for (; rendered < end; rendered++) {
			const line = lines[rendered] ?? '';
			const span = pre.createEl('span');
			span.setText(line + '\n');
			const cls = diffLineClass(line);
			if (cls) span.addClass(cls);
		}
		if (rendered < lines.length) {
			sentinel.setText(`… ${lines.length - rendered} more lines (scroll to load) …`);
		} else {
			sentinel.remove();
			container.removeEventListener('scroll', onScroll);
		}
	};

	const onScroll = () => {
		if (rendered >= lines.length) return;
		if (container.scrollTop + container.clientHeight >= container.scrollHeight - 400) {
			renderBatch();
		}
	};

	renderBatch();
	if (rendered < lines.length) container.addEventListener('scroll', onScroll, { passive: true });
}
