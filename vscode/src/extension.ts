import * as vscode from 'vscode'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LspNavigationKind } from '../../src/shared/lsp'
import { isInside } from '../../src/shared/paths'
import type { AgentSettings, AgentStartRequest } from '../../src/shared/agent'
import type { CodemapLayoutPatch, CodemapLoad, CodemapNodePatch, ConfirmOptions, MenuItemSpec, WorkspaceSettings } from '../../src/shared/types'
import { CodemapWatcher, grantable, resolveFolder } from '../../src/main/codemap/service'
import { configureAgentHost, knowledgeDir as knowledgeRoot } from '../../src/main/agent/hostAdapter'
import { applyChangeSet, deleteSession, getSession, injectExternalProposal, listSessions, rejectChangeSet, startRun, stopRun } from '../../src/main/agent/runtime'
import { getAgentSettings, resolveProvider, saveAgentSettings, setProviderKey, testProviderConnection } from '../../src/main/agent/settings'
import { listModels } from '../../src/main/agent/providers'
import { CodeMapBridge } from './host/bridge'
import { toVsDiagnostic, type YamlDiagnostic } from './host/diagnostics'
import { createVsCodeLspAdapter, VsCodeLspBridge } from './host/lsp'
import { createAgentLspTools } from './host/agentLsp'
import { LoopbackMcpBridge } from './host/mcpBridge'
import { resolveAgentKnowledgeDir } from './host/knowledge'
import { appendTomlSnippet, jsonSnippet, setupExternalAgents, tomlSnippet, type ExternalMcpConfig } from './host/externalSetup'
import { ProjectMapHost } from './host/projectMap'
import { isHostRequest, type HostEvent } from './host/protocol'
import { dispatch, type RpcHandler } from './host/rpc'
import {
  CursorFollowController,
  SurfaceHub,
  closeSidebarHost,
  buildWebviewCsp,
  resolveSidebarSide,
  rootElement,
  sanitizeSnapshot,
  type HostMode,
  type NavigationSnapshot,
  type PendingHostAction,
  type SidebarContainerKind,
  type SidebarSide,
  type WebviewSurface
} from './host/session'

const LIBRARY_KEY = 'codemap.codemap.library'
const SETTINGS_KEY = 'codemap.codemap.settings'
const GRANTS_KEY = 'codemap.codemap.grants'
const LAST_MODE_KEY = 'codemap.map.lastMode'
const SNAPSHOT_KEY = 'codemap.map.snapshot'
const LEGACY_LIBRARY_KEY = 'lumen.codemap.library'
const LEGACY_SETTINGS_KEY = 'lumen.codemap.settings'
const LEGACY_GRANTS_KEY = 'lumen.codemap.grants'
const LEGACY_LAST_MODE_KEY = 'lumen.map.lastMode'
const LEGACY_SNAPSHOT_KEY = 'lumen.map.snapshot'

let panel: vscode.WebviewPanel | undefined
let sidebarView: vscode.WebviewView | undefined
let sidebarContainer: SidebarContainerKind = 'primary'
let closingSidebar = false
let bridge: CodeMapBridge | undefined
let diagnostics: vscode.DiagnosticCollection | undefined
let libraryWatcher: CodemapWatcher | undefined
let workspaceWatcher: vscode.FileSystemWatcher | undefined
let yamlWatcher: vscode.FileSystemWatcher | undefined
let lspBridge: VsCodeLspBridge | undefined
let projectMapHost: ProjectMapHost | undefined
let mcpBridge: LoopbackMcpBridge | undefined
let mcpProvider: vscode.Disposable | undefined
const hub = new SurfaceHub()
const cursorFollow = new CursorFollowController((target) => hub.broadcastAction({ kind: 'cursor', path: target.path, line: target.line }))
const EXTERNAL_READ_LIMIT = 8 * 1024 * 1024
const SECRET_PREFIX = 'codemap.agent.key.'

