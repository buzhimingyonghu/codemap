import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, type IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '../shared/api'
import type { CodemapLayoutPatch, CodemapNodePatch, ConfirmOptions, DebugLaunchConfig, MenuItemSpec, PluginFetchInit, WorkspaceInfo, WorkspaceSettings } from '../shared/types'
import { DebugSession } from './dap/debugSession'
import { CodemapAccess, CodemapWatcher, findLibraries, grantable, isLibrary, loadCodemap, readCodemapFile, resolveFolder, writeCodemapLayout, writeCodemapNode } from './codemap/service'
import { LspManager } from './lsp/manager'
import type { AgentSettings, AgentStartRequest } from '../shared/agent'
import { applyChangeSet, deleteSession, getSession, listSessions, rejectChangeSet, startRun, stopRun } from './agent/runtime'
import { getAgentSettings, resolveProvider, saveAgentSettings, setProviderKey, testProviderConnection } from './agent/settings'
import { listModels } from './agent/providers'
import { knowledgeRoot } from './agent/knowledge'
import type { LspNavigationKind, LspSymbol } from '../shared/lsp'
import { isInside } from '../shared/paths'
import type { SearchQuery } from '../shared/search'
import { listWorkspaceFiles, mapIndex } from './fileIndex'
import {
  createEntry,
  duplicateEntry,
  listDirectory,
  readClipboardFiles,
  readExternalTextFile,
  readTextFile,
  renameEntry,
  revealEntry,
  transferEntries,
  trashEntry,
  writeClipboardFiles,
  writeTextFile
} from './fileService'
import * as gitService from './gitService'
import { buildApplicationMenu } from './menu'
import { discoverPlugins, openUserPluginsFolder, pluginFetch, userPluginsDir } from './plugins'
import {
  forgetLastFolder,
  getAppState,
  getCodemapGrants,
  getCodemapLibrary,
  getLocale,
  getWorkspaceSettings,
  rememberFolder,
  saveWorkspaceSettings,
  setCodemapGrants,
  setCodemapLibrary,
  setLocale,
  setPluginEnabled,
  setTheme
} from './settingsStore'
import { getShellEnv } from './shellEnv'
import { SearchService } from './searchService'
import { TaskRunner } from './taskRunner'
import { TerminalManager } from './terminals'
import { WorkspaceWatcher } from './watcher'
import { clearWorkspaceRoot, getWorkspaceRoot, requireWorkspaceRoot, resolveInWorkspace, setWorkspaceRoot } from './workspace'

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

let mainWindow: BrowserWindow | null = null
let debugSession: DebugSession | null = null
let dirtyCount = 0
const pendingBreakpoints = new Map<string, number[]>()

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

const watcher = new WorkspaceWatcher((paths) => send('fs:changed', paths))
const tasks = new TaskRunner(
  (output) => send('task:output', output),
  (exit) => send('task:exit', exit)
)
const terminals = new TerminalManager(
  (id, data) => send('terminal:data', { id, data }),
  (exit) => send('terminal:exit', exit)
)
const lsp = new LspManager(
  (serverId, text) => send('lsp:log', { serverId, text }),
  () => send('lsp:status', null)
)
const codemapAccess = new CodemapAccess(getWorkspaceRoot, [])
const search = new SearchService()
const codemapWatcher = new CodemapWatcher(() => send('codemap:changed', null))
/** The library loaded last; layout writes are only accepted for its files. */
let codemapLibrary: string | null = null

const AGENT_LSP_LANGUAGES: Record<string, string> = {
  '.c': 'c',
  '.h': 'cpp',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.m': 'objective-c',
  '.mm': 'objective-c',
  '.swift': 'swift',
  '.rs': 'rust',
  '.go': 'go',
  '.py': 'python',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact'
}

const AGENT_SYMBOL_KINDS = [
  'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor',
  'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array',
  'object', 'key', 'null', 'enumMember', 'struct', 'event', 'operator', 'typeParameter'
]

