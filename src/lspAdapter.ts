export interface LspCommand {
	executable: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
}

/** The server-specific part of navigation; editor actions live in LanguageLsp. */
export interface LspAdapter {
	id: string;
	name: string;
	serverName: string;
	configurationSection: string;
	languageId: (filePath: string) => string | null;
	projectRoot: (filePath: string) => string | null;
	workspaceRoots: (root: string, includeWorktrees: boolean) => Promise<string[]>;
	command: () => LspCommand | null;
	missingMessage: string;
	initializationOptions?: (root: string) => unknown;
	settings: (root: string, includeWorktrees: boolean) => Promise<unknown>;
	indexingNotifications?: { start: string; end: string };
	/** Dependencies and the standard library keep the originating workspace's context. */
	externalFilesUseActiveRoot?: boolean;
}
