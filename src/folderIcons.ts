import { folderNames, folderNamesExpanded, folderSvg } from './materialFolderIconData';

const urls = new Map<string, string>();

/** Material Icon Theme folder artwork, bundled locally with no editor dependency. */
export function folderIcon(name: string, expanded: boolean) {
	const key = name.toLowerCase();
	const names = expanded ? folderNamesExpanded : folderNames;
	const id = Object.prototype.hasOwnProperty.call(names, key) ? names[key]! : expanded ? 'folder-open' : 'folder';
	let url = urls.get(id);
	if (!url) {
		url = `url("data:image/svg+xml,${encodeURIComponent(folderSvg[id]!)}")`;
		urls.set(id, url);
	}
	return { id, url };
}

export function setFolderIcon(element: HTMLElement, name: string, expanded: boolean) {
	const icon = folderIcon(name, expanded);
	element.addClass('so-material-folder-icon');
	element.dataset.icon = icon.id;
	element.setCssProps({ '--so-folder-icon': icon.url });
}