function formatAgentSymbols(symbols: LspSymbol[], depth = 0): string[] {
  const lines: string[] = []
  for (const symbol of symbols) {
    const kind = AGENT_SYMBOL_KINDS[symbol.kind - 1] ?? 'symbol'
    lines.push(`${'  '.repeat(depth)}${kind} ${symbol.name} [L${symbol.line}-L${symbol.endLine}]`)
    if (symbol.children?.length) lines.push(...formatAgentSymbols(symbol.children, depth + 1))
  }
  return lines
}

async function ensureAgentLspOpen(file: string): Promise<boolean> {
  const root = getWorkspaceRoot()
  if (!root || !isInside(root, file)) return false
  const languageId = AGENT_LSP_LANGUAGES[path.extname(file).toLowerCase()]
  if (!languageId) return false
  try {
    const text = await readFile(file, 'utf8')
    return await lsp.open(file, languageId, text)
  } catch {
    return false
  }
}

const electronAgentLsp = {
  async symbols(file: string): Promise<string> {
    if (!(await ensureAgentLspOpen(file))) return '(no symbols)'
    const symbols = await lsp.symbols(file)
    return symbols.length ? formatAgentSymbols(symbols).join('\n') : '(no symbols)'
  },
  async navigate(kind: 'definition' | 'implementation' | 'references', file: string, line: number, column: number): Promise<string> {
    if (!(await ensureAgentLspOpen(file))) return `(no ${kind})`
    const locations = await lsp.navigate(kind, file, line, column)
    const seen = new Set<string>()
    const out: string[] = []
    for (const loc of locations) {
      const key = `${loc.path}:${loc.line}:${loc.column}`
      if (seen.has(key)) continue
      seen.add(key)
      let preview = ''
      try {
        const src = await readFile(loc.path, 'utf8')
        preview = (src.split(/\r?\n/)[loc.line - 1] ?? '').trim().slice(0, 160)
      } catch {
        /* ignore unreadable target */
      }
      out.push(`${loc.path}:${loc.line}:${loc.column}${preview ? `  ${preview}` : ''}`)
      if (out.length >= 40) break
    }
    return out.length ? out.join('\n') : `(no ${kind})`
  },
  async hover(file: string, line: number, column: number): Promise<string> {
    if (!(await ensureAgentLspOpen(file))) return '(no hover)'
    const hover = await lsp.hover(file, line, column)
    return hover?.contents.length ? hover.contents.join('\n\n') : '(no hover)'
  }
}
// Grants load on first use: settings must not be read before index.ts picks the user-data folder.
let grantsLoaded: Promise<void> | null = null
function ensureGrants(): Promise<void> {
  grantsLoaded ??= getCodemapGrants().then((grants) => codemapAccess.setGrants(grants))
  return grantsLoaded
}

