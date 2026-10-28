export function splitGlobs(value?: string): string[] {
	return (value ?? '').split(/[\n,;]/).map((part) => part.trim()).filter(Boolean);
}

export function globToRegExp(glob: string, flags = ''): RegExp {
	const normalized = glob.replace(/\\/g, '/');
	let source = '^';
	for (let index = 0; index < normalized.length; index++) {
		const character = normalized[index] ?? '';
		if (character === '*') {
			if (normalized[index + 1] === '*' && normalized[index + 2] === '/') {
				source += '(?:.*/)?';
				index += 2;
			} else if (normalized[index + 1] === '*') {
				source += '.*';
				index++;
			} else source += '[^/]*';
		} else if (character === '?') source += '[^/]';
		else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
	}
	return new RegExp(`${source}$`, flags);
}
