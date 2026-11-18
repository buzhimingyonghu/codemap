# Codemap

[中文](README.md)

A small, offline macOS code editor for Apple Silicon: files, editing, build, Git, and a
debugger with call stack. Everything else is meant to arrive as plugins you write yourself.

- Electron 44 + React 19 + Monaco 0.57 (the VS Code editor core), TypeScript everywhere
- No marketplace, no telemetry, no update checks. Web content cannot reach the network.
- Debugging via `lldb-dap` from Xcode Command Line Tools (C, C++, Objective-C, Swift, Rust)
- Go to definition, references, hover, and outline via LSP: clangd and sourcekit-lsp ship with
  Xcode CLT; rust-analyzer, gopls, pyright, and typescript-language-server are used when installed

## Run

```sh
./scripts/codemap.sh doctor   # check macOS, Node, git, Xcode CLT, lldb-dap
./scripts/codemap.sh setup    # npm install + Electron runtime
./scripts/codemap.sh dev      # hot-reloading dev build
```

Package the arm64 app (ad-hoc signed, runs on this Mac):

```sh
./scripts/codemap.sh package  # release/Codemap-<version>-arm64.dmg, .zip, and mac-arm64/Codemap.app
./scripts/codemap.sh install  # build the .app and install it into /Applications
```

Run `./scripts/codemap.sh` with no arguments for every command. The same tasks are available as
npm scripts (`dev`, `start`, `check`, `test:e2e`, `package`, `package:dir`, `icon`, `clean`,
`codemap:validate`).

Other Macs will show a Gatekeeper warning for an ad-hoc signed app. Set `mac.identity` in
`electron-builder.yml` to a Developer ID certificate and enable `notarize` to fix that.

## Use

| Action | Shortcut |
| --- | --- |
| Open folder | ⌘O |
| Go to file / command palette | ⌘P / ⇧⌘P |
| Search in files | ⇧⌘F |
| Save / save all | ⌘S / ⌥⌘S |
| Build | ⇧⌘B |
| Start or continue debugging | F5 |
| Step over / into / out | F10 / F11 / ⇧F11 |
| Toggle breakpoint | F9 or click the gutter |
| Go to definition | F12 or ⌘-click |
| Peek definition / implementation / references | ⌥F12 / ⌘F12 / ⇧F12 |
| Symbols in file | ⇧⌘O |
| Back / forward | ⌃- / ⌃⇧- |
| Last edit location | ⌘K ⌘Q |
| Sidebar / panel | ⌘B / ⌘J |
| Toggle terminal / new terminal | ``⌃` `` / ``⌃⇧` `` |

Search (the magnifier in the activity bar, or ⇧⌘F, seeded with the editor selection) finds text
across the folder, with match case, whole word, and regex toggles, include/exclude globs, and
replace (`$1` and `$<name>` in regex mode). Unsaved editors are searched and replaced in place
(undoable); other files are rewritten on disk. Git repositories respect `.gitignore`; binary files
and files over 4 MB are skipped, and results stop at 2000.

In the file tree: ⌘C / ⌘X / ⌘V copy, cut, and paste (also from and to Finder), ⌘D duplicates,
dragging moves within the folder (⌥ to copy), and dropping files or folders from Finder copies
them in. Name conflicts become `name copy`, `name copy 2`, like Finder. Destinations are always
inside the open folder, and moves never touch files outside it.

Map mode (the switch at the right of the title bar, or ⇧⌘M) replaces the file tree with a map of
the project: folders are territories, files are towns, and the same files always draw the same
map. Click a territory or zoom toward it to enter it; Esc, a click on empty space, or zooming out
goes back up; Home shows everything. Clicking a town lands on it and raises the editor; Esc (or
the MAP button) returns to the map. Brightness follows how often you open a file here (14-day
half-life) and recent git churn; PEAKS lists the busiest files in view, and orange marks
uncommitted changes. Right-click a town or territory for file actions, or drop files onto a
territory. Only tracked and non-ignored files are shown, up to 20,000.

Items whose names share a prefix are gathered into a district with a glowing border and a tag
such as `add 51`, however few they are; leading numbers like `0001_` are skipped, and large
districts split again (`api` into `ap`, `eu`, `na`). In folders with many files the map opens at
a zoom where every name is readable, laid out in name order column by column; scroll or drag to
see the rest, pinch or ⌘-scroll to zoom, and press 0 for the whole folder. PREFIXES lists the
districts and jumps to them; FREQUENT lists the folders you enter most.

Code map mode (the third button of that switch, or ⇧⌘Y) shows a codemap/v1 node library found in
the open folder or up to two levels below it (opening `~/dev/shop` finds the library inside; with
several you pick one, with none you choose a folder). A click shows a node's details; double-click a
node marked ⤢ or zoom toward it to enter it; the breadcrumbs, the up arrow, or zooming out go back.
The Flow tab on the right plays a flow step by step across levels; clicking a node, edge, ball, or
struct field shows its interface, data fields, code excerpt, and knowledge links. The pencil in the
details edits a node's name, brief, description, trigger, and result. "Edit Layout" lets you drag
nodes and edge ends, then Save writes `layout` / `ports` into the map YAML. Balls flow in three
modes (Off / Focus / All); Focus, the default, only runs them on the hovered node or selected line. "Open in Editor" raises the editor at the anchored lines (Esc
returns), and the editor's context menu has "Show in Code Map". The requirement list overlays a
change set with added / changed / removed marks and badges; checks show in the toolbar and in the
Code Map panel tab. Library edits reload the map, and nodes whose code was saved get a dot.

