import { closeTab, getActiveTab, saveActive, saveAll } from './services/documents'
import { registerCommand } from './services/commands'
import { runBuild, stopBuild } from './services/build'
import { control, startDebugging, stopDebugging, toggleBreakpoint } from './services/debug'
import { getActiveEditor } from './services/documents'
import { registerView } from './services/views'
import { goToLastEdit, navigateHistory } from './services/navigation'
import { restartServer } from './services/lsp'
import { closeWorkspace, onDidCloseWorkspace, onDidOpenWorkspace, openFolderDialog, openFolderPath } from './services/workspace'
import { createInMap, initProjectMap, setExplorerMode, showExplorer, toggleProjectMap } from './services/projectMap'
import { chooseLibrary, initCodeMap, reloadCodeMap, revealCodeInMap, toggleCodeMap } from './services/codeMap'
import { initAgent } from './services/agent'
import { initSearch, showSearch } from './services/search'
import { getState, setState } from './state/store'
import { THEMES } from './editor/themes'
import { setTheme } from './workbench/SettingsSheet'
import { loadPlugins } from './plugins/host'
import { LOCALES } from '@shared/i18n'
import { setLocale } from './lib/i18n'
import { DebugView } from './views/DebugView'
import { ExplorerView } from './views/ExplorerView'
import { GitView } from './views/GitView'
import { DebugConsoleView, OutputView, ProblemsView } from './views/PanelViews'
import { PluginsView } from './views/PluginsView'
import { SearchView } from './views/SearchView'
import { TerminalView } from './views/TerminalView'
import { CodeMapProblemsView } from './views/CodeMapProblems'
import { clearTerminal, createTerminal, killAllTerminals, newTerminal, showTerminal, toggleTerminal } from './services/terminals'

let registered = false