export function activate(context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
  const savedGrants = readStringList(context.globalState, GRANTS_KEY, LEGACY_GRANTS_KEY)
  bridge = new CodeMapBridge(root, savedGrants, {
    pickFolder: (defaultPath) => pickFolder(defaultPath),
    confirm: (options) => confirmDialog(options),
    quickPick: (items) => popupMenu(items),
    warning: (message, detail, allow) => accessWarning(message, detail, allow),
    libraryPath: () => configuredLibraryPath()
  })
  bridge.setLocale(vscode.env.language.toLowerCase().startsWith('zh') ? 'zh' : 'en')
  const savedSettings = readState<WorkspaceSettings>(context.workspaceState, SETTINGS_KEY, LEGACY_SETTINGS_KEY)
  if (savedSettings) bridge.setSettings(savedSettings)
  cursorFollow.setEnabled(initialFollowCursor(context))
  configureAgentHost(agentHost(context))
  diagnostics = vscode.languages.createDiagnosticCollection('codemap')
  lspBridge = new VsCodeLspBridge(createVsCodeLspAdapter(vscode))
  projectMapHost = new ProjectMapHost(() => bridge?.getRoot() ?? null, {
    trash: async (abs) => {
      await vscode.workspace.fs.delete(vscode.Uri.file(abs), { recursive: true, useTrash: true })
    }
  })
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  status.text = '$(map) CodeMap'
  status.tooltip = 'Open CodeMap (⇧⌘M / ⇧⌘Y)'
  status.command = 'codemap.map.open'
  status.show()
  libraryWatcher = new CodemapWatcher(() => {
    void refreshLibrary(context, true)
    post({ type: 'event', channel: 'codemap:changed' })
  })
  context.subscriptions.push(
    diagnostics,
    status,
    cursorFollow,
    { dispose: () => libraryWatcher?.stop() },
    vscode.window.registerWebviewViewProvider(
      'codemap.sidebarView',
      {
        resolveWebviewView(webviewView) {
          sidebarView = webviewView
          webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
          }
          attachWebview(context, 'sidebar', webviewView.webview)
          primeInitialSurfaceState(context, 'sidebar')
          if (webviewView.visible) void onSidebarShown(context)
          webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) void onSidebarShown(context)
          })
          webviewView.onDidDispose(() => {
            if (sidebarView === webviewView) sidebarView = undefined
            hub.detach('sidebar')
          })
        }
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerWebviewPanelSerializer('codemap.panel', {
      deserializeWebviewPanel: async (restoredPanel) => {
        attachPanel(context, restoredPanel)
        primeInitialSurfaceState(context, 'panel')
        if (restoredPanel.visible) await handoffToPanel(context)
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('workbench.sideBar.location')) return
      hub.broadcastAction({ kind: 'sidebarSide', side: currentSidebarSide() })
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codemap.mcp.enabled') || event.affectsConfiguration('codemap.libraryPath')) void syncMcpBridge(context)
      if (event.affectsConfiguration('codemap.followCursor') && !readSnapshot(context)) cursorFollow.setEnabled(initialFollowCursor(context))
    }),
    vscode.window.onDidChangeActiveTextEditor(pushEditorCursor),
    vscode.window.onDidChangeTextEditorSelection((event) => pushEditorCursor(event.textEditor))
  )
  watchWorkspace(context)
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => onWorkspaceFoldersChanged(context)))
  pushEditorCursor(vscode.window.activeTextEditor)

  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.map.open', () => openSmart(context)),
    vscode.commands.registerCommand('codemap.sidebar.open', () => collapseToSidebar(context)),
    vscode.commands.registerCommand('codemap.map.expand', () => expandToPanel(context)),
    vscode.commands.registerCommand('codemap.codemap.open', () => openWithAction(context, { kind: 'mode', mode: 'codemap' })),
    vscode.commands.registerCommand('codemap.projectMap.open', () => openWithAction(context, { kind: 'mode', mode: 'map' })),
    vscode.commands.registerCommand('codemap.codemap.reveal', () => revealCurrent(context)),
    vscode.commands.registerCommand('codemap.projectMap.reveal', () => revealProject(context)),
    vscode.commands.registerCommand('codemap.codemap.chooseLibrary', async () => {
      await openPanel(context)
      const load = await bridge!.chooseLibrary()
      if (!load) return
      await rememberLibrary(context, load)
      post({ type: 'event', channel: 'codemap:changed' })
    }),
    vscode.commands.registerCommand('codemap.codemap.validate', () => refreshLibrary(context, false)),
    vscode.commands.registerCommand('codemap.codemap.manageGrants', () => manageGrants(context)),
    vscode.commands.registerCommand('codemap.codemap.initLibrary', () => initLibraryCommand(context)),
    vscode.commands.registerCommand('codemap.agent.openSettings', () => openSettingsCommand(context)),
    vscode.commands.registerCommand('codemap.agent.askSelection', () => askSelectionCommand(context)),
    vscode.commands.registerCommand('codemap.mcp.setup', () => setupMcpCommand(context))
  )
  void refreshLibrary(context, false).finally(() => void syncMcpBridge(context))
}

export function deactivate(): void {
  cursorFollow.dispose()
  libraryWatcher?.stop()
  workspaceWatcher?.dispose()
  yamlWatcher?.dispose()
  panel?.dispose()
  hub.detach('sidebar')
  hub.detach('panel')
  mcpProvider?.dispose()
  mcpProvider = undefined
  void mcpBridge?.dispose()
  mcpBridge = undefined
  configureAgentHost(null)
}

function attachPanel(context: vscode.ExtensionContext, targetPanel: vscode.WebviewPanel): void {
  panel = targetPanel
  let wasVisible = targetPanel.visible
  panel.onDidDispose(() => {
    if (panel === targetPanel) panel = undefined
    hub.detach('panel')
  })
  panel.onDidChangeViewState(() => {
    const becameVisible = !wasVisible && targetPanel.visible
    wasVisible = targetPanel.visible
    if (becameVisible) void handoffToPanel(context, true)
    else if (targetPanel.visible && sidebarView?.visible === true) void closeSidebarIfVisible()
  })
  attachWebview(context, 'panel', targetPanel.webview)
}

function attachWebview(context: vscode.ExtensionContext, surface: WebviewSurface, webview: vscode.Webview): void {
  hub.attach(surface, (event) => {
    void webview.postMessage(event)
  })
  webview.html = htmlFor(webview, context, surface)
  webview.onDidReceiveMessage((message) => void onMessage(context, surface, webview, message))
}

function primeInitialSurfaceState(context: vscode.ExtensionContext, surface: WebviewSurface): void {
  const snapshot = readSnapshot(context)
  if (snapshot && isHostMode(snapshot.mode)) {
    hub.send(surface, { kind: 'snapshot', snapshot })
    return
  }
  const savedMode = readState<HostMode>(context.workspaceState, LAST_MODE_KEY, LEGACY_LAST_MODE_KEY)
  const preferred: HostMode = savedMode === 'map' || savedMode === 'codemap' ? savedMode : bridge?.getLibrary() ? 'codemap' : 'map'
  hub.send(surface, { kind: 'mode', mode: preferred })
}

async function openPanel(context: vscode.ExtensionContext): Promise<void> {
  if (panel) {
    const needsSync = !panel.visible || sidebarView?.visible === true
    panel.reveal(vscode.ViewColumn.Active, false)
    await handoffToPanel(context, needsSync)
    return
  }
  const created = vscode.window.createWebviewPanel('codemap.panel', 'CodeMap', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
  })
  attachPanel(context, created)
  await handoffToPanel(context, true)
}

function currentSidebarSide(): SidebarSide {
  const location = vscode.workspace.getConfiguration('workbench').get<string>('sideBar.location')
  return resolveSidebarSide(location, sidebarContainer)
}

async function handoffToPanel(context: vscode.ExtensionContext, syncSnapshot = true): Promise<void> {
  if (syncSnapshot) {
    const snapshot = readSnapshot(context)
    if (snapshot && isHostMode(snapshot.mode)) hub.send('panel', { kind: 'snapshot', snapshot })
  }
  if (sidebarView?.visible === true) await closeSidebarIfVisible()
}

async function closeSidebarIfVisible(): Promise<void> {
  if (sidebarView?.visible !== true) return
  closingSidebar = true
  try {
    const detected = await closeSidebarHost({
      isVisible: () => sidebarView?.visible === true,
      container: sidebarContainer,
      closePrimary: () => vscode.commands.executeCommand('workbench.action.closeSidebar'),
      closeAuxiliary: () => vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
    })
    if (detected !== sidebarContainer) {
      sidebarContainer = detected
      hub.broadcastAction({ kind: 'sidebarSide', side: currentSidebarSide() })
    }
  } finally {
    closingSidebar = false
  }
}

