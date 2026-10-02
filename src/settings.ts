import { App, PluginSettingTab, Setting } from 'obsidian';
import type SourceObserverPlugin from './main';
import { detectIntelephense, detectNode } from './phpLsp';

export type SyntaxTheme = 'obsidian' | 'cursor-monokai' | 'dark-plus' | 'one-dark';

/** Persisted plugin settings stored in `data.json`. */
export interface SourceObserverSettings {
	lastOpenedPath: string;
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
}

export const DEFAULT_SETTINGS: SourceObserverSettings = {
	lastOpenedPath: '',
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
};

/** Obsidian settings tab for configuring font size and hidden-file visibility. */
export class SourceObserverSettingTab extends PluginSettingTab {
	plugin: SourceObserverPlugin;

	constructor(app: App, plugin: SourceObserverPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

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
			key: 'nodePath' | 'intelephensePath' | 'intelephenseLicence') =>
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