// Wraps every handler so errors cross the IPC boundary as plain messages instead of noisy stack dumps.
function handle(channel: string, handler: Handler): void {
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: 'Unauthorized sender' }
    try {
      return { ok: true, value: await handler(event, ...args) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

async function openWorkspace(folder: string): Promise<WorkspaceInfo> {
  await stopDebug()
  tasks.stopAll()
  search.cancel()
  codemapWatcher.stop()
  const root = await setWorkspaceRoot(folder)
  watcher.start(root)
  await lsp.setRoot(root)
  await rememberFolder(root)
  void buildApplicationMenu(() => mainWindow)
  app.addRecentDocument(root)
  mainWindow?.setRepresentedFilename(root)
  mainWindow?.setTitle(path.basename(root))
  pendingBreakpoints.clear()
  return { root, name: path.basename(root) }
}

async function stopDebug(): Promise<void> {
  const session = debugSession
  debugSession = null
  await session?.stop()
}

function requireDebug(): DebugSession {
  if (!debugSession?.active) throw new Error('No active debug session')
  return debugSession
}

export function getDirtyCount(): number {
  return dirtyCount
}

export function shutdownServices(): void {
  watcher.stop()
  codemapWatcher.stop()
  tasks.stopAll()
  terminals.killAll()
  void lsp.stopAll()
  void stopDebug()
}

export function attachWindow(window: BrowserWindow): void {
  mainWindow = window
}

// ---------- Code map ----------

async function loadChosenLibrary(library: string, source: 'saved' | 'detected', candidates: string[] = []) {
  const loaded = await loadCodemap(library)
  codemapWatcher.start(library)
  codemapLibrary = library
  return { status: 'ready' as const, source, candidates, ...loaded }
}

// Written into a new library's .codemapignore (appended if the file exists).
const NEW_LIBRARY_IGNORE = ['# Code Map: folders and files listed here are not read or checked.', '.*', 'node_modules/', 'local/', 'docs/', 'todo/', ''].join('\n')

const EMPTY_CODEMAP = { library: null, source: null, docs: [], links: [], requirements: [], todos: [], errors: [], fileCount: 0 }

async function loadWorkspaceCodemap() {
  const root = requireWorkspaceRoot()
  const saved = await getCodemapLibrary(root)
  if (saved && (await isLibrary(saved).catch(() => false))) return loadChosenLibrary(saved, 'saved')
  const candidates = await findLibraries(root)
  if (candidates.length === 1) return loadChosenLibrary(candidates[0], 'detected', candidates)
  codemapWatcher.stop()
  return { ...EMPTY_CODEMAP, status: candidates.length ? ('choose' as const) : ('none' as const), candidates }
}

async function useCodemapLibrary(folder: string) {
  await ensureGrants()
  const root = requireWorkspaceRoot()
  const library = await resolveFolder(folder)
  if (!(await isLibrary(library))) throw new Error(`No code map nodes in ${library}`)
  if (!codemapAccess.allowed(library)) {
    const granted = await requestCodemapAccess(library, 'library')
    if (!granted) throw new Error('Reading this folder was not allowed')
  }
  await setCodemapLibrary(root, library)
  return loadChosenLibrary(library, 'saved')
}

async function requestCodemapAccess(folder: string, reason: string): Promise<boolean> {
  await ensureGrants()
  if (!mainWindow) return false
  let target: string
  try {
    target = await resolveFolder(folder)
  } catch {
    return false
  }
  if (codemapAccess.allowed(target)) return true
  const locale = await getLocale()
  const zh = locale === 'zh'
  const broad = !grantable(target)
  const detail = broad
    ? zh
      ? `${target}\n\n这个范围太大，不能整体授权。请在地图里打开具体的仓库目录。`
      : `${target}\n\nThis folder is too broad to allow as a whole. Open a specific repository folder instead.`
    : zh
      ? `${target}\n\n代码地图要读取${reason === 'library' ? '这个节点库' : '节点指向的代码和文档'}，它在当前打开的文件夹之外。允许后只读，可以在设置里撤销。`
      : `${target}\n\nThe code map needs to read ${reason === 'library' ? 'this node library' : 'code and documents its nodes point at'}, outside the open folder. Access is read-only and can be revoked in Settings.`
  const buttons = broad ? [zh ? '好' : 'OK'] : [zh ? '允许读取' : 'Allow Reading', zh ? '取消' : 'Cancel']
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    message: zh ? '允许代码地图读取这个文件夹？' : 'Allow the code map to read this folder?',
    detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1
  })
  if (broad || response !== 0) return false
  const grants = [...codemapAccess.list().filter((grant) => !grant.startsWith(`${target}/`)), target]
  codemapAccess.setGrants(grants)
  await setCodemapGrants(grants)
  return true
}

