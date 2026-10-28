type MarkedString = string | { language: string; value: string };

export type HoverContents =
	| string
	| { kind: 'markdown' | 'plaintext'; value: string }
	| MarkedString[]
	| MarkedString;

function asCodeBlock(value: string, language = ''): string {
	const fence = '`'.repeat(Math.max(3, longestRun(value, '`') + 1));
	const safeLanguage = language.replace(/[^a-zA-Z0-9_+.#-]/g, '');
	return `${fence}${safeLanguage}\n${value}\n${fence}`;
}

function longestRun(value: string, character: string): number {
	let longest = 0;
	let current = 0;
	for (const char of value) {
		current = char === character ? current + 1 : 0;
		longest = Math.max(longest, current);
	}
	return longest;
}

function markedStringToMarkdown(value: MarkedString): string {
	return typeof value === 'string' ? value : asCodeBlock(value.value, value.language);
}

/** Normalizes LSP hover content to Markdown before the Obsidian renderer runs. */
export function hoverContentsToMarkdown(contents: HoverContents): string {
	if (Array.isArray(contents)) return contents.map(markedStringToMarkdown).join('\n\n');
	if (typeof contents === 'string') return contents;
	if ('kind' in contents) {
		return contents.kind === 'markdown' ? contents.value : asCodeBlock(contents.value);
	}
	return markedStringToMarkdown(contents);
}

/** Awaitable rendering seam so tooltip layout is measured only after rendering finishes. */
export async function renderHoverContent<T>(
	render: () => Promise<T>,
): Promise<T> {
	return await render();
}

export interface ComponentLifecycle {
	load(): void;
	unload(): void;
}

export interface HoverRect {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/** Keeps CodeMirror's placement calculations inside the editor's visible column. */
export function hoverTooltipRect(rect: HoverRect, inset = 8): HoverRect {
	const safeInset = Math.min(Math.max(0, inset), Math.max(0, (rect.right - rect.left) / 2));
	return {
		left: rect.left + safeInset,
		right: rect.right - safeInset,
		top: rect.top,
		bottom: rect.bottom,
	};
}

export function hoverTooltipWidth(editorWidth: number, inset = 8, maxWidth = 680): number {
	return Math.max(1, Math.min(maxWidth, editorWidth - inset * 2));
}

/** Defers component listeners until CodeMirror actually mounts the tooltip. */
export function createHoverLifecycle<T>(component: ComponentLifecycle, dom: T) {
	let loaded = false;
	let unloaded = false;
	const destroy = () => {
		if (!loaded || unloaded) return;
		unloaded = true;
		component.unload();
	};
	return {
		create() {
			if (!loaded && !unloaded) {
				component.load();
				loaded = true;
			}
			return { dom, destroy };
		},
	};
}