async function onSidebarShown(context: vscode.ExtensionContext): Promise<void> {
  if (closingSidebar) return
  if (!sidebarView?.visible) return
  if (panel) {
    const stale = panel
    panel = undefined
    stale.dispose()
  }
  const snapshot = readSnapshot(context)
  if (snapshot && isHostMode(snapshot.mode)) hub.send('sidebar', { kind: 'snapshot', snapshot })
}

async function collapseToSidebar(context: vscode.ExtensionContext, incomingSnapshot?: unknown): Promise<void> {
  if (incomingSnapshot && typeof incomingSnapshot === 'object') {
    const snapshot = sanitizeSnapshot(incomingSnapshot, 'sidebar', readSnapshot(context))
    if (snapshot) await persistSnapshot(context, snapshot)
  }
  if (sidebarView) sidebarView.show(false)
  else await vscode.commands.executeCommand('codemap.sidebarView.focus')
  if (panel) {
    const stale = panel
    panel = undefined
    stale.dispose()
  }
  const snapshot = readSnapshot(context)
  if (snapshot && isHostMode(snapshot.mode)) hub.send('sidebar', { kind: 'snapshot', snapshot })
  else {
    const savedMode = readState<HostMode>(context.workspaceState, LAST_MODE_KEY, LEGACY_LAST_MODE_KEY)
    const preferred: HostMode = savedMode === 'map' || savedMode === 'codemap' ? savedMode : bridge?.getLibrary() ? 'codemap' : 'map'
    hub.send('sidebar', { kind: 'mode', mode: preferred })
  }
}

async function onMessage(context: vscode.ExtensionContext, surface: WebviewSurface, webview: vscode.Webview, message: unknown): Promise<void> {
  if (!isHostRequest(message) || !bridge) return
  const response = await dispatch(message, handlers(context, surface))
  await webview.postMessage(response)
}

