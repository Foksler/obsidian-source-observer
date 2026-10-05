import { App, Component, Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import type SourceObserverPlugin from './main';
import { detectIntelephense, detectNode } from './phpAdapter';
import { detectGo, detectGopls } from './goAdapter';
import type { SearchMode } from './searchMode';
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, shortcutFromEvent, shortcutLabel, sameShortcut, type SearchShortcuts, type ShortcutAction } from './searchShortcuts';

export type SyntaxTheme = 'obsidian' | 'cursor-monokai' | 'dark-plus' | 'one-dark';

/** Persisted plugin settings stored in `data.json`. */
export interface SourceObserverSettings {
	replaceFileExplorer: boolean;
	searchMode: SearchMode;
	shortcuts: SearchShortcuts;
	doubleShiftSearch: boolean;
	lastOpenedPath: string;
	openedFolderPaths: string[] | null;
	fontSize: number;
	editorFontFamily: string;
	editorFontLigatures: boolean;
	showHidden: boolean;
	includeWorktrees: boolean;
	gitPanelHidden: boolean;
	syntaxTheme: SyntaxTheme;
	phpLsp: boolean;
	nodePath: string;
	intelephensePath: string;
	intelephenseLicence: string;
	goLsp: boolean;
	goPath: string;
	goplsPath: string;
}

export const DEFAULT_SETTINGS: SourceObserverSettings = {
	replaceFileExplorer: false,
	searchMode: 'vscode',
	shortcuts: DEFAULT_SHORTCUTS,
	doubleShiftSearch: true,
	lastOpenedPath: '',
	openedFolderPaths: null,
	fontSize: 15,
	editorFontFamily: 'JetBrains Mono',
	editorFontLigatures: true,
	showHidden: true,
	includeWorktrees: false,
	gitPanelHidden: false,
	syntaxTheme: 'cursor-monokai',
	phpLsp: true,
	nodePath: '',
	intelephensePath: '',
	intelephenseLicence: '',
	goLsp: false,
	goPath: '',
	goplsPath: '',
};

/** Obsidian settings tab for configuring font size and hidden-file visibility. */
export class SourceObserverSettingTab extends PluginSettingTab {
	plugin: SourceObserverPlugin;
	private shortcutListeners = new Component();

	constructor(app: App, plugin: SourceObserverPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		plugin.register(() => this.shortcutListeners.unload());
	}

