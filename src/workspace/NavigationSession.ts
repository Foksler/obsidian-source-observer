export interface CodePaneSessionLocation {
	filePath: string;
	pos: number;
	scrollTop: number;
}

export interface CodePaneSession {
	currentPath: string | null;
	currentLocation: CodePaneSessionLocation | null;
	fileLocations: CodePaneSessionLocation[];
	history: CodePaneSessionLocation[];
	forwardHistory: CodePaneSessionLocation[];
}

function cloneSessionLocation(location: CodePaneSessionLocation): CodePaneSessionLocation {
	return { filePath: location.filePath, pos: location.pos, scrollTop: location.scrollTop };
}

/** Returns a plain serializable copy without sharing mutable arrays or entries. */
export function cloneCodePaneSession(session: CodePaneSession | null): CodePaneSession {
	if (!session) return { currentPath: null, currentLocation: null, fileLocations: [], history: [], forwardHistory: [] };
	return {
		currentPath: session.currentPath,
		currentLocation: session.currentLocation ? cloneSessionLocation(session.currentLocation) : null,
		fileLocations: session.fileLocations.map(cloneSessionLocation),
		history: session.history.map(cloneSessionLocation),
		forwardHistory: session.forwardHistory.map(cloneSessionLocation),
	};
}


/** Cursor locations and navigation stacks belong to a workspace session, not an editor instance. */
export class NavigationSession {
	currentPath: string | null = null;
	fileLocations = new Map<string, CodePaneSessionLocation>();
	history: CodePaneSessionLocation[] = [];
	forwardHistory: CodePaneSessionLocation[] = [];
	private revision = 0;
	capture(): CodePaneSession {
		return cloneCodePaneSession({
currentPath: this.currentPath, currentLocation: this.currentPath ? this.fileLocations.get(this.currentPath) ?? null : null,
			fileLocations: [...this.fileLocations.values()], history: this.history, forwardHistory: this.forwardHistory
});
	}
	restore(session: CodePaneSession | null) {
		const copy = cloneCodePaneSession(session); this.revision++;
		this.currentPath = copy.currentPath; this.fileLocations = new Map(copy.fileLocations.map(location => [location.filePath, location]));
		if (copy.currentLocation) this.fileLocations.set(copy.currentLocation.filePath, copy.currentLocation);
		this.history = copy.history; this.forwardHistory = copy.forwardHistory;
	}
	remember(location: CodePaneSessionLocation) {
		this.revision++; this.forwardHistory = [];
		const last = this.history[this.history.length - 1];
		if (last?.filePath === location.filePath && last.pos === location.pos) return;
		this.history.push({ ...location }); if (this.history.length > 100) this.history.shift();
	}
	/** A traversal is committed only after the target renderer actually opened. */
	begin(direction: 'back' | 'forward', current: CodePaneSessionLocation | null) {
		const from = direction === 'back' ? this.history : this.forwardHistory;
		const target = from[from.length - 1]; if (!target) return null;
		const revision = this.revision;
		return {
target: { ...target }, commit: () => {
				if (revision !== this.revision || from[from.length - 1] !== target) return false;
				from.pop(); if (current) (direction === 'back' ? this.forwardHistory : this.history).push({ ...current });
				this.revision++; return true;
			}
};
	}
	forget(matches: (filePath: string) => boolean) {
		this.revision++;
		if (this.currentPath && matches(this.currentPath)) this.currentPath = null;
		for (const file of this.fileLocations.keys()) if (matches(file)) this.fileLocations.delete(file);
		this.history = this.history.filter(location => !matches(location.filePath));
		this.forwardHistory = this.forwardHistory.filter(location => !matches(location.filePath));
	}
}
