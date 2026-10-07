# Source Observer

A lightweight codebase viewer for [Obsidian](https://obsidian.md). Browse any folder on disk, read files with syntax highlighting, and review git changes — without leaving your vault.

This repository extends [IceKhan13/obsidian-source-observer](https://github.com/IceKhan13/obsidian-source-observer)
with PHP language navigation, fuzzy quick open, source tabs and additional editor themes.
Originally created by [Iskandar Sitdikov](https://github.com/IceKhan13).
This fork is maintained by [Foksler](https://github.com/Foksler).
The original author's MIT licence and Git history are preserved.

![Source Observer](obsidian-plugin.png)

## Features

- **File tree** — open any folder, navigate directories, see file-type icons with language colours
- **File actions** — right-click a tree row or press Shift+F10 to copy its absolute or project-relative path, reveal it in Finder, or open its folder in Terminal on macOS. Files also offer **Delete**, which moves the file to the system Trash and closes its code/diff tabs; folders cannot be deleted.
- **Syntax highlighting** — PHP, Go, JS/TS, Python, Rust, CSS, HTML, JSON and Markdown; choose Cursor Monokai Pro, VS Code Dark+, One Dark or your Obsidian theme
- **Language navigation** — local Intelephense for PHP and opt-in gopls for Go: definitions, references, hover documentation and symbols
- **Quick open** — search filenames and paths with fuzzy matching in a separate keyboard-driven picker
- **Source tabs** — open multiple files and diffs, with cursor and scroll position restoration
- **Folder tabs** — open several folders from the toolbar, switch between them above the file tree, and close a folder with its × button. Each folder keeps its own files, cursor positions, navigation history, and search while the view is open; the folder list and active folder also survive a restart.
- **Git diff** — changed files listed in the sidebar with M/A/D badges and new/modified counts; click any file to see its diff or full content
- **Collapsible sections** — Files and Changes panels collapse independently
- **Search** — search content with regex and filters, or search filenames; worktrees are excluded by default and can be included
- **Search modes** — keep the VS Code sidebar, or use PhpStorm-style Search Everywhere and Find in Files windows with a source preview
- **Keyboard shortcuts** — record, clear or reset view shortcuts in the plugin settings

## Usage

1. Click the `</>` icon in the ribbon or run **Open Source Observer** from the command palette
2. Select the **folder+** icon in the toolbar to open one or more directories on your machine
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

Use Node.js 24 or newer. CI checks Node.js 24 and 26; release builds use Node.js 24.
To install a build, copy the three release files
from the repository root as described above; preserve an existing `data.json`
when updating the plugin. This repository is not installed through the Obsidian
community catalog automatically.

## License

MIT

## Local code navigation

Enable **Settings → Source observer → Replace Obsidian file explorer** to put
source folders, folder tabs, search and Git changes in the left Files panel while
Source Observer is active. Selecting its main tab or ribbon icon shows the source
tree; switching to a note restores Obsidian's Files panel. Clicking within the
sidebar keeps the current workspace context. Code and diffs open in the main tab.
Switching the setting off, closing Source Observer or disabling the plugin restores
Files. Moving the tree preserves open source files and folder state; the setting
is off by default.

**Changes** and its resize divider appear only for a Git working tree. Selecting a
folder in the tree or opening a source file selects its owning repository, including
nested repositories and Git worktrees. A non-Git selection hides the section.

Choose **Settings → Source observer → Search mode**:

- **VS Code** (default) keeps sidebar content search and the existing quick-open picker.
- **PhpStorm** routes quick open and workspace search to a single modal. Press
  **Shift twice** while Source Observer has focus, select the **Search everywhere**
  toolbar button, or run the **Search everywhere** command. **All** searches files,
  PHP and Go symbols, the plugin's navigation actions and every text occurrence. Named
  results and text matches share a compact list above a read-only source preview.
  **Search filters** (or **F6**) reveals the folder scope and search options. **Search in**
  selects all open folders or a specific folder; choosing a result switches to its
  folder before opening the file. Overlapping folders do not duplicate matches.
  Text totals cover the entire search, with **Load more** exposing results beyond
  the first page. An empty **All** query shows
  files opened during this view session. **Files**, **Classes**, **Symbols**,
  **Actions** and **Text** narrow the search. **Tab / Shift+Tab** changes category,
  **↑↓** or a single click previews a result; **Enter** or a double-click opens it.
  **Esc** closes the window. The window has no close button.
  **Ctrl+↑ / Ctrl+↓** jumps to the first or last result.
  **Alt+↓ / Alt+↑** jumps to text or named results. The query, filters and
  folder scope are retained when you reopen the window during this view session.
  **Cmd/Ctrl+P** opens **Files**. **Cmd/Ctrl+Shift+F** opens a separate **Find in files** window.
  Text supports match case, whole words, regex and include/exclude globs;
  file lookup supports fuzzy names, CamelCase abbreviations and path filters.
  The modal's worktree toggle applies to files and text for that window; PHP
  indexing follows the plugin's **Include worktrees** setting. **Classes** and
  **Symbols** require PHP language navigation. Document symbols continue using
  the current-file picker. Results come from the selected folders and local PHP
  server; the plugin makes no network requests for search. This implements the
  source-navigation parts of Search Everywhere, without PhpStorm's Git,
  calculator, global IDE settings or plugin-management providers.

**Find in files** searches only the active folder tab. Its area tabs select
**In Project** (the active folder), **Module** (a Composer project inside it),
**Directory** (a selected directory, optionally recursive), or **Scope**
(project files, open files, the current file or a custom path scope). When the
file tree has focus, the shortcut starts in **Directory** using the selected
folder or the selected file's parent. The directory remains editable, within
the active folder. Include/exclude globs are relative to the selected search
root; comma-separated file masks such as `*.php,*.ts` further restrict results.
Match case, whole words, regex and worktree inclusion are available.
The file mask sits in the window header. **Search filters** reveals the path
filters and worktree toggle above the search field. Result snippets show syntax colors and highlighted
matches; the preview header separates the filename from its relative directory.
The **?** button beside **.*** opens a regular expression syntax reference with
examples. Closing help restores the search field without changing the query.
Click a row or use **↑↓** to inspect its source in the lower preview without
changing the main file. **Enter** or a double-click opens the matching location.
Drag the horizontal divider to resize results and preview in either search window;
the divider also supports **↑↓** when focused.
**Load more** reveals further results while the
counter covers the entire search. Query and filter state are retained per
folder while the view is open.

Under **Settings → Source observer → Keyboard shortcuts**, select a shortcut
field and press the desired combination. **Clear shortcut** removes it and
**Restore default shortcut** restores its default; conflicting assignments are
rejected. Changes apply immediately while Source Observer has focus, including
search in the current file and history navigation in the code viewer.
**Double shift search** can be disabled independently. Plugin commands can
also receive global shortcuts in Obsidian's **Hotkeys** settings.

This desktop plugin reads the folder you select outside the vault. Source files
are read-only: navigation, search and diffs never save changes to the codebase.

- **Language navigation:** Cmd-click (Ctrl-click on Windows/Linux) or F12 opens a
  definition. Clicking a declaration shows usages. Shift+F12 opens references;
  select a result to navigate to its file. Hover displays documentation from the enabled language server.
  Use Cmd+[ / Cmd+] or the toolbar arrows to return and move forward.
- **Symbols:** Cmd+Alt+O lists the current PHP or Go file's symbols. Cmd+T searches
  workspace symbols across enabled languages, including nested Composer and Go projects.
  These actions are also available in the command palette and toolbar.
- **Quick open:** in VS Code mode, Cmd+P or Cmd+Shift+O opens a separate file picker for the
  selected folder, regardless of the current file or language navigation settings.
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
- **Locate:** the crosshair toolbar button **Locate current file in tree** reveals
  the active source or diff file, expands its parent folders, clears the tree
  filter and scrolls to the selected file. It is also available in **Actions**.
- **Folder icons:** bundled Material Icon Theme artwork identifies common project
  folders such as app, config, database, routes and tests. A right-pointing chevron
  marks a collapsed folder; a downward chevron and open icon mark an expanded one.
- **Context menu:** right-click a file or folder (including the project root and
  filtered files) for **Copy path**, **Copy relative path**, **Reveal in Finder**,
  and **Open in terminal**. Relative paths start at the active project folder
  (`.` for the root itself); **Copy path** uses the absolute path.
  On macOS, Terminal opens the selected directory or
  the file's parent; other desktop platforms support copying and revealing only.
  **Shift+F10** opens the same menu for the focused tree row.
- **Git:** select **Hide Git changes** to reduce the panel to its header at the
  bottom of the sidebar; select **Restore Git changes** to expand it. The choice
  persists across reloads. Drag the horizontal border above **Changes** to resize
  the panel; it starts at its minimum height of 80px so Files uses the maximum
  available space.
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
hover or symbols. Go navigation is opt-in: enable **Go language server** in **Settings → Source observer**.
Install Go and `gopls` (`go install golang.org/x/tools/gopls@latest`), then set
**Go path** and **Gopls path** if auto-detection does not find them. The plugin
launches gopls directly and makes the selected Go executable available on its PATH.
A containing `go.work` takes precedence over `go.mod`; nested modules are discovered
for workspace symbol search. `go.mod`, `go.work` and sum files also use their
corresponding gopls language identifiers. Worktrees are excluded by default.
Gopls may download dependencies through the Go module proxy while resolving imports.
Switching folders, changing navigation settings, restarting navigation or closing
the view stops the old server processes. Go to implementation and editing/refactoring
are not exposed.

Run the checks with Node.js 24 or newer: `npm test`, `npm run lint` and `npm run build` before installing the three
release files into `<vault>/.obsidian/plugins/source-observer/`. Real-server
tests are skipped when their binaries are absent; search/framing tests always run.
For Go integration tests with explicit paths, set `SOURCE_OBSERVER_GO` and
`SOURCE_OBSERVER_GOPLS` to the executable paths before running `npm test`.

For an opt-in filename benchmark against Cursor's bundled ripgrep, run
`node tests/searchBenchmark.mjs /absolute/project/path StatsController 10`.
The comparison uses identical file coverage and worktree exclusions. It measures
the search engines rather than Cursor's interface, and does not flush OS caches.
