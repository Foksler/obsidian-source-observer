export interface TreeNode {
	name: string;
	fullPath: string;
	isDir: boolean;
	children?: TreeNode[];
	expanded?: boolean;
}

/** Re-read cached directories without eagerly walking unopened branches. */
export async function refreshTree(node: TreeNode, readDir: (dir: string) => Promise<TreeNode[]>): Promise<{ node: TreeNode; changed: boolean }> {
	if (!node.isDir || !node.children) return { node, changed: false };
	const children = await readDir(node.fullPath);
	const previous = new Map(node.children.map((child) => [child.fullPath, child]));
	let changed = children.length !== node.children.length;
	await Promise.all(children.map(async (child) => {
		const old = previous.get(child.fullPath);
		if (!old || old.isDir !== child.isDir) { changed = true; return; }
		if (!child.isDir) return;
		const refreshed = await refreshTree(old, readDir);
		child.children = refreshed.node.children;
		child.expanded = old.expanded;
		changed ||= refreshed.changed;
	}));
	return { node: changed ? { ...node, children } : node, changed };
}