function handlers(context: vscode.ExtensionContext, surface: WebviewSurface): Record<string, RpcHandler> {
  const current = bridge!
  return {
    'app:info': () => ({
      version: '0.1.0',
      platform: process.platform,
      arch: process.arch,
      userPluginsDir: '',
      e2e: false
    }),
    'app:state': () => ({
      recentFolders: [],
      lastFolder: current.getRoot(),
      theme: vscode.workspace.getConfiguration('workbench').get('colorTheme', ''),
      locale: vscode.env.language.startsWith('zh') ? 'zh' : 'en'
    }),
    'app:setTheme': () => undefined,
    'app:setLocale': () => undefined,
    'app:setDirtyCount': () => undefined,
    'app:confirm': ([options]) => current.confirm(options as ConfirmOptions),
    'app:popupMenu': ([items]) => current.popupMenu(items as MenuItemSpec[]),
    'workspace:getSettings': () => current.snapshot().settings,
    'workspace:saveSettings': async ([settings]) => {
      current.setSettings(settings as WorkspaceSettings)
      await context.workspaceState.update(SETTINGS_KEY, settings)
      return settings
    },
    'workspace:openDialog': () => current.chooseLibrary(),
    'codemap:load': () => loadSaved(context),
    'codemap:chooseLibrary': async () => {
      const load = await current.chooseLibrary()
      if (load) await rememberLibrary(context, load)
      return load
    },
    'codemap:useLibrary': async ([folder]) => {
      const load = await current.useLibrary(String(folder))
      await rememberLibrary(context, load)
      return load
    },
    'codemap:createLibrary': async ([folder]) => {
      const load = await current.createLibrary(folder == null ? undefined : String(folder))
      if (load) await rememberLibrary(context, load)
      return load
    },
    'codemap:initDefaultLibrary': async () => initAndRememberDefaultLibrary(context),
    'codemap:pickRepository': () => current.pickRepository(),
    'codemap:writeLayout': async ([file, patch]) => {
      await current.writeLayout(String(file), patch as CodemapLayoutPatch, (target, content) => libraryWatcher?.expectOwnWrite(target, content))
      await refreshLibrary(context, false)
    },
    'codemap:writeNode': async ([file, patch]) => {
      await current.writeNode(String(file), patch as CodemapNodePatch)
      await refreshLibrary(context, false)
    },
    'codemap:read': ([file]) => current.read(String(file)),
    'codemap:requestAccess': async ([folder, reason]) => {
      const granted = await current.requestAccess(String(folder), String(reason))
      await context.globalState.update(GRANTS_KEY, current.access.list())
      return granted
    },
    'codemap:grants': () => current.access.list(),
    'codemap:revoke': async ([folder]) => {
      const grants = current.revoke(String(folder))
      await context.globalState.update(GRANTS_KEY, grants)
      return grants
    },
    'fs:read': ([file]) => current.readWorkspace(String(file)),
    'fs:readExternal': async ([file]) => {
      const target = String(file)
      if (lspBridge?.isApprovedFile(target)) return readApprovedExternalText(target)
      return current.readExternal(target)
    },
    'fs:write': async ([file, content]) => {
      const root = current.getRoot()
      if (!root) throw new Error('Refusing to write outside the workspace')
      const absolute = await resolveSafeWriteTarget(root, String(file))
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, String(content), 'utf8')
      post({ type: 'event', channel: 'fs:changed', payload: [absolute] })
    },
    'fs:reveal': async ([file]) => {
      const uri = vscode.Uri.file(String(file))
      await vscode.commands.executeCommand('revealFileInOS', uri).then(undefined, () => vscode.window.showTextDocument(uri, { preview: true }))
    },
    'fs:list': ([dir]) => projectMapHost!.listDirectory(String(dir)),
    'fs:listFiles': ([limit]) => projectMapHost!.listFiles(limit == null ? undefined : Number(limit)),
    'fs:mapIndex': () => projectMapHost!.mapIndex(),
    'fs:create': async ([parent, name, kind]) => {
      const created = await projectMapHost!.createEntry(String(parent), String(name), kind as 'file' | 'directory')
      post({ type: 'event', channel: 'fs:changed', payload: [created] })
      return created
    },
    'fs:rename': async ([target, newName]) => {
      const renamed = await projectMapHost!.renameEntry(String(target), String(newName))
      post({ type: 'event', channel: 'fs:changed', payload: [String(target), renamed] })
      return renamed
    },
    'fs:trash': async ([target]) => {
      await projectMapHost!.trashEntry(String(target))
      post({ type: 'event', channel: 'fs:changed', payload: [String(target)] })
    },
    'fs:duplicate': async ([target]) => {
      const copy = await projectMapHost!.duplicateEntry(String(target))
      post({ type: 'event', channel: 'fs:changed', payload: [copy] })
      return copy
    },
    'fs:transfer': async ([sources, targetDir, mode]) => {
      const res = await projectMapHost!.transferEntries(sources as string[], String(targetDir), mode as 'copy' | 'move')
      if (res.created.length) post({ type: 'event', channel: 'fs:changed', payload: res.created })
      return res
    },
    'git:status': () => projectMapHost!.gitStatus(),
    'workspace:pickFile': async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: current.getRoot() ? vscode.Uri.file(current.getRoot()!) : undefined
      })
      return picked?.[0]?.fsPath ?? null
    },
    'host:revealInExplorer': async ([file]) => {
      const uri = vscode.Uri.file(String(file))
      await vscode.commands.executeCommand('revealInExplorer', uri).then(undefined, () => vscode.commands.executeCommand('revealFileInOS', uri))
    },
    'host:rememberMode': async ([mode]) => {
      if (mode === 'map' || mode === 'codemap') await context.workspaceState.update(LAST_MODE_KEY, mode)
    },
    'host:findInFiles': async ([query, filesToInclude]) => {
      await vscode.commands.executeCommand('workbench.action.findInFiles', {
        query: String(query ?? ''),
        filesToInclude: String(filesToInclude ?? ''),
        triggerSearch: Boolean(query)
      })
    },
    'lsp:open': ([file, languageId, text]) => lspBridge!.open(String(file), languageId as string | undefined, text as string | undefined),
    'lsp:change': ([file, text]) => lspBridge!.change(String(file), String(text)),
    'lsp:save': ([file]) => lspBridge!.save(String(file)),
    'lsp:close': ([file]) => lspBridge!.close(String(file)),
    'lsp:navigate': ([kind, file, line, col]) => lspBridge!.navigate(kind as LspNavigationKind, String(file), Number(line), Number(col)),
    'lsp:hover': ([file, line, col]) => lspBridge!.hover(String(file), Number(line), Number(col)),
    'lsp:symbols': ([file]) => lspBridge!.symbols(String(file)),
    'lsp:status': () => lspBridge!.status(),
    'lsp:restart': async () => undefined,
    'fs:pathForFile': () => '',
    openExternalUrl: async ([url]) => {
      const target = String(url)
      if (!/^https?:\/\//i.test(target)) throw new Error('Only http(s) links can be opened')
      await vscode.env.openExternal(vscode.Uri.parse(target))
    },
    'host:openInVSCode': async ([file, line, beside]) => {
      const filePath = String(file)
      const uri = vscode.Uri.file(filePath)
      const viewColumn = resolveOpenColumn(surface, Boolean(beside))
      const doc = await vscode.workspace.openTextDocument(uri)
      const dirty = lspBridge?.getDirtyBuffer(filePath)
      if (typeof dirty === 'string' && dirty !== doc.getText()) {
        const edit = new vscode.WorkspaceEdit()
        const lastLine = Math.max(0, doc.lineCount - 1)
        const end = doc.lineAt(lastLine).range.end
        edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), dirty)
        await vscode.workspace.applyEdit(edit)
      }
      const editor = await vscode.window.showTextDocument(doc, { viewColumn, preview: false, preserveFocus: false })
      const lineNumber = Math.max(1, Number(line) || 1)
      const position = new vscode.Position(lineNumber - 1, 0)
      editor.selection = new vscode.Selection(position, position)
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    },
    'host:expandToPanel': async ([incomingSnapshot]) => {
      if (incomingSnapshot && typeof incomingSnapshot === 'object') {
        const snapshot = sanitizeSnapshot(incomingSnapshot, surface, readSnapshot(context))
        if (snapshot) await persistSnapshot(context, snapshot)
      }
      await expandToPanel(context)
    },
    'host:collapseToSidebar': async ([incomingSnapshot]) => {
      await collapseToSidebar(context, incomingSnapshot)
    },
    'host:saveSnapshot': async ([raw]) => {
      const snapshot = sanitizeSnapshot(raw, surface, readSnapshot(context))
      if (!snapshot) return
      await persistSnapshot(context, snapshot)
    },
    'webview:ready': () => {
      const actions = hub.markReady(surface)
      hub.send(surface, { kind: 'sidebarSide', side: currentSidebarSide() })
      if (actions.length === 0) {
        const snapshot = readSnapshot(context)
        if (snapshot && isHostMode(snapshot.mode)) hub.send(surface, { kind: 'snapshot', snapshot })
        else {
          const savedMode = readState<HostMode>(context.workspaceState, LAST_MODE_KEY, LEGACY_LAST_MODE_KEY)
          if (savedMode === 'map' || savedMode === 'codemap') hub.send(surface, { kind: 'mode', mode: savedMode })
        }
        const editor = vscode.window.activeTextEditor
        if (editor?.document.uri.scheme === 'file') {
          hub.send(surface, { kind: 'cursor', path: editor.document.uri.fsPath, line: editor.selection.active.line + 1 })
        }
      }
      return consumeReadyPayload(actions)
    },
    'agent:settings': () => getAgentSettings(),
    'agent:saveSettings': ([settings]) => saveAgentSettings(settings as AgentSettings),
    'agent:setKey': ([providerId, key]) => setProviderKey(String(providerId), key ? String(key) : null),
    'agent:models': async ([providerId]) => {
      const { provider, key } = await resolveProvider(providerId ? String(providerId) : null)
      return listModels(provider, key)
    },
    'agent:testConnection': ([providerId, model]) => testProviderConnection(providerId ? String(providerId) : null, model ? String(model) : undefined),
    'agent:start': async ([req]) => {
      const request = req as AgentStartRequest
      const lib = await ensureAgentLibrary(context, request)
      return startRun(lib, current.access, request, (event) => post({ type: 'event', channel: 'agent:event', payload: event }), { lsp: agentLsp() })
    },
    'agent:stop': ([sessionId]) => stopRun(String(sessionId)),
    'agent:sessions': () => (current.getLibrary() ? listSessions(current.getLibrary()!) : []),
    'agent:session': ([id]) => getSession(requireLibrary(), String(id)),
    'agent:deleteSession': ([id]) => deleteSession(requireLibrary(), String(id)),
    'agent:applyChangeSet': async ([sessionId, changeSetId]) => {
      const lib = requireLibrary()
      const written = await applyChangeSet(lib, current.getRoot(), String(sessionId), String(changeSetId))
      await refreshLibrary(context, true)
      post({ type: 'event', channel: 'codemap:changed' })
      return written
    },
    'agent:rejectChangeSet': ([sessionId, changeSetId]) => rejectChangeSet(requireLibrary(), String(sessionId), String(changeSetId)),
    'agent:knowledgeDir': () => knowledgeRoot(),
    'agent:pickRepos': () => pickGrantedFolders(context),
    'agent:pickDocs': () => pickGrantedDocs(context),
    'host:setupExternalMcp': () => runExternalMcpSetupInteractive(context),
    'host:openVsCodeSettings': () => vscode.commands.executeCommand('workbench.action.openSettings', 'codemap')
  }
}

