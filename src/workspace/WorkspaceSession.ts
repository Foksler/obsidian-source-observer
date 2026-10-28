import type { CodePaneSession } from './NavigationSession.ts';
import { NavigationSession } from './NavigationSession.ts';
import type { EditorTabsState, SourceTab } from './TabSession.ts';
import { TabSession } from './TabSession.ts';
import type { SearchPanelState } from './SearchPanelState.ts';

export interface FolderSession {
	editor: CodePaneSession;
	tabs: EditorTabsState;
	search: SearchPanelState;
	treeQuery: string;
	changesQuery: string;
}

export type ContentTarget =
	| { kind: 'source'; filePath: string; mode: 'source' | 'preview' }
	| {
		kind: 'diff'; filePath: string;
		left: { kind: 'git'; revision: 'HEAD'; missing: 'empty' };
		right: { kind: 'disk'; fallback: 'index' }
	};

/** View-independent workspace state. Adapters capture presentation state at transition boundaries. */
export class WorkspaceSession {
	activeFolder = '';
	folders: string[] = [];
	sessions = new Map<string, FolderSession>();
	previews = new Set<string>();
	recents: string[] = [];
	navigation = new NavigationSession();
	tabs = new TabSession();
	folderGeneration = 0;
	folderEpoch = 0;
	contentGeneration = 0;
	target(tab: SourceTab): ContentTarget {
		return tab.kind === 'code' ? { kind: 'source', filePath: tab.filePath, mode: this.previews.has(tab.filePath) ? 'preview' : 'source' }
			: { kind: 'diff', filePath: tab.filePath, left: { kind: 'git', revision: 'HEAD', missing: 'empty' }, right: { kind: 'disk', fallback: 'index' } };
	}
	shown(filePath: string) { this.recents = [filePath, ...this.recents.filter(file => file !== filePath)].slice(0, 50); }
	forget(matches: (filePath: string) => boolean) {
		this.recents = this.recents.filter(file => !matches(file));
		for (const file of this.previews) if (matches(file)) this.previews.delete(file);
		for (const session of this.sessions.values()) {
			session.tabs.tabs = session.tabs.tabs.filter(tab => !matches(tab.filePath));
			if (session.tabs.active && matches(session.tabs.active.filePath)) session.tabs.active = session.tabs.tabs[0] ?? null;
			const navigation = new NavigationSession(); navigation.restore(session.editor); navigation.forget(matches); session.editor = navigation.capture();
		}
	}
}
