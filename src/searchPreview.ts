/** Keep huge generated lines out of the DOM while retaining the matched context. */
export function searchPreview(text: string, column: number, width = 240): string {
	if (text.length <= width) return text;
	const match = Math.max(0, Math.min(text.length - 1, column - 1));
	let start = Math.max(0, Math.min(text.length - width, match - Math.floor(width / 3)));
	let end = Math.min(text.length, start + width);
	// Never cut a UTF-16 surrogate pair in half.
	if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start] ?? '')) start--;
	if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end] ?? '')) end++;
	return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
