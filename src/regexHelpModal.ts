import { App, Modal } from 'obsidian';

const sections = [
	['Characters', [
		['x', 'The literal character x'], ['.', 'Any character except a newline'],
		['\\.', 'A literal dot'], ['\\\\', 'A literal backslash'], ['\\t', 'A tab'],
	]],
	['Character classes', [
		['[abc]', 'One character from this set'], ['[^abc]', 'One character outside this set'],
		['[a-z]', 'One character in this range'], ['\\d / \\D', 'A digit / a non-digit'],
		['\\w / \\W', 'A word character / a non-word character'], ['\\s / \\S', 'Whitespace / non-whitespace'],
	]],
	['Groups and alternatives', [
		['(abc)', 'A group'], ['(?:abc)', 'A group without capturing'], ['abc|def', 'Either alternative'],
	]],
	['Repetitions and boundaries', [
		['x* / x+ / x?', 'Zero or more / one or more / optional'], ['x{3} / x{2,4}', 'Exactly three / two to four'],
		['x*? / x+?', 'Match the shortest repetition'], ['^ / $', 'Start / end of a line'], ['\\b', 'A word boundary'],
	]],
] as const;

/** Local reference: opening help leaves the search query, results and scope intact. */
export class RegexHelpModal extends Modal {
	constructor(app: App, private didClose: () => void) {
		super(app);
		this.shouldRestoreSelection = false;
		this.modalEl.addClass('so-regex-help-modal');
		this.setTitle('Regular expression syntax');
	}
	open() { super.open(); this.titleEl.tabIndex = -1; this.titleEl.focus(); }
	onOpen() {
		this.contentEl.createEl('p', { text: 'Enable .* to search with a regular expression. Regex patterns search file contents; Exclude paths filters filenames and directories.' });
		const table = this.contentEl.createEl('table');
		const heading = table.createEl('thead').createEl('tr');
		heading.createEl('th', { text: 'Construct', attr: { scope: 'col' } });
		heading.createEl('th', { text: 'Matches', attr: { scope: 'col' } });
		const body = table.createEl('tbody');
		for (const [name, rows] of sections) {
			body.createEl('tr').createEl('th', { text: name, attr: { colspan: '2', scope: 'colgroup' } });
			for (const [pattern, description] of rows) {
				const row = body.createEl('tr');
				row.createEl('td').createEl('code', { text: pattern });
				row.createEl('td', { text: description });
			}
		}
		this.contentEl.createEl('h3', { text: 'Examples' });
		const examples = this.contentEl.createEl('dl');
		for (const [pattern, description] of [
			['\\b(?:Google)?AuthController\\b', 'AuthController or GoogleAuthController as a whole word'],
			['class\\s+\\w+Controller', 'Class declarations ending in Controller'],
		]) {
			examples.createEl('dt').createEl('code', { text: pattern });
			examples.createEl('dd', { text: description });
		}
		this.contentEl.createEl('p', { text: 'Search runs one line at a time. Look-around and backreferences are not supported by the default search engine.' });
		this.contentEl.createEl('a', { text: 'Full syntax reference', attr: { href: 'https://docs.rs/regex/latest/regex/#syntax', target: '_blank', rel: 'noopener noreferrer' } });
	}
	onClose() { this.contentEl.empty(); this.didClose(); }
}
