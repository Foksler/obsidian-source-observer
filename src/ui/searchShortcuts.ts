import type {KeymapEventHandler,Scope} from 'obsidian';
import {SHORTCUT_ACTIONS,shortcutFromEvent,sameShortcut,type SearchShortcuts,type ShortcutAction} from '../app/index.ts';
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
