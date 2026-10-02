# Source Observer

A lightweight codebase viewer for [Obsidian](https://obsidian.md). Browse any folder on disk, read files with syntax highlighting, and review git changes — without leaving your vault.

This repository extends [IceKhan13/obsidian-source-observer](https://github.com/IceKhan13/obsidian-source-observer)
with PHP language navigation, fuzzy quick open, source tabs and additional editor themes.
The original author's MIT licence and Git history are preserved.

![Source Observer](obsidian-plugin.png)

## Features

- **File tree** — open any folder, navigate directories, see file-type icons with language colours
- **Syntax highlighting** — PHP, JS/TS, Python, Rust, CSS, HTML, JSON and Markdown; choose Cursor Monokai Pro, VS Code Dark+, One Dark or your Obsidian theme
- **PHP navigation** — local Intelephense definitions, references, hover documentation and symbols
- **Quick open** — search filenames and paths with fuzzy matching in a separate keyboard-driven picker
- **Source tabs** — open multiple files and diffs, with cursor and scroll position restoration
- **Git diff** — changed files listed in the sidebar with M/A/D badges and new/modified counts; click any file to see its diff or full content
- **Collapsible sections** — Files and Changes panels collapse independently
- **Search** — search content with regex and filters, or search filenames; worktrees are excluded by default and can be included

## Usage

1. Click the `</>` icon in the ribbon or run **Open Source Observer** from the command palette
2. Click **Open folder…** to select any directory on your machine
3. Browse files in the **Files** panel — click to open with syntax highlighting
4. Switch to the **Changes** panel to see modified, added, and deleted files relative to git HEAD; click any file to view its diff
5. Use **Ctrl+P** or **Ctrl+Shift+O** for quick open (**Cmd** on macOS); use **Ctrl+Shift+F** for content search

## Installation

1. Copy `main.js`, `styles.css`, and `manifest.json` into `<vault>/.obsidian/plugins/source-observer/`
2. Enable the plugin in **Settings → Community plugins**
3. Click the `</>` icon in the ribbon or run **Open Source Observer** from the command palette

## Development

```bash
git clone https://github.com/Foksler/obsidian-source-observer.git
cd obsidian-source-observer
npm ci
npm run dev    # watch mode
npm run build  # production build
```

Use Node.js 22.18 or newer. To install a build, copy the three release files
from the repository root as described above; preserve an existing `data.json`
when updating the plugin. This repository is not installed through the Obsidian
community catalog automatically.

## License

MIT

## Local code navigation

This desktop plugin reads the folder you select outside the vault. Source files
are read-only: navigation, search and diffs never save changes to the codebase.

- **PHP navigation:** Cmd-click (Ctrl-click on Windows/Linux) or F12 opens a
  definition. Clicking a declaration shows usages. Shift+F12 opens references;
  select a result to navigate to its file. Hover displays PHP documentation.
  Use Cmd+[ / Cmd+] or the toolbar arrows to return and move forward.
- **Symbols:** Cmd+Alt+O lists the current PHP file's symbols. Cmd+T searches
  workspace PHP symbols, including Composer projects inside the selected folder.
  These actions are also available in the command palette and toolbar.
- **Quick open:** Cmd+P or Cmd+Shift+O opens a separate file picker for the
  selected folder, regardless of the current file or PHP navigation settings.
  On Windows/Linux use Ctrl instead of Cmd. Type a filename, abbreviation or
  path/name terms, use the arrow keys to select a result and Enter to open it;
  Escape closes the picker. Matching ignores case and tolerates gaps:
  `DashboardController` also finds `DashboardStatsController.php`, and exact
  filename matches rank first. The toolbar and **Quick open file** command open
  the same picker. These shortcuts apply while Source Observer has focus.
- **Search:** Cmd+Shift+F searches file contents. The sidebar's **Files** mode
  and file-tree filter use the same fuzzy filename matching as quick open.
  Match case, whole word, regular expressions, include/exclude globs, line numbers
  and clickable matches are available. Content search respects ignore files and
  skips dependency/build folders. File search and the file-tree filter share a
  cached filename index, including `vendor` and ignored source files; both skip
  `.git`, `.obsidian` and `node_modules`. The hidden-files and worktrees settings
  also apply to quick open. Local ripgrep builds the index when available, with a local
  filesystem fallback; no search data leaves your computer. File creation,
  removal and renaming refresh the index in the background.
- **Worktrees:** duplicate checkouts are excluded by default. Select **Include
  worktrees** in search or settings to show and index them. This restarts PHP
  indexing. The toggle bypasses parent ignore rules for worktree folders, while
  preserving each worktree’s own ignore files for content search and your search
  filters in both modes.
- **Tabs:** source files and diffs have separate closable tabs; switching source
  tabs restores cursor and scroll positions. Long tab rows wrap.
  Arrow keys switch focused tabs.
- **Git:** select **Hide Git changes** to reduce the panel to its header at the
  bottom of the sidebar; select **Restore Git changes** to expand it. The choice
  persists across reloads.
- **Appearance:** Cursor Monokai Pro includes a PHP token palette,
  JetBrains Mono, ligatures, 15px text, four-space tabs and the 120-column ruler.
  Install JetBrains Mono locally for exact font rendering. CodeMirror uses a
  different syntax grammar from Cursor, so some token coloring may differ.

PHP navigation requires a local Node.js executable and Intelephense. The plugin
can auto-detect the server installed by Cursor/VS Code, or you can set both paths
in **Settings → Source observer**. It starts one local server per project, stores
its index under `~/.cache/source-observer-intelephense`, disables telemetry and
stops servers when the view closes. No code is uploaded to an external service.
An optional Intelephense licence is not required for definitions, references,
hover or symbols. Go to implementation and editing/refactoring are not exposed.

Run the checks with Node.js 22.18 or newer: `npm test`, `npm run lint` and `npm run build` before installing the three
release files into `<vault>/.obsidian/plugins/source-observer/`. The real-server
test is skipped if Intelephense is absent; search/framing tests always run.

For an opt-in filename benchmark against Cursor's bundled ripgrep, run
`node tests/searchBenchmark.mjs /absolute/project/path StatsController 10`.
The comparison uses identical file coverage and worktree exclusions. It measures
the search engines rather than Cursor's interface, and does not flush OS caches.
