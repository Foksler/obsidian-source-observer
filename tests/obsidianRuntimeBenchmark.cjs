// Execute inside the official Obsidian CLI eval; timers run in the renderer, not in the CLI.
// require('/absolute/repo/tests/obsidianRuntimeBenchmark.cjs')(app, CONFIG, OUTPUT)
module.exports = async function run(app, configPath, outputPath) {
 const fs = require('fs'), path = require('path'), crypto = require('crypto');
 const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
 const plugin = app.plugins.plugins['source-observer'];
 const view = require('./helpers/installedViewAccess.cjs')(app.workspace.getLeavesOfType('source-observer')[0]?.view);
 if (!plugin || !view) throw new Error('Open Source Observer in the target vault first');
 if (view.codePane.dirty || view.codePane.conflictPath) throw new Error('Save or resolve the current document before benchmarking');
 const digest = data => crypto.createHash('sha256').update(data).digest('hex');
 const pluginDir = path.join(app.vault.adapter.getBasePath(), app.vault.configDir, 'plugins', 'source-observer');
 const settingsPath = path.join(pluginDir, 'data.json'), settingsBytes = fs.readFileSync(settingsPath);
 const original = { settings: JSON.parse(JSON.stringify(plugin.settings)), folder: view.repoPath,
  folders: [...view.folderPaths], sessions: new Map(view.folderSessions), previews: new Set(view.previewFiles),
  editor: view.codePane.captureSession(), tabs: view.editorTabs.captureState(), search: view.searchPanel.captureState(),
  treeQuery: view.treeSearchInput.value, changesQuery: view.changesQuery, recentFiles: [...view.recentFiles] };
 const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
 const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
 const results = { schema: 1, startedAt: new Date().toISOString(), rounds: config.rounds, warmups: config.warmups,
  profile: 'Existing installed plugin; real Obsidian renderer; PHP/Go disabled only during measurement; two animation frames included; no edits to project files',
  environment: { node: process.version, electron: process.versions.electron, chrome: process.versions.chrome,
   appVersion: config.obsidianVersion, pluginSha256: digest(fs.readFileSync(path.join(pluginDir, 'main.js'))),
   configSha256: digest(fs.readFileSync(configPath)), harnessSha256: digest(fs.readFileSync(__filename)),
   settings: Object.fromEntries(['showHidden', 'includeWorktrees', 'searchMode', 'syntaxTheme', 'fontSize', 'sidebarFontSize', 'replaceFileExplorer', 'excludedFiles', 'phpLsp', 'goLsp'].map(key => [key, original.settings[key]])) }, projects: [] };
 try {
  plugin.settings.phpLsp = false; plugin.settings.goLsp = false; view.syncNavigation();
  for (const project of config.projects) {
   const root = project.root, metrics = {};
   const measure = async (name, action, prepare = async () => {}) => {
    const samples = [], heapBytes = []; let invariant;
    for (let round = -config.warmups; round < config.rounds; round++) {
     await prepare();
     const start = performance.now();
     const result = await action();
     await paint();
     const elapsed = performance.now() - start;
     const actual = JSON.stringify(result);
     invariant ??= actual;
     if (invariant !== actual) throw new Error(`${project.id}/${name}: unstable output`);
     if (round >= 0) { samples.push(elapsed); heapBytes.push(performance.memory?.usedJSHeapSize ?? null); }
    }
    metrics[name] = { p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95), samplesMs: samples, heapBytes, output: JSON.parse(invariant) };
   };
   await measure('folderActivationPaint', async () => {
    await view.activateFolder(root);
    if (view.repoPath !== root || !view.fileTree.treeRoot) throw new Error('Folder did not activate');
    return { rootRows: view.fileTree.container.querySelectorAll('.so-tree-row').length };
   }, async () => { await view.activateFolder(''); view.folderSessions.delete(root); });
   await measure('treeReloadPaint', async () => { await view.fileTree.loadPath(root); return { rows: view.fileTree.container.querySelectorAll('.so-tree-row').length }; });
   await measure('treeFilterPaint', async () => { await view.fileTree.search(project.fileQueries[0]); return { rows: view.fileTree.container.querySelectorAll('.so-tree-row').length }; }, async () => { await view.fileTree.search(''); });
   await view.fileTree.search('');
   const sample = path.join(root, project.sampleFile);
   await measure('sourceOpenPaint', async () => {
    await view.openTab({ filePath: sample, kind: 'code' });
    if (view.codePane.getCurrentFile() !== sample) throw new Error('Wrong source file');
    return { characters: view.codePane.getEditor().state.doc.length };
   }, async () => { view.codePane.suspend(); });
   await view.refreshChanges();
   const changed = view.allChanges.find(entry => !entry.code.includes('D') && /\.(md|ts|php|json|mjs)$/.test(entry.file)
    && fs.existsSync(path.join(view.gitRoot, entry.file)) && fs.statSync(path.join(view.gitRoot, entry.file)).size < 512000);
   if (changed) {
    const target = path.join(view.gitRoot, changed.file);
    await measure('diffOpenPaint', async () => {
     await view.openTab({ filePath: target, kind: 'diff' });
     return { characters: view.rightPane.textContent.length, diffFile: path.relative(root, target) };
    });
   } else metrics.diffOpenPaint = { skipped: 'No eligible changed text file; never generate changes in a real project' };
   if (/\.md$/i.test(sample)) await measure('markdownPreviewPaint', async () => {
    await view.showPreview(sample); return { rendered: !!view.rightPane.querySelector('.markdown-rendered') };
   });
   results.projects.push({ id: project.id, root, sampleFile: project.sampleFile, metrics });
  }
  // Quiescent source-view baseline. Whole-renderer CPU/memory includes other plugins.
  await view.activateFolder(original.folder);
  await paint();
  const start = performance.now(), cpu = process.cpuUsage(), delays = [];
  let previous = performance.now();
  const timer = setInterval(() => { const now = performance.now(); delays.push(Math.max(0, now - previous - 50)); previous = now; }, 50);
  await new Promise(resolve => setTimeout(resolve, 10000));
  clearInterval(timer);
  const usage = process.cpuUsage(cpu);
  results.idle = { durationMs: performance.now() - start, rendererCpuMs: (usage.user + usage.system) / 1000,
   timerDelayP50Ms: percentile(delays, .5), timerDelayP95Ms: percentile(delays, .95), samplesMs: delays,
   heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null };
 } finally {
  await view.activateFolder('');
  plugin.settings = original.settings;
  view.folderPaths = original.folders;
  view.folderSessions = original.sessions;
  if (original.folder) view.folderSessions.set(original.folder, { editor: original.editor, tabs: original.tabs,
   search: original.search, treeQuery: original.treeQuery, changesQuery: original.changesQuery });
  view.previewFiles = original.previews;
  await view.activateFolder(original.folder);
  view.recentFiles = original.recentFiles;
  plugin.settings = original.settings;
  fs.writeFileSync(settingsPath, settingsBytes);
  results.settingsRestored = digest(fs.readFileSync(settingsPath)) === digest(settingsBytes);
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2) + '\n');
 }
 return JSON.stringify({ projects: results.projects.map(project => ({ id: project.id, p50: Object.fromEntries(Object.entries(project.metrics).map(([name, metric]) => [name, metric.p50Ms ?? metric.skipped])) })), settingsRestored: results.settingsRestored });
};
