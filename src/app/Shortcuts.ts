export interface Shortcut { modifiers: ('Mod'|'Ctrl'|'Meta'|'Shift'|'Alt')[]; key:string }
export interface ShortcutEvent { metaKey:boolean;ctrlKey:boolean;altKey:boolean;shiftKey:boolean;code:string;key:string }

export const SHORTCUT_ACTIONS = {
	findInFiles: 'Find in files', everywhere: 'Search everywhere', quickOpen: 'Quick open file',
	quickOpenAlternate: 'Quick open file (alternate)', documentSymbols: 'Go to symbol in file',
	workspaceSymbols: 'Go to symbol in workspace', findInFile: 'Find in current file',
	back: 'Go back', forward: 'Go forward',
};
export type ShortcutAction = keyof typeof SHORTCUT_ACTIONS;
export type SearchShortcuts = Record<ShortcutAction, Shortcut | null>;
export const DEFAULT_SHORTCUTS: SearchShortcuts = {
	findInFiles: { modifiers: ['Mod', 'Shift'], key: 'f' }, everywhere: null,
	quickOpen: { modifiers: ['Mod'], key: 'p' }, quickOpenAlternate: { modifiers: ['Mod', 'Shift'], key: 'o' },
	documentSymbols: { modifiers: ['Mod', 'Alt'], key: 'o' }, workspaceSymbols: { modifiers: ['Mod'], key: 't' },
	findInFile: { modifiers: ['Mod'], key: 'f' }, back: { modifiers: ['Mod'], key: '[' }, forward: { modifiers: ['Mod'], key: ']' },
};

function validShortcut(value: unknown): Shortcut | null {
	if (!value || typeof value !== 'object') return null;
	const { key, modifiers } = value as Partial<Shortcut>;
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

export function shortcutFromEvent(event: ShortcutEvent, mac: boolean): Shortcut | null {
	const modifiers: Shortcut['modifiers'] = [];
	if (mac ? event.metaKey : event.ctrlKey) modifiers.push('Mod');
	if (mac && event.ctrlKey) modifiers.push('Ctrl');
	if (!mac && event.metaKey) modifiers.push('Meta');
	if (event.altKey) modifiers.push('Alt');
	if (event.shiftKey) modifiers.push('Shift');
	// Option produces symbols on macOS (for example © for G); bind the letter.
	const key = mac && event.altKey && /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : event.key;
	return validShortcut({ key: key.length === 1 ? key.toLowerCase() : key, modifiers });
}

export function shortcutLabel(shortcut: Shortcut | null, mac: boolean): string {
	return shortcut ? [...shortcut.modifiers.map((modifier) => modifier === 'Mod' ? mac ? 'Cmd' : 'Ctrl' : modifier), shortcut.key.toUpperCase()].join('+') : 'Not assigned';
}

export function sameShortcut(a: Shortcut | null, b: Shortcut | null): boolean {
	return !!a && !!b && a.key.toLowerCase() === b.key.toLowerCase() && [...a.modifiers].sort().join(',') === [...b.modifiers].sort().join(',');
}
