import assert from 'node:assert/strict';
import { it } from 'node:test';
import { isPhpFile } from '../src/phpFiles.ts';

it('recognizes PHP files and common PHP configuration scripts', () => {
	for (const file of ['AdminController.php', 'artisan', '.php_cs', '.php_cs.dist', '.pre', 'project.pre']) {
		assert.equal(isPhpFile(file), true, file);
	}
	for (const file of ['composer.json', 'artisan.md', '.php_cs.txt', 'project.php.txt']) {
		assert.equal(isPhpFile(file), false, file);
	}
});
