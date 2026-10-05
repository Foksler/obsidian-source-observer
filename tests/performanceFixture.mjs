import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node tests/performanceFixture.mjs EMPTY_DIRECTORY');
const root = path.resolve(directory);
await mkdir(root, { recursive: true });
if ((await readdir(root)).length) throw new Error('The fixture directory must be empty');
const stems = ['StatsController', 'DashboardStatsController', 'OrderService', 'Worker', 'Reader'];
for (let module = 0; module < 160; module++) {
	const folder = path.join(root, 'app', `module${module}`, 'Services');
	await mkdir(folder, { recursive: true });
	for (let start = 0; start < 75; start += 25) {
		await Promise.all(Array.from({ length: Math.min(25, 75 - start) }, (_, offset) => {
			const index = start + offset;
			const stem = stems[index % stems.length];
			const content = `<?php\nclass ${stem}${index} {\n`
				+ Array.from({ length: 10 }, (_, method) => `    public function method${method}() { return '${stem}'; }\n`).join('') + '}\n';
			return writeFile(path.join(folder, `${stem}${index}.php`), content);
		}));
	}
}
console.log(root);
