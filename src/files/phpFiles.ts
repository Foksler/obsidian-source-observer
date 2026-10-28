import * as path from 'path';

/** Paths treated as PHP by common editors and language servers. */
export function isPhpFile(filePath: string): boolean {
	const name = path.basename(filePath).toLowerCase();
	return path.extname(name) === '.php' || name === 'artisan' || name === '.php_cs' ||
		name === '.php_cs.dist' || name === '.pre' || name.endsWith('.pre');
}
