// Measures actual autosave and external-change observation using a disposable /private/tmp fixture only.
module.exports = async function run(app, configPath, outputPath) {
 const fs = require('fs'), path = require('path'), crypto = require('crypto');
 const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
 const plugin = app.plugins.plugins['source-observer'], view = require('./helpers/installedViewAccess.cjs')(app.workspace.getLeavesOfType('source-observer')[0]?.view);
 if (!view || view.codePane.dirty || view.codePane.conflictPath) throw new Error('Open a clean Source Observer view first');
 const settingsPath = path.join(app.vault.adapter.getBasePath(), app.vault.configDir, 'plugins/source-observer/data.json');
 const bytes = fs.readFileSync(settingsPath), settings = JSON.parse(JSON.stringify(plugin.settings));
 const original = { folder: view.repoPath, folders: [...view.folderPaths], sessions: new Map(view.folderSessions),
  editor: view.codePane.captureSession(), tabs: view.editorTabs.captureState(), search: view.searchPanel.captureState(),
  treeQuery: view.treeSearchInput.value, changesQuery: view.changesQuery, previews: new Set(view.previewFiles), recent: [...view.recentFiles] };
 const root = fs.mkdtempSync('/private/tmp/source-observer-perf-'), target = path.join(root, 'sample.ts');
 const initial = Array.from({ length: 500 }, (_, i) => `export const item${i} = ${i};`).join('\n') + '\n';
 fs.writeFileSync(target, initial);
 const result = { schema: 1, fixtureBytes: Buffer.byteLength(initial), rounds: config.rounds, warmups: config.warmups,
  profile: 'Disposable non-Git folder; LSP disabled; default autosave debounce retained; filesystem checks every 10 ms; no project file edited',
  harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), metrics: {} };
 const waitFor = async predicate => {
  const deadline = performance.now() + 8000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error('Timed out waiting for plugin interaction'); await new Promise(resolve => setTimeout(resolve, 10)); }
 };
 const summarize = values => { const sorted = [...values].sort((a, b) => a - b); return { p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], samplesMs: values }; };
 try {
  plugin.settings.phpLsp = false; plugin.settings.goLsp = false; view.syncNavigation();
  await view.activateFolder(root); await view.openTab({ filePath: target, kind: 'code' });
  const autosave = [], external = [], watchers = [];
  for (let i = -config.warmups; i < config.rounds; i++) {
   const text = initial + `// edit ${i}\n`, start = performance.now(), editor = view.codePane.getEditor();
   editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
   await waitFor(() => fs.readFileSync(target, 'utf8') === text && !view.codePane.dirty);
   if (i >= 0) autosave.push(performance.now() - start);
   const diskText = initial + `// external ${i}\n`, reloadStart = performance.now();
   fs.writeFileSync(target, diskText);
   await waitFor(() => view.codePane.getEditor().state.doc.toString() === diskText);
   if (i >= 0) { external.push(performance.now() - reloadStart); watchers.push(view.watchers.length); }
  }
  result.metrics.autosave = summarize(autosave); result.metrics.externalReload = summarize(external);
  result.watchersPerSample = watchers;
 } finally {
  await view.activateFolder(''); plugin.settings = settings; view.folderPaths = original.folders; view.folderSessions = original.sessions;
  if (original.folder) view.folderSessions.set(original.folder, { editor: original.editor, tabs: original.tabs, search: original.search, treeQuery: original.treeQuery, changesQuery: original.changesQuery });
  view.previewFiles = original.previews; await view.activateFolder(original.folder); view.recentFiles = original.recent;
  plugin.settings = settings; fs.writeFileSync(settingsPath, bytes);
  result.settingsRestored = fs.readFileSync(settingsPath).equals(bytes);
  fs.rmSync(root, { recursive: true });
  result.fixtureRemoved = !fs.existsSync(root);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
 }
 return JSON.stringify(result);
};