// Built-in features register through the same registries plugins use.
export function registerBuiltins(): void {
  if (registered) return
  registered = true
  initProjectMap()
  initCodeMap()
  initAgent()
  initSearch()
  // Shells belong to a folder: switching folders closes them, and a visible terminal panel
  // starts a fresh shell in the new folder.
  const restartTerminals = () => {
    killAllTerminals()
    const state = getState()
    if (state.workspace && state.panelVisible && state.panelView === 'terminal') void createTerminal()
  }
  onDidOpenWorkspace.on(restartTerminals)
  onDidCloseWorkspace.on(killAllTerminals)

  registerView({ id: 'explorer', title: 'Explorer', location: 'sidebar', icon: 'files', order: 1, source: 'core', component: ExplorerView })
  registerView({ id: 'search', title: 'Search', location: 'sidebar', icon: 'search', order: 2, source: 'core', component: SearchView })
  registerView({ id: 'git', title: 'Source Control', location: 'sidebar', icon: 'git', order: 3, source: 'core', component: GitView })
  registerView({ id: 'debug', title: 'Run and Debug', location: 'sidebar', icon: 'bug', order: 4, source: 'core', component: DebugView })
  registerView({ id: 'plugins', title: 'Plugins', location: 'sidebar', icon: 'puzzle', order: 5, source: 'core', component: PluginsView })
  registerView({ id: 'output', title: 'Output', location: 'panel', order: 1, source: 'core', component: OutputView })
  registerView({ id: 'problems', title: 'Problems', location: 'panel', order: 2, source: 'core', component: ProblemsView })
  registerView({ id: 'debugConsole', title: 'Debug Console', location: 'panel', order: 3, source: 'core', component: DebugConsoleView })
  registerView({ id: 'terminal', title: 'Terminal', location: 'panel', order: 4, source: 'core', component: TerminalView })
  registerView({ id: 'codemap', title: 'Code Map', location: 'panel', order: 5, source: 'core', component: CodeMapProblemsView })

  const view = (id: string) => () => setState({ sidebarView: id, sidebarVisible: true })
  const commands: Array<[string, () => unknown, string, string?, string?]> = [
    ['workspace.open', () => openFolderDialog(), 'Open Folder…', 'File', '⌘O'],
    ['workspace.close', () => closeWorkspace(), 'Close Folder', 'File'],
    ['file.new', () => newUntitledFile(), 'New File', 'File', '⌘N'],
    ['file.save', () => saveActive(), 'Save', 'File', '⌘S'],
    ['file.saveAll', () => saveAll(), 'Save All', 'File', '⌥⌘S'],
    ['editor.closeTab', () => closeActiveTab(), 'Close Tab', 'View', '⌘W'],
    ['editor.find', () => getActiveEditor()?.trigger('codemap', 'actions.find', null), 'Find', 'Edit', '⌘F'],
    ['editor.replace', () => getActiveEditor()?.trigger('codemap', 'editor.action.startFindReplaceAction', null), 'Replace', 'Edit', '⌥⌘F'],
    ['editor.gotoLine', () => getActiveEditor()?.trigger('codemap', 'editor.action.gotoLine', null), 'Go to Line…', 'Edit', '⌃G'],
    ['editor.format', () => getActiveEditor()?.trigger('codemap', 'editor.action.formatDocument', null), 'Format Document', 'Edit', '⇧⌥F'],
    ['editor.goToDefinition', () => editorAction('editor.action.revealDefinition'), 'Go to Definition', 'Go', 'F12'],
    ['editor.peekDefinition', () => editorAction('editor.action.peekDefinition'), 'Peek Definition', 'Go', '⌥F12'],
    ['editor.goToDeclaration', () => editorAction('editor.action.revealDeclaration'), 'Go to Declaration', 'Go'],
    ['editor.goToTypeDefinition', () => editorAction('editor.action.goToTypeDefinition'), 'Go to Type Definition', 'Go'],
    ['editor.goToImplementation', () => editorAction('editor.action.goToImplementation'), 'Go to Implementation', 'Go', '⌘F12'],
    ['editor.findReferences', () => editorAction('editor.action.goToReferences'), 'Find All References', 'Go', '⇧F12'],
    ['editor.showHover', () => editorAction('editor.action.showHover'), 'Show Hover', 'Go', '⌘K ⌘I'],
    ['editor.goToSymbol', () => editorAction('editor.action.quickOutline'), 'Go to Symbol in File…', 'Go', '⇧⌘O'],
    ['editor.navigateBack', () => navigateHistory(-1), 'Go Back', 'Go', '⌃-'],
    ['editor.navigateForward', () => navigateHistory(1), 'Go Forward', 'Go', '⌃⇧-'],
    ['editor.lastEdit', () => goToLastEdit(), 'Go to Last Edit Location', 'Go', '⌘K ⌘Q'],
    ['lsp.restart', () => restartAllServers(), 'Restart Language Servers', 'Language'],
    ['lsp.status', () => setState({ settingsOpen: true }), 'Show Language Server Status', 'Language'],
    ['workbench.quickOpen', () => openQuickPick('files'), 'Go to File…', 'View', '⌘P'],
    ['workbench.commandPalette', () => openQuickPick('commands'), 'Show All Commands', 'View', '⇧⌘P'],
    ['workbench.settings', () => setState({ settingsOpen: true }), 'Settings', 'Preferences', '⌘,'],
    ['view.explorer', () => showExplorer(), 'Show Explorer', 'View', '⇧⌘E'],
    ['view.search', () => showSearch(), 'Search in Files', 'View', '⇧⌘F'],
    ['view.projectMap', () => toggleProjectMap(), 'Toggle Project Map', 'View', '⇧⌘M'],
    ['view.fileTree', () => setExplorerMode('classic'), 'Show File Tree', 'View'],
    ['view.codeMap', () => toggleCodeMap(), 'Toggle Code Map', 'View', '⇧⌘Y'],
    ['codemap.reveal', () => revealCodeInMap(), 'Show in Code Map', 'Code Map'],
    ['codemap.reload', () => reloadCodeMap(), 'Reload Node Library', 'Code Map'],
    ['codemap.chooseLibrary', () => chooseLibrary(), 'Choose Node Library…', 'Code Map'],
    ['codemap.problems', () => setState({ panelVisible: true, panelView: 'codemap' }), 'Show Code Map Checks', 'Code Map'],
    ['view.git', view('git'), 'Show Source Control', 'View', '⌃⇧G'],
    ['view.debug', view('debug'), 'Show Run and Debug', 'View', '⇧⌘D'],
    ['view.plugins', view('plugins'), 'Show Plugins', 'View', '⇧⌘X'],
    ['view.toggleSidebar', () => setState({ sidebarVisible: !getState().sidebarVisible }), 'Toggle Sidebar', 'View', '⌘B'],
    ['view.togglePanel', () => setState({ panelVisible: !getState().panelVisible }), 'Toggle Panel', 'View', '⌘J'],
    ['view.output', () => setState({ panelVisible: true, panelView: 'output' }), 'Show Output', 'View'],
    ['view.problems', () => setState({ panelVisible: true, panelView: 'problems' }), 'Show Problems', 'View'],
    ['terminal.toggle', () => toggleTerminal(), 'Toggle Terminal', 'Terminal', '⌃`'],
    ['terminal.new', () => newTerminal(), 'New Terminal', 'Terminal', '⌃⇧`'],
    ['terminal.show', () => showTerminal(), 'Show Terminal', 'Terminal'],
    ['terminal.clear', () => clearTerminal(), 'Clear Terminal', 'Terminal', '⌘K'],
    ['task.build', () => runBuild(), 'Build', 'Run', '⇧⌘B'],
    ['task.stop', () => stopBuild(), 'Stop Build', 'Run'],
    ['debug.start', () => startDebugging(), 'Start Debugging', 'Debug', 'F5'],
    ['debug.stop', () => stopDebugging(), 'Stop Debugging', 'Debug', '⇧F5'],
    ['debug.next', () => control('next'), 'Step Over', 'Debug', 'F10'],
    ['debug.stepIn', () => control('stepIn'), 'Step Into', 'Debug', 'F11'],
    ['debug.stepOut', () => control('stepOut'), 'Step Out', 'Debug', '⇧F11'],
    ['debug.toggleBreakpoint', () => toggleBreakpointAtCursor(), 'Toggle Breakpoint', 'Debug', 'F9'],
    ['plugins.reload', () => loadPlugins(), 'Reload Plugins', 'Plugins'],
    ['plugins.openFolder', () => window.codemap.plugins.openFolder(), 'Open Plugins Folder', 'Plugins'],
    ['help.plugins', () => window.codemap.plugins.openFolder(), 'Plugin Guide', 'Help']
  ]
  for (const [id, run, title, category, keybinding] of commands) registerCommand(id, run, { title, category, keybinding, source: 'core' })
  // Titles are English keys; the palette shows them translated (see QuickPick).
  for (const theme of THEMES) registerCommand(`theme.${theme.id}`, () => setTheme(theme.id), { title: `Color Theme: ${theme.label}`, category: 'Preferences', source: 'core' })
  for (const locale of LOCALES) registerCommand(`language.${locale.id}`, () => setLocale(locale.id), { title: `Language: ${locale.label}`, category: 'Preferences', source: 'core' })
  registerCommand('workspace.openRecent', (path: string) => openFolderPath(path), { title: 'Open Recent', hidden: true, source: 'core' })
}

