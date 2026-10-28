// Public interface: cross-module consumers import only these contracts.
export {normalizeSearchMode} from './SearchPreferences.ts';
export {DEFAULT_SETTINGS} from './Settings.ts';
export type {SourceObserverSettings, SyntaxTheme} from './Settings.ts';
export {DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, normalizeShortcuts, sameShortcut, shortcutFromEvent, shortcutLabel} from './Shortcuts.ts';
export type {SearchShortcuts, ShortcutAction} from './Shortcuts.ts';
export {WorkspaceController} from './WorkspaceController.ts';
export {WorkspaceTransitions} from './WorkspaceTransitions.ts';