async function loadSaved(context: vscode.ExtensionContext): Promise<CodemapLoad> {
  const saved = readState<string>(context.workspaceState, LIBRARY_KEY, LEGACY_LIBRARY_KEY) ?? null
  const load = await bridge!.load(saved)
  if (load.library) await rememberLibrary(context, load)
  else publishDiagnostics([])
  return load
}

async function rememberLibrary(context: vscode.ExtensionContext, load: CodemapLoad): Promise<void> {
  if (!load.library) return
  await context.workspaceState.update(LIBRARY_KEY, load.library)
  bridge!.setLibrary(load.library)
  libraryWatcher?.start(load.library)
  watchLibrary(context, load.library)
  publishDiagnostics(bridge!.diagnostics(load))
  mcpBridge?.updateContext({ workspaceRoot: bridge!.getRoot(), library: load.library })
}

async function refreshLibrary(context: vscode.ExtensionContext, quiet: boolean): Promise<void> {
  if (!bridge?.getRoot()) return
  try {
    const load = await loadSaved(context)
    if (!quiet && load.status === 'none') void vscode.window.showInformationMessage('CodeMap: no node library found in this workspace.')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    void vscode.window.showErrorMessage(`CodeMap: ${message}`)
  }
}

function publishDiagnostics(items: YamlDiagnostic[]): void {
  if (!diagnostics) return
  const grouped = new Map<string, YamlDiagnostic[]>()
  for (const item of items) {
    const list = grouped.get(item.file) ?? []
    list.push(item)
    grouped.set(item.file, list)
  }
  diagnostics.clear()
  for (const [file, list] of grouped) {
    diagnostics.set(
      vscode.Uri.file(file),
      list.map((item) => toVsDiagnostic(item, vscode))
    )
  }
}

function watchWorkspace(context: vscode.ExtensionContext): void {
  workspaceWatcher?.dispose()
  const folder = vscode.workspace.workspaceFolders?.[0]
  bridge?.setRoot(folder?.uri.fsPath ?? null)
  if (!folder) return
  workspaceWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'))
  const push = (uri: vscode.Uri) => post({ type: 'event', channel: 'fs:changed', payload: [uri.fsPath] })
  context.subscriptions.push(workspaceWatcher, workspaceWatcher.onDidChange(push), workspaceWatcher.onDidCreate(push), workspaceWatcher.onDidDelete(push))
}

function onWorkspaceFoldersChanged(context: vscode.ExtensionContext): void {
  watchWorkspace(context)
  const { root, name } = workspaceIdentity()
  bridge?.setRoot(root || null)
  void refreshLibrary(context, true)
  void syncMcpBridge(context)
  post({ type: 'event', channel: 'host:workspace', payload: { root, name } })
}

function watchLibrary(context: vscode.ExtensionContext, library: string): void {
  yamlWatcher?.dispose()
  yamlWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(library), '**/*.{yaml,yml,md}'))
  const push = () => {
    void refreshLibrary(context, true)
    post({ type: 'event', channel: 'codemap:changed' })
  }
  context.subscriptions.push(yamlWatcher, yamlWatcher.onDidChange(push), yamlWatcher.onDidCreate(push), yamlWatcher.onDidDelete(push))
}

function pushEditorCursor(editor: vscode.TextEditor | undefined): void {
  if (editor && editor.document.uri.scheme === 'file') cursorFollow.update(editor.document.uri.fsPath, editor.selection.active.line + 1)
}

async function revealCurrent(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== 'file') return
  const action: PendingHostAction = { kind: 'revealCode', path: editor.document.uri.fsPath, line: editor.selection.active.line + 1 }
  await routeReveal(context, action, 'codemap')
}

async function revealProject(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== 'file') return
  const action: PendingHostAction = { kind: 'revealProject', path: editor.document.uri.fsPath }
  await routeReveal(context, action, 'map')
}

async function routeReveal(context: vscode.ExtensionContext, action: PendingHostAction, mode: HostMode): Promise<void> {
  await context.workspaceState.update(LAST_MODE_KEY, mode)
  if (sidebarView?.visible) {
    hub.send('sidebar', action)
    return
  }
  await openPanel(context)
  hub.send('panel', action)
}

async function openWithAction(context: vscode.ExtensionContext, action: PendingHostAction): Promise<void> {
  if (action.kind === 'mode') await context.workspaceState.update(LAST_MODE_KEY, action.mode)
  else if (action.kind === 'revealProject') await context.workspaceState.update(LAST_MODE_KEY, 'map')
  else if (action.kind === 'revealCode') await context.workspaceState.update(LAST_MODE_KEY, 'codemap')
  await openPanel(context)
  hub.send('panel', action)
}

async function expandToPanel(context: vscode.ExtensionContext): Promise<void> {
  await openPanel(context)
}

async function openSmart(context: vscode.ExtensionContext): Promise<void> {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active, false)
    await handoffToPanel(context)
    return
  }
  if (sidebarView?.visible) return
  const snapshot = readSnapshot(context)
  if (snapshot && isHostMode(snapshot.mode)) {
    await openPreferredSurface(context)
    return
  }
  const savedMode = readState<HostMode>(context.workspaceState, LAST_MODE_KEY, LEGACY_LAST_MODE_KEY)
  const preferred: HostMode = savedMode === 'map' || savedMode === 'codemap' ? savedMode : bridge?.getLibrary() ? 'codemap' : 'map'
  if (defaultSurface() === 'sidebar') {
    await context.workspaceState.update(LAST_MODE_KEY, preferred)
    await collapseToSidebar(context)
    hub.send('sidebar', { kind: 'mode', mode: preferred })
    return
  }
  await openWithAction(context, { kind: 'mode', mode: preferred })
}

