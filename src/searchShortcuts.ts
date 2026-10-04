import type { Hotkey, KeymapEventHandler, Scope } from 'obsidian';

export const SHORTCUT_ACTIONS = {
	findInFiles: 'Find in files', everywhere: 'Search everywhere', quickOpen: 'Quick open file',
	quickOpenAlternate: 'Quick open file (alternate)', documentSymbols: 'Go to symbol in file',
	workspaceSymbols: 'Go to symbol in workspace', findInFile: 'Find in current file',
	back: 'Go back', forward: 'Go forward',
};
export type ShortcutAction = keyof typeof SHORTCUT_ACTIONS;
export type SearchShortcuts = Record<ShortcutAction, Hotkey | null>;
export const DEFAULT_SHORTCUTS: SearchShortcuts = {
	findInFiles: { modifiers: ['Mod', 'Shift'], key: 'f' }, everywhere: null,
	quickOpen: { modifiers: ['Mod'], key: 'p' }, quickOpenAlternate: { modifiers: ['Mod', 'Shift'], key: 'o' },
	documentSymbols: { modifiers: ['Mod', 'Alt'], key: 'o' }, workspaceSymbols: { modifiers: ['Mod'], key: 't' },
	findInFile: { modifiers: ['Mod'], key: 'f' }, back: { modifiers: ['Mod'], key: '[' }, forward: { modifiers: ['Mod'], key: ']' },
};

function validShortcut(value: unknown): Hotkey | null {
	if (!value || typeof value !== 'object') return null;
	const { key, modifiers } = value as Partial<Hotkey>;
	if (typeof key !== 'string' || !key || !Array.isArray(modifiers)
		|| modifiers.some((modifier) => !['Mod', 'Ctrl', 'Meta', 'Shift', 'Alt'].includes(modifier))
		|| ['Shift', 'Control', 'Meta', 'Alt', 'Escape', 'Tab'].includes(key)) return null;
	if (!modifiers.some((modifier) => modifier !== 'Shift') && !/^F\d{1,2}$/.test(key)) return null;
	return { key, modifiers: [...new Set(modifiers)] };
}

export function normalizeShortcuts(value: unknown): SearchShortcuts {
	const result = {} as SearchShortcuts;
	const saved = value && typeof value === 'object' ? value as Partial<SearchShortcuts> : {};
	for (const action of Object.keys(SHORTCUT_ACTIONS) as ShortcutAction[]) {
		result[action] = saved[action] === null ? null : validShortcut(saved[action]) ?? validShortcut(DEFAULT_SHORTCUTS[action]);
	}
	return result;
}

export function shortcutFromEvent(event: KeyboardEvent, mac: boolean): Hotkey | null {
	const modifiers: Hotkey['modifiers'] = [];
	if (mac ? event.metaKey : event.ctrlKey) modifiers.push('Mod');
	if (mac && event.ctrlKey) modifiers.push('Ctrl');
	if (!mac && event.metaKey) modifiers.push('Meta');
	if (event.altKey) modifiers.push('Alt');
	if (event.shiftKey) modifiers.push('Shift');
	// Option produces symbols on macOS (for example © for G); bind the letter.
	const key = mac && event.altKey && /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : event.key;
	return validShortcut({ key: key.length === 1 ? key.toLowerCase() : key, modifiers });
}

export function shortcutLabel(shortcut: Hotkey | null, mac: boolean): string {
	return shortcut ? [...shortcut.modifiers.map((modifier) => modifier === 'Mod' ? mac ? 'Cmd' : 'Ctrl' : modifier), shortcut.key.toUpperCase()].join('+') : 'Not assigned';
}

export function sameShortcut(a: Hotkey | null, b: Hotkey | null): boolean {
	return !!a && !!b && a.key.toLowerCase() === b.key.toLowerCase() && [...a.modifiers].sort().join(',') === [...b.modifiers].sort().join(',');
}

/** Unregister old bindings before applying changed settings to the same view. */
export function bindShortcuts(scope: Scope, shortcuts: SearchShortcuts, actions: Record<ShortcutAction, () => void>, mac = false): () => void {
	const handlers: KeymapEventHandler[] = [];
	const optionGroups = new Map<string, ShortcutAction[]>();
	for (const action of Object.keys(SHORTCUT_ACTIONS) as ShortcutAction[]) {
		const shortcut = shortcuts[action];
		if (!shortcut) continue;
		if (mac && shortcut.modifiers.includes('Alt')) {
			const group = [...shortcut.modifiers].sort().join('+');
			optionGroups.set(group, [...optionGroups.get(group) ?? [], action]);
		} else handlers.push(scope.register(shortcut.modifiers, shortcut.key, () => { actions[action](); return false; }));
	}
	// Obsidian Scope matches Option symbols; compare the normalized event instead.
	for (const group of optionGroups.values()) {
		handlers.push(scope.register(shortcuts[group[0]!]!.modifiers, null, (event) => {
			const pressed = shortcutFromEvent(event, true);
			const action = group.find((key) => sameShortcut(shortcuts[key], pressed));
			if (!action) return;
			actions[action](); return false;
		}));
	}
	return () => handlers.forEach((handler) => scope.unregister(handler));
}
