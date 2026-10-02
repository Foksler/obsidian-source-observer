import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) {
	console.error('Usage: node tests/searchBenchmark.mjs /absolute/project/path [query] [rounds]');
	process.exit(1);
}
const root = path.resolve(process.argv[2]);
const query = process.argv[3] ?? 'StatsController';
const rounds = Math.max(4, Number.parseInt(process.argv[4] ?? '10', 10) || 10);

const cursorRgCandidates = [
	'/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg',
	'/Applications/Cursor - Insiders.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg',
];
const rg = cursorRgCandidates.find((candidate) => {
	try { return spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0; }
	catch { return false; }
});

if (!rg) {
	console.error('Could not find the Cursor-bundled ripgrep executable.');
	process.exitCode = 1;
} else {
	process.env.PATH = `${path.dirname(rg)}${path.delimiter}${process.env.PATH ?? ''}`;
	const [{ getRegisteredWorktrees }, { invalidateFilePathIndex, searchFilePathIndex }] = await Promise.all([
		import('../src/searchEngine.ts'),
		import('../src/filePathIndex.ts'),
	]);
	const worktrees = await getRegisteredWorktrees(root);
	const rgArgs = ['--files', '--hidden', '--no-ignore', '--null'];
	for (const excluded of ['.git', '.obsidian', 'node_modules']) {
		rgArgs.push('--glob', `!**/${excluded}`, '--glob', `!**/${excluded}/**`);
	}
	for (const worktree of ['.claude/worktrees', '.worktrees', 'worktrees']) {
		rgArgs.push('--glob', `!**/${worktree}`, '--glob', `!**/${worktree}/**`);
	}
	for (const worktree of worktrees) {
		const relative = path.relative(root, worktree).split(path.sep).join('/');
		if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) continue;
		rgArgs.push('--glob', `!${relative}`, '--glob', `!${relative}/**`);
	}
	rgArgs.push('--', root);

	const percentile = (values, fraction) => {
		const sorted = [...values].sort((a, b) => a - b);
		return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
	};
	const summarize = (values) => ({
		firstMs: Number((values[0] ?? 0).toFixed(2)),
		warmP50Ms: Number(percentile(values.slice(1), 0.5).toFixed(2)),
		warmP95Ms: Number(percentile(values.slice(1), 0.95).toFixed(2)),
	});
	const baselineTimes = [];
	const rebuildTimes = [];
	let baselineCount = 0;
	let indexCount = 0;
	let indexedFiles = 0;

	for (let round = 0; round < rounds; round++) {
		const measureBaseline = () => {
			const started = performance.now();
			const result = spawnSync(rg, rgArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
			if (result.status !== 0 && result.status !== 1) {
				throw new Error(result.stderr || `Cursor rg exited with ${result.status}`);
			}
			baselineCount = result.stdout.split('\0').filter((file) => file.toLowerCase().includes(query.toLowerCase())).length;
			baselineTimes.push(performance.now() - started);
		};
		const measureRebuild = async () => {
			invalidateFilePathIndex(root);
			const started = performance.now();
			const result = await searchFilePathIndex(root, query, { limit: 500, worktreeRoots: worktrees });
			rebuildTimes.push(performance.now() - started);
			indexCount = result.files.length;
			indexedFiles = result.indexedFiles;
		};

		if (round % 2 === 0) {
			measureBaseline();
			await measureRebuild();
		} else {
			await measureRebuild();
			measureBaseline();
		}
	}

	const warmTimes = [];
	for (let index = 0; index < rounds; index++) {
		const started = performance.now();
		await searchFilePathIndex(root, query, { limit: 500, worktreeRoots: worktrees });
		warmTimes.push(performance.now() - started);
	}

	console.log(JSON.stringify({
		root,
		query,
		rg,
		registeredWorktrees: worktrees.length,
		coverage: 'Cursor rg --files --hidden --no-ignore with the same metadata, conventional worktree, and registered worktree excludes as FilePathIndex',
		iterations: rounds,
		baselineMatches: baselineCount,
		indexMatches: indexCount,
		indexedPaths: indexedFiles,
		osPageCache: 'not flushed; first measurement is process-cold only',
		baselineRg: summarize(baselineTimes),
		forcedIndexRebuild: summarize(rebuildTimes),
		warmIndexQuery: summarize(warmTimes),
		medianRebuildDeltaMs: Number((percentile(rebuildTimes, 0.5) - percentile(baselineTimes, 0.5)).toFixed(2)),
	}, null, 2));
}
