import { promises as fsp } from 'fs';
import * as path from 'path';
function isInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export type NewEntryKind = 'file' | 'folder';

/** A refusal the user can fix by changing the name; its message is shown as is. */
export class CreateEntryError extends Error {}

/** Creates an empty file or folder; `name` may hold subfolders, which are created too. Never overwrites. */
export async function createEntry(kind: NewEntryKind, parentDir: string, name: string, rootPath: string): Promise<string> {
	const root = path.resolve(rootPath), parent = path.resolve(parentDir);
	if (parent !== root && !isInside(root, parent)) throw new Error('Folder is outside the project root.');
	const trimmed = name.trim();
	if (path.isAbsolute(trimmed)) throw new CreateEntryError('Enter a name relative to this folder.');
	const parts = trimmed.split(/[/\\]/).filter(Boolean);
	if (parts.length === 0) throw new CreateEntryError('Enter a name.');
	if (parts.some((part) => part === '.' || part === '..')) throw new CreateEntryError('A name cannot contain "." or ".." folders.');
	const target = path.join(parent, ...parts);
	try { await fsp.mkdir(path.dirname(target), { recursive: true }); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'EEXIST' || code === 'ENOTDIR') throw new CreateEntryError(`Cannot create folder "${parts.slice(0, -1).join('/')}": a file is in the way.`);
		throw error;
	}
	try {
		// Exclusive creation: an existing path, even one created after the menu opened, is left untouched.
		if (kind === 'folder') await fsp.mkdir(target);
		else await fsp.writeFile(target, '', { flag: 'wx' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CreateEntryError(`"${parts.join('/')}" already exists.`);
		throw error;
	}
	return target;
}

/** Returns false when the user cancels deletion of a link in an external folder. */
export async function trashEntry(
	kind: 'file' | 'folder' | 'link',
	filePath: string,
	rootPath: string,
	trash: (path: string) => Promise<void>,
	confirmExternalLink?: (linkPath: string) => Promise<boolean>,
): Promise<boolean> {
	const fullPath = path.resolve(filePath);
	if (!rootPath || !isInside(path.resolve(rootPath), fullPath)) throw new Error('Path is outside the project root.');
	const info = await fsp.lstat(fullPath);
	if (kind === 'file' && !info.isFile() && !info.isSymbolicLink()) throw new Error('Only files can be deleted.');
	if (kind === 'folder' && !info.isDirectory()) throw new Error('Only folders can be deleted.');
	if (kind === 'link' && !info.isSymbolicLink()) throw new Error('Path is no longer a symbolic link.');

	const parentPath = path.dirname(fullPath);
	const [root, parent] = await Promise.all([fsp.realpath(rootPath), fsp.realpath(parentPath)]);
	if (parent === root || isInside(root, parent)) {
		await trash(fullPath);
		return true;
	}
	if (kind !== 'link' || !confirmExternalLink) throw new Error('File parent is outside the project root.');

	// Resolve only the parent, so the confirmation and Trash both refer to the link itself.
	const linkPath = path.join(parent, path.basename(fullPath));
	if (!await confirmExternalLink(linkPath)) return false;
	const [currentParent, currentLink] = await Promise.all([fsp.realpath(parentPath), fsp.lstat(linkPath)]);
	if (currentParent !== parent || !currentLink.isSymbolicLink() || currentLink.dev !== info.dev || currentLink.ino !== info.ino) {
		throw new Error('Symbolic link changed while confirming deletion.');
	}
	await trash(linkPath);
	return true;
}