async function closeActiveTab(): Promise<void> {
  const tab = getActiveTab()
  if (tab) await closeTab(tab.id)
}

function editorAction(id: string): void {
  const editor = getActiveEditor()
  if (!editor) return
  editor.focus()
  editor.trigger('codemap', id, null)
}

async function restartAllServers(): Promise<void> {
  for (const server of getState().lspServers) if (server.state === 'ready' || server.state === 'failed') await restartServer(server.id)
}

// The menu accelerator and the in-page shortcut can both fire for one key press;
// re-opening the same mode must not reset what the user already typed.
function openQuickPick(mode: 'files' | 'commands'): void {
  if (getState().quickPick?.mode === mode) return
  setState({ quickPick: { mode, session: Date.now() } })
}

async function toggleBreakpointAtCursor(): Promise<void> {
  const editor = getActiveEditor()
  const model = editor?.getModel()
  const position = editor?.getPosition()
  if (model && position) await toggleBreakpoint(model.uri.path, position.lineNumber)
}

async function newUntitledFile(): Promise<void> {
  const state = getState()
  if (!state.workspace) {
    await openFolderDialog()
    return
  }
  // The tree's inline name field is not on screen in map mode; ask in a prompt instead.
  if (state.explorerMode !== 'classic') {
    await createInMap('file')
    return
  }
  setState({ sidebarView: 'explorer', sidebarVisible: true, creating: { parent: state.workspace.root, kind: 'file' } })
}