See the [changelog](#changelog) at the end for what changed in each update.

Reading outside the open folder (a repository in the Go module cache, say) asks once in a native
dialog per folder; access is read-only and can be revoked in Settings → Code Map. The home folder
and `/` cannot be granted as a whole.

The Terminal tab in the bottom panel is a real terminal running your login shell in the open
folder, with colors and full-screen programs (vim, top). Several can be open at once; switching
folders closes them and starts fresh in the new folder. ⌘K clears, ⌘C / ⌘V copy and paste.

Per-folder build command and debug program live in Settings (⌘,). Build errors in the usual
`file:line:col: error: …` formats (clang, gcc, swiftc, rustc, go, tsc) show in Problems and
jump to the source. Git pull and push are explicit actions that use your existing git credentials.

For C-family projects, clangd needs compile commands to jump from a call into another `.c` file.
Codemap uses `compile_commands.json` (root or `build/`), then `compile_flags.txt`, and otherwise
generates `.codemap/compile_commands.json` from the sources it finds. Targets outside the folder
(SDK headers) open read-only. Server status is in the status bar and in Settings.

Servers installed by `go install`, `cargo`, or `npm -g` are found in `~/go/bin` (or `$GOPATH/bin`),
`~/.cargo/bin`, and the npm global prefix even when those are not on PATH. When the open folder
contains several repositories, each file is served by an instance rooted at its nearest project
marker (`go.mod`, `Cargo.toml`, `package.json`, `.git`, …), as if that repository were opened alone.

## Architecture

```text
src/main        Electron main process: windows, IPC, files, tasks, git CLI, DAP client, plugin discovery
src/preload     The only bridge to the renderer: window.codemap (typed in src/shared/api.ts)
src/shared      Types and pure helpers used by both sides (paths, diagnostics, git parsing, code map rules)
src/renderer    React workbench, Monaco, design tokens, plugin host
plugins/        Bundled plugins (copied into the app as Resources/plugins)
```

Code map rules: indexing, validation, and requirement change sets for codemap/v1 live in
`src/shared/codemap/codemap.mjs`; reading a node library from disk is `src/main/codemap/loadLibrary.mjs`.
This is the only copy (the old `~/dev/ai/codemap-site` is frozen). The sample library used by the
tests is in `tests/fixtures/codemap-demo/`. Validate a library from the command line:

```sh
./scripts/codemap.sh codemap [library] [--index] [--all]   # defaults to the current folder
```

Security model: the renderer is sandboxed with context isolation, every path is resolved inside
the open folder, and the default session cancels all non-local requests. Plugins that need HTTP
call `ctx.net.fetch`, which runs in the main process and only allows origins listed in their manifest.

## Writing plugins

A plugin is a folder with `plugin.json` and an ES module. Put it in
`~/Library/Application Support/Codemap/plugins/<name>/`, then use Plugins → Reload.
A user plugin with the same id as a bundled one replaces it.

```json
{
  "id": "repo-map",
  "name": "Repo Map",
  "version": "0.1.0",
  "renderer": "index.js",
  "permissions": { "network": ["https://api.example.com"] },
  "contributes": { "commands": [{ "id": "repo-map.build", "title": "Build Repo Map" }] }
}
```

```js
export function activate(ctx) {
  ctx.commands.register('build', async () => {
    const files = await ctx.workspace.findFiles()
    ctx.ui.notify(`${files.length} files`)
  })
  ctx.views.register('map', {
    title: 'Repo Map',
    location: 'panel', // or 'sidebar'
    mount(element) {
      element.textContent = 'Render anything here: React, D3, Three.js, an iframe…'
      return () => element.replaceChildren()
    }
  })
}
```

The full API is in `src/renderer/src/plugins/api.ts`: `commands`, `views`, `workspace`, `editor`,
`git`, `ui`, `storage`, `net`, and `services`. Services let plugins cooperate without importing each
other. For example an AI plugin calls `ctx.services.provide('ai', { ask })` and a diagram plugin uses
`ctx.services.get('ai')`. `plugins/hello-codemap` is a complete working example.

Plugin views inherit the theme CSS variables (`--bg-editor`, `--fg-primary`, `--accent`, …), so
custom UI matches the active theme automatically.

## Theming

All chrome colors, radii, and motion timings are CSS variables in
`src/renderer/src/styles/tokens.css`; the matching Monaco palettes are in
`src/renderer/src/editor/themes.ts`. Add a theme by adding a block to both.

## Tests

```sh
npm run typecheck
npm test                                                # unit tests
npm run build && npm run test:e2e                       # drives the dev build
node tests/e2e/smoke.mjs --app release/mac-arm64/Codemap.app   # drives the packaged app
```

The end-to-end test creates a temporary C project, then opens, edits, saves, builds with an error,
jumps to the diagnostic, commits, diffs, debugs to a breakpoint, steps, and checks the plugin view.

## Changelog

By date, IDE changes first, then the code map. The code map's node library format is defined by the templates in `agent/create/`.

### 2026-11-08

- Code map, added: to-dos from two sources, `issues` on a node (`desc`, optional `code`) and the `.md` notes in each folder's `todo/` (titled by their first heading). Nodes show an orange count that includes everything inside them; the details list them like knowledge links (an issue's code expands in place, a note opens in the editor); a toolbar chip and a group in the Code Map panel list all of them, folders with no node yet included