async function persistSnapshot(context: vscode.ExtensionContext, snapshot: NavigationSnapshot): Promise<void> {
  await context.workspaceState.update(SNAPSHOT_KEY, snapshot)
  await context.workspaceState.update(LAST_MODE_KEY, snapshot.mode)
}

function readSnapshot(context: vscode.ExtensionContext): NavigationSnapshot | undefined {
  const raw = readState<unknown>(context.workspaceState, SNAPSHOT_KEY, LEGACY_SNAPSHOT_KEY)
  return sanitizeSnapshot(raw) ?? undefined
}

function readState<T>(state: vscode.Memento, key: string, legacyKey: string): T | undefined {
  const current = state.get<T>(key)
  if (current !== undefined) return current
  return state.get<T>(legacyKey)
}

function readStringList(state: vscode.Memento, key: string, legacyKey: string): string[] {
  const value = readState<unknown>(state, key, legacyKey)
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : []
}

function resolveOpenColumn(surface: WebviewSurface, beside: boolean): vscode.ViewColumn {
  if (beside) return vscode.ViewColumn.Beside
  if (surface !== 'sidebar') return vscode.ViewColumn.Active
  if (vscode.window.activeTextEditor) return vscode.window.activeTextEditor.viewColumn ?? vscode.ViewColumn.One
  if (currentSidebarSide() === 'right') {
    const columns = vscode.window.visibleTextEditors.map((editor) => editor.viewColumn ?? 1)
    return columns.length ? Math.max(...columns) : vscode.ViewColumn.One
  }
  return vscode.ViewColumn.One
}

function isHostMode(value: unknown): value is HostMode {
  return value === 'map' || value === 'codemap'
}

async function resolveSafeWriteTarget(root: string, file: string): Promise<string> {
  const resolvedRoot = path.resolve(root)
  const absolute = path.resolve(resolvedRoot, file)
  if (absolute === resolvedRoot || !isInside(resolvedRoot, absolute)) throw new Error('Refusing to write outside the workspace')
  const realRoot = await realpath(resolvedRoot).catch(() => resolvedRoot)
  const realParent = await realpath(path.dirname(absolute)).catch(() => path.dirname(absolute))
  if (!isInside(realRoot, realParent)) throw new Error('Refusing to write outside the workspace')
  const realTarget = await realpath(absolute).catch(() => path.join(realParent, path.basename(absolute)))
  if (realTarget === realRoot || !isInside(realRoot, realTarget)) throw new Error('Refusing to write outside the workspace')
  return absolute
}

function consumeReadyPayload(actions: { channel: string; payload: unknown }[]): { path: string; line: number } | null {
  const reveal = actions.find((action) => action.channel === 'host:revealCode')
  return (reveal?.payload as { path: string; line: number } | undefined) ?? null
}

async function readApprovedExternalText(file: string): Promise<string> {
  const target = path.resolve(file)
  const info = await stat(target)
  if (!info.isFile()) throw new Error('Not a file')
  if (info.size > EXTERNAL_READ_LIMIT) throw new Error('File is larger than 8 MB')
  const handle = await readFile(target)
  const probe = handle.subarray(0, 8000)
  if (probe.includes(0)) throw new Error('File looks binary')
  return handle.toString('utf8')
}

async function manageGrants(context: vscode.ExtensionContext): Promise<void> {
  if (!bridge) return
  const zh = vscode.env.language.toLowerCase().startsWith('zh')
  const grants = bridge.access.list()
  if (!grants.length) {
    void vscode.window.showInformationMessage(zh ? 'CodeMap 当前没有外部只读授权。' : 'CodeMap has no external read grants.')
    return
  }
  const picked = await vscode.window.showQuickPick(
    [
      ...grants.map((grant) => ({ label: grant, description: zh ? '撤销只读访问权限' : 'Revoke read-only access' })),
      { label: zh ? '保留全部授权' : 'Keep all grants', description: '' }
    ],
    { placeHolder: zh ? '允许架构图读取的外部文件夹' : 'External folders the architecture map may read' }
  )
  if (!picked || picked.label === 'Keep all grants' || picked.label === '保留全部授权') return
  const next = bridge.revoke(picked.label)
  await context.globalState.update(GRANTS_KEY, next)
}

function post(event: HostEvent): void {
  hub.broadcast(event.channel, event.payload)
}

async function pickFolder(defaultPath?: string): Promise<string | null> {
  const result = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: defaultPath ? vscode.Uri.file(defaultPath) : undefined,
    openLabel: 'Use this folder'
  })
  return result?.[0]?.fsPath ?? null
}

async function confirmDialog(options: ConfirmOptions): Promise<number> {
  const buttons = options.buttons.length ? options.buttons : ['OK']
  const choice = await vscode.window.showWarningMessage(options.detail ? `${options.message}\n\n${options.detail}` : options.message, { modal: true }, ...buttons)
  if (!choice) return options.cancelId ?? buttons.length - 1
  const index = buttons.indexOf(choice)
  return index < 0 ? (options.cancelId ?? buttons.length - 1) : index
}

async function popupMenu(items: MenuItemSpec[]): Promise<string | null> {
  const entries = items.filter((item) => !item.separator && item.id)
  const picked = await vscode.window.showQuickPick(
    entries.map((item) => ({ label: item.label ?? item.id!, description: item.id, id: item.id! })),
    { placeHolder: 'CodeMap' }
  )
  return picked?.id ?? null
}

async function accessWarning(message: string, detail: string, allow: boolean): Promise<boolean> {
  if (!allow) {
    await vscode.window.showWarningMessage(`${message}\n\n${detail}`, { modal: true }, 'OK')
    return false
  }
  const choice = await vscode.window.showWarningMessage(`${message}\n\n${detail}`, { modal: true }, 'Allow Read-Only')
  return choice === 'Allow Read-Only'
}