export function registerIpc(): void {
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    userPluginsDir: userPluginsDir(),
    e2e: process.env.CODEMAP_E2E === '1'
  }))
  handle('app:state', async () => {
    const state = await getAppState()
    return { recentFolders: state.recentFolders, lastFolder: state.lastFolder, theme: state.theme, locale: await getLocale() }
  })
  handle('app:setTheme', (_event, theme: string) => setTheme(theme))
  handle('app:setLocale', async (_event, locale: string) => {
    if (locale !== 'en' && locale !== 'zh') throw new Error('Unknown language')
    await setLocale(locale)
    // The native menu is built in the main process; rebuild it in the new language.
    await buildApplicationMenu(() => mainWindow)
  })
  ipcMain.on('app:setDirtyCount', (event, count: number) => {
    if (event.sender !== mainWindow?.webContents) return
    dirtyCount = Math.max(0, Number(count) || 0)
    mainWindow?.setDocumentEdited(dirtyCount > 0)
  })
  handle('app:confirm', async (_event, options: ConfirmOptions) => {
    if (!mainWindow) return options.cancelId ?? 0
    const result = await dialog.showMessageBox(mainWindow, {
      type: options.destructive ? 'warning' : 'question',
      message: options.message,
      detail: options.detail,
      buttons: options.buttons,
      cancelId: options.cancelId,
      defaultId: options.defaultId ?? 0
    })
    return result.response
  })
  handle('app:popupMenu', (_event, items: MenuItemSpec[]) => {
    return new Promise<string | null>((resolve) => {
      let chosen: string | null = null
      const menu = Menu.buildFromTemplate(
        items.map((item) =>
          item.separator
            ? { type: 'separator' as const }
            : { label: item.label, enabled: item.enabled !== false, click: () => (chosen = item.id ?? null) }
        )
      )
      menu.popup({ window: mainWindow ?? undefined, callback: () => setTimeout(() => resolve(chosen), 0) })
    })
  })

  handle('workspace:openDialog', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    return openWorkspace(result.filePaths[0])
  })
  handle('workspace:open', (_event, folder: string) => openWorkspace(folder))
  handle('workspace:close', async () => {
    await stopDebug()
    tasks.stopAll()
    watcher.stop()
    await lsp.setRoot(null)
    clearWorkspaceRoot()
    await forgetLastFolder()
    mainWindow?.setRepresentedFilename('')
    mainWindow?.setTitle('Codemap')
  })
  handle('workspace:getSettings', () => getWorkspaceSettings(requireWorkspaceRoot()))
  handle('workspace:saveSettings', (_event, settings: WorkspaceSettings) => saveWorkspaceSettings(requireWorkspaceRoot(), settings))
  handle('workspace:pickFile', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: getWorkspaceRoot() ?? undefined,
      properties: ['openFile', 'treatPackageAsDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle('fs:list', (_event, dir: string) => listDirectory(dir))
  handle('fs:read', (_event, file: string) => readTextFile(file))
  // Read-only files outside the folder: SDK sources, plus folders granted to the code map.
  handle('fs:readExternal', async (_event, file: string) => {
    await ensureGrants()
    const result = await readCodemapFile(codemapAccess, String(file))
    return result.ok ? result.text : readExternalTextFile(file)
  })
  handle('fs:write', (_event, file: string, content: string) => writeTextFile(file, content))
  handle('fs:create', (_event, parent: string, name: string, kind: 'file' | 'directory') => createEntry(parent, name, kind))
  handle('fs:rename', (_event, from: string, newName: string) => renameEntry(from, newName))
  handle('fs:trash', (_event, target: string) => trashEntry(target))
  handle('fs:reveal', (_event, target: string) => revealEntry(target))
  handle('fs:transfer', (_event, sources: string[], targetDir: string, mode: 'copy' | 'move') =>
    transferEntries(Array.isArray(sources) ? sources.map(String) : [], targetDir, mode === 'move' ? 'move' : 'copy')
  )
  handle('fs:duplicate', (_event, source: string) => duplicateEntry(source))
  handle('fs:readClipboardFiles', () => readClipboardFiles())
  handle('fs:writeClipboardFiles', (_event, paths: string[]) => writeClipboardFiles(paths))
  handle('fs:listFiles', (_event, limit?: number) => listWorkspaceFiles(requireWorkspaceRoot(), limit))
  handle('fs:mapIndex', () => mapIndex(requireWorkspaceRoot()))

  handle('search:run', (_event, query: SearchQuery, skip?: string[]) => search.search(query, Array.isArray(skip) ? skip.map(String) : []))
  handle('search:cancel', () => search.cancel())
  handle('search:replace', (_event, query: SearchQuery, replacement: string, targets: Array<{ path: string; positions: Array<[number, number]> }>) =>
    search.replace(query, String(replacement), Array.isArray(targets) ? targets : [])
  )

  handle('task:run', (_event, command: string) => tasks.run(command, requireWorkspaceRoot()))
  handle('task:stop', (_event, taskId: string) => tasks.stop(taskId))

  // Terminals start in the open folder (or home without one).
  handle('terminal:create', (_event, cols: number, rows: number) => terminals.create(getWorkspaceRoot() ?? app.getPath('home'), cols, rows))
  handle('terminal:kill', (_event, id: string) => terminals.kill(String(id)))
  ipcMain.on('terminal:write', (event, id: string, data: string) => {
    if (event.sender !== mainWindow?.webContents || typeof data !== 'string') return
    terminals.write(String(id), data)
  })
  ipcMain.on('terminal:resize', (event, id: string, cols: number, rows: number) => {
    if (event.sender !== mainWindow?.webContents) return
    terminals.resize(String(id), cols, rows)
  })

  handle('git:status', () => gitService.gitStatus())
  handle('git:init', () => gitService.gitInit())
  handle('git:stage', (_event, paths: string[]) => gitService.gitStage(paths))
  handle('git:unstage', (_event, paths: string[]) => gitService.gitUnstage(paths))
  handle('git:discard', (_event, paths: string[]) => gitService.gitDiscard(paths))
  handle('git:commit', (_event, message: string, amend: boolean) => gitService.gitCommit(message, amend))
  handle('git:branches', () => gitService.gitBranches())
  handle('git:checkout', (_event, name: string, create: boolean) => gitService.gitCheckout(name, create))
  handle('git:log', (_event, limit?: number) => gitService.gitLog(limit))
  handle('git:diff', (_event, file: string, staged: boolean) => gitService.gitDiff(file, staged))
  handle('git:show', (_event, hash: string) => gitService.gitShowCommit(hash))
  handle('git:pull', () => gitService.gitPull())
  handle('git:push', () => gitService.gitPush())

  handle('debug:start', async (_event, config: DebugLaunchConfig) => {
    await stopDebug()
    const root = requireWorkspaceRoot()
    const program = path.resolve(root, config.program)
    const cwd = config.cwd ? resolveInWorkspace(config.cwd) : root
    const session = new DebugSession((event) => send('debug:event', event))
    for (const [file, lines] of pendingBreakpoints) session.setPendingBreakpoints(file, lines)
    debugSession = session
    try {
      await session.start({ ...config, program, cwd }, await getShellEnv())
    } catch (error) {
      await session.stop()
      if (debugSession === session) debugSession = null
      throw error
    }
  })
  handle('debug:stop', () => stopDebug())
  for (const command of ['continue', 'pause', 'next', 'stepIn', 'stepOut'] as const) {
    handle(`debug:${command}`, (_event, threadId: number) => requireDebug().control(command, threadId))
  }
  handle('debug:setBreakpoints', async (_event, file: string, lines: number[]) => {
    const absolute = resolveInWorkspace(file)
    const unique = [...new Set(lines.filter((line) => Number.isInteger(line) && line > 0))].sort((a, b) => a - b)
    if (unique.length) pendingBreakpoints.set(absolute, unique)
    else pendingBreakpoints.delete(absolute)
    if (debugSession?.active) return debugSession.setBreakpoints(absolute, unique)
    return unique.map((line) => ({ path: absolute, line }))
  })
  handle('debug:threads', () => requireDebug().threads())
  handle('debug:stackTrace', (_event, threadId: number) => requireDebug().stackTrace(threadId))
  handle('debug:scopes', (_event, frameId: number) => requireDebug().scopes(frameId))
  handle('debug:variables', (_event, reference: number) => requireDebug().variables(reference))
  handle('debug:evaluate', (_event, expression: string, frameId: number | null) => requireDebug().evaluate(expression, frameId))

  handle('plugins:list', () => discoverPlugins())
  handle('plugins:setEnabled', async (_event, id: string, enabled: boolean) => {
    await setPluginEnabled(id, enabled)
    await discoverPlugins()
  })
  handle('plugins:openFolder', () => openUserPluginsFolder())
  handle('plugins:fetch', (_event, pluginId: string, url: string, init?: PluginFetchInit) => pluginFetch(pluginId, url, init))

  handle('lsp:open', (_event, file: string, languageId: string, text: string) => lsp.open(resolveInWorkspace(file), languageId, text))
  ipcMain.on('lsp:change', (event, file: string, text: string) => {
    if (event.sender !== mainWindow?.webContents) return
    try {
      lsp.change(resolveInWorkspace(file), text)
    } catch {
      /* ignore files outside the folder */
    }
  })
  handle('lsp:save', (_event, file: string) => lsp.save(resolveInWorkspace(file)))
  handle('lsp:close', (_event, file: string) => lsp.close(resolveInWorkspace(file)))
  handle('lsp:navigate', (_event, kind: LspNavigationKind, file: string, line: number, column: number) =>
    lsp.navigate(kind, resolveInWorkspace(file), line, column)
  )
  handle('lsp:hover', (_event, file: string, line: number, column: number) => lsp.hover(resolveInWorkspace(file), line, column))
  handle('lsp:symbols', (_event, file: string) => lsp.symbols(resolveInWorkspace(file)))
  handle('lsp:status', () => lsp.status())
  handle('lsp:restart', (_event, serverId: string) => lsp.restart(serverId))

  handle('codemap:load', () => loadWorkspaceCodemap())
  handle('codemap:chooseLibrary', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: getWorkspaceRoot() ?? undefined,
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return useCodemapLibrary(result.filePaths[0])
  })
  handle('codemap:useLibrary', (_event, folder: string) => useCodemapLibrary(String(folder)))
  // New library: the user picks (or creates) a folder; a .codemapignore marks it as a library.
  handle('codemap:createLibrary', async () => {
    if (!mainWindow) return null
    const root = requireWorkspaceRoot()
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: root,
      buttonLabel: (await getLocale()) === 'zh' ? '用作节点库' : 'Use as Node Library',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const folder = await resolveFolder(result.filePaths[0])
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(folder, '.codemapignore'), NEW_LIBRARY_IGNORE, { flag: 'a' })
    return useCodemapLibrary(folder)
  })
  handle('codemap:pickRepository', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { defaultPath: getWorkspaceRoot() ?? undefined, properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    await ensureGrants()
    const folder = await resolveFolder(result.filePaths[0])
    // Picking the folder in the system dialog is the permission: no second prompt.
    if (!codemapAccess.allowed(folder) && grantable(folder)) {
      const grants = [...codemapAccess.list(), folder]
      codemapAccess.setGrants(grants)
      await setCodemapGrants(grants)
    }
    return folder
  })
  handle('codemap:read', async (_event, file: string) => {
    await ensureGrants()
    return readCodemapFile(codemapAccess, String(file))
  })
  handle('codemap:requestAccess', (_event, folder: string, reason: string) => requestCodemapAccess(String(folder), String(reason)))
  handle('codemap:grants', async () => {
    await ensureGrants()
    return codemapAccess.list()
  })
  handle('codemap:revoke', async (_event, folder: string) => {
    await ensureGrants()
    const grants = codemapAccess.list().filter((grant) => grant !== folder)
    codemapAccess.setGrants(grants)
    await setCodemapGrants(grants)
    return grants
  })
  handle('codemap:writeLayout', async (_event, file: string, patch: CodemapLayoutPatch) => {
    await writeCodemapLayout(getWorkspaceRoot(), codemapLibrary, String(file), patch, (target, content) => codemapWatcher.expectOwnWrite(target, content))
  })
  handle('codemap:writeNode', async (_event, file: string, patch: CodemapNodePatch) => {
    // The library reloads after this write so the checks run on the new text.
    await writeCodemapNode(getWorkspaceRoot(), codemapLibrary, String(file), patch)
  })

  // ---------- Built-in agent ----------
  const requireLibrary = () => {
    if (!codemapLibrary) throw new Error('Open a code map first')
    return codemapLibrary
  }
  handle('agent:settings', () => getAgentSettings())
  handle('agent:saveSettings', (_event, settings: AgentSettings) => saveAgentSettings(settings))
  handle('agent:setKey', (_event, providerId: string, key: string | null) => setProviderKey(String(providerId), key ? String(key) : null))
  handle('agent:models', async (_event, providerId?: string) => {
    const { provider, key } = await resolveProvider(providerId ?? null)
    return listModels(provider, key)
  })
  handle('agent:testConnection', (_event, providerId?: string | null, model?: string) =>
    testProviderConnection(providerId ? String(providerId) : null, model ? String(model) : undefined)
  )
  handle('agent:start', async (_event, request: AgentStartRequest) => {
    await ensureGrants()
    return startRun(requireLibrary(), codemapAccess, request, (event) => send('agent:event', event), { lsp: electronAgentLsp })
  })
  handle('agent:stop', (_event, sessionId: string) => stopRun(String(sessionId)))
  handle('agent:sessions', () => (codemapLibrary ? listSessions(codemapLibrary) : []))
  handle('agent:session', (_event, id: string) => getSession(requireLibrary(), String(id)))
  handle('agent:deleteSession', (_event, id: string) => deleteSession(requireLibrary(), String(id)))
  handle('agent:applyChangeSet', (_event, sessionId: string, changeSetId: string) =>
    applyChangeSet(requireLibrary(), getWorkspaceRoot(), String(sessionId), String(changeSetId))
  )
  handle('agent:rejectChangeSet', (_event, sessionId: string, changeSetId: string) => rejectChangeSet(requireLibrary(), String(sessionId), String(changeSetId)))
  handle('agent:knowledgeDir', () => knowledgeRoot())
  // Picking in the system dialog is the permission to read (like codemap:pickRepository).
  const grantPicked = async (folders: string[]) => {
    await ensureGrants()
    const add = folders.filter((f) => grantable(f) && !codemapAccess.allowed(f))
    if (!add.length) return
    const grants = [...codemapAccess.list(), ...add]
    codemapAccess.setGrants(grants)
    await setCodemapGrants(grants)
  }
  handle('agent:pickRepos', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, { defaultPath: getWorkspaceRoot() ?? undefined, properties: ['openDirectory', 'multiSelections'] })
    if (result.canceled) return []
    const folders = await Promise.all(result.filePaths.map((f) => resolveFolder(f)))
    await grantPicked(folders)
    return folders
  })
  handle('agent:pickDocs', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, { defaultPath: getWorkspaceRoot() ?? undefined, properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return []
    const { realpath } = await import('node:fs/promises')
    const files = await Promise.all(result.filePaths.map((f) => realpath(f)))
    // Grant each file's folder for reading.
    await grantPicked([...new Set(files.map((f) => path.dirname(f)))])
    return files
  })
}