### 2026-11-05

- Code map, added: lines that start a goroutine or thread (`mode: go` / `thread`) are purple and one-way, with a "Goroutine" / "Thread" tooltip, and keep their colour on hover; function types `fn.type: listen` (a ripple inside the node) and `fn.type: timer` with `fn.every` (the node lights up every period); loops are found from cycles of ordinary lines, framed, and dragged as one, with back lines along the frame's left side
- Code map, improved: gate branches can carry condition text (`when: is leader`) and there can be more than two; `edge-lift` merges the links of parallel lines between the same pair; automatic layout keeps other nodes off loop frames; `edge-mutual` also accepts a line to a node inside the other end (`place-order → shared` matches `admit → group-state`), and a grouping box with no lines of its own is not checked
- Code map, breaking: `fn.type` takes one value, `timer` needs `every` (`fn-type`); `mode` is `go` / `thread` on call / send lines only (`edge-mode`)

### 2026-11-04

- IDE, added: back / forward (← → in the title bar, ⌃- / ⌃⇧-, or the mouse side buttons) records every file switch and every cursor jump of more than 10 lines; Go to Last Edit Location (⌘K ⌘Q); Find in Folder… / Find in File… in the file tree and project map context menus
- IDE, improved: history entries follow edits above them and file renames; ⌃- / ⌃⇧- work in the terminal and in inputs, and rapid presses are queued; previewing search results with the arrow keys counts as one step
- IDE, fixed: switching files by tab, tree, or quick open was not recorded; going back across files dropped the forward history; entries for deleted files are skipped, and history is cleared when the folder changes
- Code map, added: heartbeats are marked on links (`heartbeat: true` or a period in `links.yaml`) and shown as a pulsing dot on the business line; edit a node's name, brief, description, trigger, and result from the details; three flow modes (Off / Focus / All)
- Code map, improved: Focus mode keeps the map calm (faint direction hints, balls only on the hovered node or selected line); a click shows details, a double-click enters; edge handles keep a fixed on-screen size; the leave prompt defaults to Cancel
- Code map, fixed: with the requirement layer on, edge-end drags did nothing and Cancel left nodes where they were dragged; saving edge ends failed with "Bad ports"
- Code map, breaking: `signal` / `period` on edges are errors (`edge-heartbeat`)

### 2026-11-03

- IDE, added: the Search view (activity bar or ⇧⌘F) with match case, whole word, regex, include / exclude globs, and replace (per match, per file, or all; `$1` and `$<name>` in regex mode); unsaved editors are searched and replaced in place (undoable); results refresh on save and on disk changes and stop at 2000
- Code map, added: Edit Layout with explicit Save / Cancel / Undo, writing `layout` / `ports` into the map YAML; `dock: left / right`; rules `edge-mutual` and `fn-trigger`; protocol `tcp`
- Code map, improved: placement follows lanes only and lanes are not drawn; collapsible link rows; the flow moved to a tab on the right; larger, accurate edge handles
- Code map, fixed: `{ ref }` was treated as containment (false `edge-lift` and cycle reports); edge handles sat off the line on two-way pairs
- Code map, breaking: Lock Layout removed; `edge-refined` replaced by `edge-mutual`

### 2026-11-02

- IDE, added: the project map (⇧⌘M), with bordered prefix districts, long folders listed in tree order and pannable, a prefix index for quick jumps, distinct colors for neighboring areas, folder visit counts with a Frequent list, and an adjustable items-per-screen setting; Chinese / English UI including the native menu; an integrated terminal (⌃` to toggle, ⌃⇧` for a new one, ⌘K to clear, several sessions)
- IDE, improved: map areas follow the file tree order from top to bottom; folded folder chains show only their own name; framing accounts for the side panel so edge nodes can be dragged to the middle
- Code map, added: the code map, ported from the frozen `codemap-site` (⇧⌘Y); read-only access prompts for folders outside the workspace; expandable code excerpts; `./scripts/codemap.sh codemap`
- Code map, improved: every code location carries its own `repo`
- Code map, fixed: paths doubled by `repo.dir`; data entries' code could not be opened or previewed
- Code map, breaking: `repo.dir` is no longer supported (`repo-dir`)