	display(): void {
		const { containerEl } = this;
		this.shortcutListeners.unload(); this.shortcutListeners.load();
		containerEl.empty();

		new Setting(containerEl)
			.setName('Replace Obsidian file explorer')
			.setDesc('Show source folders in the left files panel while the source observer tab is active. Switching to a note restores Obsidian files. Code and diffs stay in the main tab.')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.replaceFileExplorer).onChange(async (value) => {
				this.plugin.settings.replaceFileExplorer = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Search mode')
			.setDesc('Choose sidebar search or a search everywhere modal. In modal mode, press shift twice while the source view has focus.')
			.addDropdown((dropdown) => dropdown
				.addOptions({ vscode: 'VS Code', phpstorm: 'PhpStorm' })
				.setValue(this.plugin.settings.searchMode)
				.onChange(async (value) => {
					this.plugin.settings.searchMode = value === 'phpstorm' ? 'phpstorm' : 'vscode';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Double shift search')
			.setDesc('Open search everywhere with two shift taps in modal search mode.')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.doubleShiftSearch).onChange(async (value) => {
				this.plugin.settings.doubleShiftSearch = value; await this.plugin.saveSettings();
			}));

		new Setting(containerEl).setName('Keyboard shortcuts').setDesc('Click a shortcut field and press a key combination. These shortcuts apply while the source view has focus. Commands are also available in Obsidian hotkeys.').setHeading();
		for (const action of Object.keys(SHORTCUT_ACTIONS) as ShortcutAction[]) {
			const setting = new Setting(containerEl).setName(SHORTCUT_ACTIONS[action]);
			setting.addText((input) => {
				input.inputEl.readOnly = true;
				input.inputEl.setAttribute('aria-label', `${SHORTCUT_ACTIONS[action]} shortcut`);
				input.setValue(shortcutLabel(this.plugin.settings.shortcuts[action], Platform.isMacOS));
				this.shortcutListeners.registerDomEvent(input.inputEl, 'keydown', (event) => {
					if (event.key === 'Tab') return;
					event.preventDefault(); event.stopPropagation();
					if (event.key === 'Escape') { input.inputEl.blur(); return; }
					const shortcut = shortcutFromEvent(event, Platform.isMacOS); if (!shortcut) return;
					const conflict = (Object.keys(SHORTCUT_ACTIONS) as ShortcutAction[]).find((key) => key !== action && sameShortcut(shortcut, this.plugin.settings.shortcuts[key]));
					if (conflict) { new Notice(`This shortcut is assigned to ${SHORTCUT_ACTIONS[conflict]}. Clear it first.`); return; }
					this.plugin.settings.shortcuts[action] = shortcut;
					input.setValue(shortcutLabel(shortcut, Platform.isMacOS));
					void this.plugin.saveSettings();
				});
			});
			setting.addExtraButton((button) => button.setIcon('x').setTooltip('Clear shortcut').onClick(async () => {
				this.plugin.settings.shortcuts[action] = null; await this.plugin.saveSettings(); this.display();
			}));
			setting.addExtraButton((button) => button.setIcon('reset').setTooltip('Restore default shortcut').onClick(async () => {
				const shortcut = DEFAULT_SHORTCUTS[action];
				const conflict = (Object.keys(SHORTCUT_ACTIONS) as ShortcutAction[]).find((key) => key !== action && sameShortcut(shortcut, this.plugin.settings.shortcuts[key]));
				if (conflict) { new Notice(`This shortcut is assigned to ${SHORTCUT_ACTIONS[conflict]}. Clear it first.`); return; }
				this.plugin.settings.shortcuts[action] = shortcut; await this.plugin.saveSettings(); this.display();
			}));
		}

		new Setting(containerEl)
			.setName('Font size')
			.setDesc('Code viewer font size in px')
			.addSlider((slider) =>
				slider
					.setLimits(10, 20, 1)
					.setValue(this.plugin.settings.fontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.fontSize = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Syntax theme')
			.setDesc('Colours used by the code viewer')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ obsidian: 'Obsidian (follows vault theme)', 'cursor-monokai': 'Cursor Monokai Pro', 'dark-plus': 'VS Code Dark+', 'one-dark': 'One Dark' })
					.setValue(this.plugin.settings.syntaxTheme)
					.onChange(async (value) => {
						this.plugin.settings.syntaxTheme = value as SyntaxTheme;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Editor font family')
				.setDesc('Choose the font used by the code viewer')
				.addText((input) =>
					input
						.setPlaceholder('Monospace font')
					.setValue(this.plugin.settings.editorFontFamily)
					.onChange(async (value) => {
						this.plugin.settings.editorFontFamily = value.trim() || 'JetBrains Mono';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Font ligatures')
			.setDesc('Use programming ligatures when supported by the selected font')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.editorFontLigatures)
					.onChange(async (value) => {
						this.plugin.settings.editorFontLigatures = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Php navigation').setHeading();

		new Setting(containerEl)
			.setName('Enable php language server')
			.setDesc('Cmd-click or f12 jumps to a definition, shift-f12 lists references, cmd-[ goes back. Uses intelephense, one process per composer project.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.phpLsp)
					.onChange(async (value) => {
						this.plugin.settings.phpLsp = value;
						await this.plugin.saveSettings();
					}),
			);

		const text = (name: string, desc: string, placeholder: string,
			key: 'nodePath' | 'intelephensePath' | 'intelephenseLicence' | 'goPath' | 'goplsPath') =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((input) =>
					input
						.setPlaceholder(placeholder)
						.setValue(this.plugin.settings[key])
						.onChange(async (value) => {
							this.plugin.settings[key] = value.trim();
							await this.plugin.saveSettings();
						}),
				);
		text('Node path', 'Leave empty to auto-detect.', detectNode() || 'not found', 'nodePath');
		text('Intelephense path', 'Path to intelephense.js. Leave empty to use the one bundled with Cursor or VS Code.',
			detectIntelephense() || 'not found', 'intelephensePath');
		text('Intelephense licence key', 'Optional; unlocks premium features such as go to implementation.', '', 'intelephenseLicence');

		new Setting(containerEl).setName('Go navigation').setHeading();
		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- Go is the language's name.
			.setName('Enable Go language server')
			.setDesc('Browse definitions, references, documentation and symbols using gopls and a locally installed toolchain.')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.goLsp).onChange(async (value) => {
				this.plugin.settings.goLsp = value;
				await this.plugin.saveSettings();
			}));
		text('Go path', 'Path to the go executable. Leave empty to auto-detect.', detectGo() || 'not found', 'goPath');
		text('Gopls path', 'Path to gopls. Install with go install golang.org/x/tools/gopls@latest, then leave empty to auto-detect.',
			detectGopls() || 'not found', 'goplsPath');

		new Setting(containerEl).setName('Files').setHeading();

		new Setting(containerEl)
			.setName('Show hidden files')
			.setDesc('Show files and folders starting with a dot')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHidden)
					.onChange(async (value) => {
						this.plugin.settings.showHidden = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Include worktrees')
			.setDesc('Show Git worktree folders in the file tree')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeWorktrees)
					.onChange(async (value) => {
						this.plugin.settings.includeWorktrees = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Hide Git changes panel')
			.setDesc('Hide the Git changes panel in the sidebar')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.gitPanelHidden)
					.onChange(async (value) => {
						this.plugin.settings.gitPanelHidden = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