export function htmlFor(webview: vscode.Webview, context: vscode.ExtensionContext, surface: WebviewSurface = 'panel'): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'assets', 'webview.js'))
  const style = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'assets', 'webview.css'))
  const nonce = randomNonce()
  const { root, name } = workspaceIdentity()
  const csp = buildWebviewCsp(webview.cspSource, nonce)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${style}" />
<title>CodeMap</title>
</head>
<body>
${rootElement(root, name, surface, currentSidebarSide())}
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`
}

function workspaceIdentity(): { root: string; name: string } {
  const folder = vscode.workspace.workspaceFolders?.[0]
  const root = folder?.uri.fsPath ?? ''
  const name = folder?.name ?? (root ? path.basename(root) : 'workspace')
  return { root, name }
}

function randomNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function agentHost(context: vscode.ExtensionContext) {
  return {
    userDataDir: () => {
      const dir = context.globalStorageUri.fsPath
      void mkdir(dir, { recursive: true })
      return dir
    },
    knowledgeDir: () => resolveAgentKnowledgeDir(context.extensionUri.fsPath),
    getSecret: async (id: string) => (await context.secrets.get(`${SECRET_PREFIX}${id}`)) ?? null,
    setSecret: async (id: string, secret: string | null) => {
      const key = `${SECRET_PREFIX}${id}`
      if (secret) await context.secrets.store(key, secret)
      else await context.secrets.delete(key)
    },
    hasSecret: async (id: string) => Boolean(await context.secrets.get(`${SECRET_PREFIX}${id}`)),
    loadSettingsOverride: () => ({ maxParallel: vscode.workspace.getConfiguration('codemap').get<number>('agent.maxParallel', 3) }),
    saveSettingsOverride: async (settings: AgentSettings) => {
      await vscode.workspace.getConfiguration('codemap').update('agent.maxParallel', settings.maxParallel, vscode.ConfigurationTarget.Global)
    }
  }
}

function configuredLibraryPath(): string {
  return vscode.workspace.getConfiguration('codemap').get<string>('libraryPath', '') ?? ''
}

function defaultSurface(): 'panel' | 'sidebar' {
  return vscode.workspace.getConfiguration('codemap').get<string>('defaultSurface', 'panel') === 'sidebar' ? 'sidebar' : 'panel'
}

function initialFollowCursor(context: vscode.ExtensionContext): boolean {
  const snapshot = readSnapshot(context)
  if (typeof snapshot?.followCursor === 'boolean') return snapshot.followCursor
  return vscode.workspace.getConfiguration('codemap').get<boolean>('followCursor', false)
}

async function openPreferredSurface(context: vscode.ExtensionContext): Promise<void> {
  if (defaultSurface() === 'sidebar') await collapseToSidebar(context)
  else await openPanel(context)
}

function requireLibrary(): string {
  const library = bridge?.getLibrary()
  if (!library) throw new Error('Open a code map first')
  return library
}

async function initAndRememberDefaultLibrary(context: vscode.ExtensionContext): Promise<CodemapLoad> {
  const load = await bridge!.initDefaultLibrary()
  await rememberLibrary(context, load)
  post({ type: 'event', channel: 'codemap:changed' })
  return load
}

async function ensureAgentLibrary(context: vscode.ExtensionContext, request: AgentStartRequest): Promise<string> {
  const open = bridge?.getLibrary()
  if (open) return open
  if (request.mode === 'create' && bridge?.getRoot()) return (await initAndRememberDefaultLibrary(context)).library!
  throw new Error('Open a code map first')
}

function agentLsp() {
  return lspBridge ? createAgentLspTools(lspBridge) : undefined
}

async function persistGrants(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(GRANTS_KEY, bridge!.access.list())
}

async function grantResolved(context: vscode.ExtensionContext, folders: string[]): Promise<void> {
  let changed = false
  for (const folder of folders) {
    if (!grantable(folder) || bridge!.access.allowed(folder)) continue
    bridge!.grant(folder)
    changed = true
  }
  if (changed) await persistGrants(context)
}

async function pickGrantedFolders(context: vscode.ExtensionContext): Promise<string[]> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: true,
    defaultUri: bridge?.getRoot() ? vscode.Uri.file(bridge.getRoot()!) : undefined
  })
  if (!picked?.length) return []
  const folders = await Promise.all(picked.map((uri) => resolveFolder(uri.fsPath)))
  await grantResolved(context, folders)
  return folders
}

async function pickGrantedDocs(context: vscode.ExtensionContext): Promise<string[]> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: false,
    canSelectFiles: true,
    canSelectMany: true,
    defaultUri: bridge?.getRoot() ? vscode.Uri.file(bridge.getRoot()!) : undefined
  })
  if (!picked?.length) return []
  const files = await Promise.all(picked.map((uri) => realpath(uri.fsPath)))
  await grantResolved(context, [...new Set(files.map((file) => path.dirname(file)))])
  return files
}

async function initLibraryCommand(context: vscode.ExtensionContext): Promise<void> {
  const load = await initAndRememberDefaultLibrary(context)
  await openPanel(context)
  hub.send('panel', { kind: 'mode', mode: 'codemap' })
  const zh = vscode.env.language.toLowerCase().startsWith('zh')
  void vscode.window.showInformationMessage(zh ? `CodeMap 已初始化节点库：${load.library}` : `CodeMap initialized ${load.library}`)
}

async function openSettingsCommand(context: vscode.ExtensionContext): Promise<void> {
  const target = await activeOrPanel(context)
  hub.send(target, { kind: 'openAiSettings' })
}

async function askSelectionCommand(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== 'file' || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage('CodeMap: select code in an editor first.')
    return
  }
  const target: WebviewSurface = sidebarView?.visible ? 'sidebar' : 'panel'
  if (target === 'panel') await openPanel(context)
  const start = editor.selection.start.line + 1
  const end = editor.selection.end.line + 1
  hub.send(target, {
    kind: 'askSelection',
    path: editor.document.uri.fsPath,
    startLine: Math.min(start, end),
    endLine: Math.max(start, end),
    mode: 'ask'
  })
}

async function activeOrPanel(context: vscode.ExtensionContext): Promise<WebviewSurface> {
  if (sidebarView?.visible) return 'sidebar'
  if (panel) return 'panel'
  await openPanel(context)
  return 'panel'
}

async function setupMcpCommand(context: vscode.ExtensionContext): Promise<void> {
  const zh = vscode.env.language.toLowerCase().startsWith('zh')
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Cursor (.cursor/mcp.json)', id: 'cursor' },
      { label: 'Claude Code (.mcp.json)', id: 'claude' },
      { label: 'Codex CLI (~/.codex/config.toml snippet)', id: 'codex' },
      { label: 'All Workspace Configs (.cursor + .mcp.json)', id: 'all' },
      { label: 'Copy MCP JSON to Clipboard', id: 'copy' }
    ],
    { placeHolder: zh ? 'CodeMap 要写入哪个外部 AI 配置？' : 'Where should CodeMap write the external AI config?' }
  )
  if (!picked) return
  const config = externalMcpConfig(context)
  if (picked.id === 'copy') {
    await vscode.env.clipboard.writeText(jsonSnippet(config))
    void vscode.window.showInformationMessage(zh ? 'CodeMap MCP JSON 已复制到剪贴板。' : 'CodeMap MCP JSON copied to the clipboard.')
    return
  }
  if (picked.id === 'codex') {
    const file = path.join(process.env.HOME || '', '.codex', 'config.toml')
    const changed = appendTomlSnippet(file, tomlSnippet(config))
    void vscode.window.showInformationMessage(
      changed
        ? zh
          ? `CodeMap 已写入 ${file}`
          : `CodeMap wrote ${file}`
        : zh
          ? `CodeMap 已经在 ${file}`
          : `CodeMap is already in ${file}`
    )
    return
  }
  const result = setupExternalAgents(config)
  const written =
    picked.id === 'cursor' ? [result.cursorChanged ? result.cursorFile : ''] : picked.id === 'claude' ? [result.claudeChanged ? result.claudeFile : ''] : [result.cursorFile, result.claudeFile].filter(Boolean)
  const files = written.filter(Boolean)
  void vscode.window.showInformationMessage(
    files.length
      ? zh
        ? `CodeMap 已更新 ${files.join(', ')}`
        : `CodeMap updated ${files.join(', ')}`
      : zh
        ? 'CodeMap MCP 配置已经是最新。'
        : 'CodeMap MCP config is already current.'
  )
}

export async function runExternalMcpSetupInteractive(context: vscode.ExtensionContext): Promise<void> {
  await setupMcpCommand(context)
}

function externalMcpConfig(context: vscode.ExtensionContext): ExternalMcpConfig {
  const workspaceRoot = bridge?.getRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) throw new Error('Open a folder first')
  return {
    workspaceRoot,
    mcpScriptPath: path.join(context.extensionUri.fsPath, 'dist', 'codemap-mcp.cjs'),
    registryDir: path.join(context.globalStorageUri.fsPath, 'mcp-registry'),
    knowledgeDir: resolveAgentKnowledgeDir(context.extensionUri.fsPath),
    command: 'node'
  }
}

async function syncMcpBridge(context: vscode.ExtensionContext): Promise<void> {
  const enabled = vscode.workspace.getConfiguration('codemap').get<boolean>('mcp.enabled', true)
  if (!enabled) {
    mcpProvider?.dispose()
    mcpProvider = undefined
    await mcpBridge?.dispose()
    mcpBridge = undefined
    return
  }
  const workspaceRoot = bridge?.getRoot() ?? null
  const library = bridge?.getLibrary() ?? null
  const registryDir = path.join(context.globalStorageUri.fsPath, 'mcp-registry')
  if (!mcpBridge) {
    mcpBridge = await LoopbackMcpBridge.start({
      registryDir,
      workspaceRoot,
      library,
      knowledgeDir: resolveAgentKnowledgeDir(context.extensionUri.fsPath),
      access: bridge?.access,
      agentLsp: agentLsp(),
      callbacks: {
        onShowOnMap: (request) => showExternalOnMap(context, request),
        onExternalProposal: (proposal) => acceptExternalProposal(context, proposal)
      }
    })
    registerNativeMcp(context, registryDir)
    return
  }
  mcpBridge.updateContext({ workspaceRoot, library })
}

async function showExternalOnMap(context: vscode.ExtensionContext, request: { map: string | null; nodes: string[]; flow: string | null; note?: string }): Promise<void> {
  const target: WebviewSurface = sidebarView?.visible ? 'sidebar' : 'panel'
  if (target === 'panel') await openPanel(context)
  hub.send(target, { kind: 'externalFocus', map: request.map, nodes: request.nodes, flow: request.flow, note: request.note })
}

async function acceptExternalProposal(
  context: vscode.ExtensionContext,
  proposal: { title: string; summary: string; changes: Record<string, unknown>[]; files: Record<string, string>; requirement?: { id: string; name: string; desc?: string } }
) {
  const lib = bridge?.getLibrary() ?? (bridge?.getRoot() ? (await initAndRememberDefaultLibrary(context)).library : null)
  if (!lib) throw new Error('Open a workspace with a CodeMap library first')
  const saved = await injectExternalProposal(
    lib,
    { title: proposal.title, summary: proposal.summary, changes: proposal.changes, files: proposal.files, requirement: proposal.requirement },
    (event) => post({ type: 'event', channel: 'agent:event', payload: event })
  )
  const target: WebviewSurface = sidebarView?.visible ? 'sidebar' : 'panel'
  if (target === 'panel') await openPanel(context)
  hub.send(target, { kind: 'externalProposal', sessionId: saved.sessionId, changeSetId: saved.changeSet.id })
}

function registerNativeMcp(context: vscode.ExtensionContext, registryDir: string): void {
  if (mcpProvider) return
  const lm = (vscode as unknown as { lm?: { registerMcpServerDefinitionProvider?: (id: string, provider: unknown) => vscode.Disposable } }).lm
  if (!lm?.registerMcpServerDefinitionProvider) return
  try {
    const Definition = (vscode as unknown as { McpStdioServerDefinition?: new (label: string, command: string, args: string[]) => unknown }).McpStdioServerDefinition
    if (!Definition) return
    mcpProvider = lm.registerMcpServerDefinitionProvider('codemap', {
      provideMcpServerDefinitions: () => {
        const config = externalMcpConfig(context)
        return [
          new Definition('CodeMap', 'node', [config.mcpScriptPath, '--registry-dir', registryDir, '--knowledge-dir', config.knowledgeDir, '--workspace', config.workspaceRoot])
        ]
      }
    })
    context.subscriptions.push(mcpProvider)
  } catch {
    mcpProvider = undefined
  }
}
