import { create } from 'zustand'
import type {
  AppInfo,
  DebugScope,
  DebugState,
  DebugVariable,
  Diagnostic,
  DirEntry,
  GitBranch,
  GitCommit,
  GitStatus,
  PluginDescriptor,
  StackFrame,
  TaskStream,
  WorkspaceInfo,
  WorkspaceSettings
} from '@shared/types'
import type { LspServerStatus } from '@shared/lsp'

export type TabKind = 'file' | 'diff' | 'commit'

export interface Tab {
  id: string
  kind: TabKind
  title: string
  path?: string
  staged?: boolean
  hash?: string
  readOnly?: boolean
}

export interface OutputLine {
  id: number
  stream: TaskStream
  text: string
}

export interface ConsoleLine {
  id: number
  kind: 'output' | 'stderr' | 'input' | 'result' | 'error'
  text: string
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'warning' | 'error'
  message: string
  detail?: string
}

export interface PromptRequest {
  title: string
  placeholder?: string
  value?: string
  confirmLabel?: string
  resolve: (value: string | null) => void
}

export interface PluginRuntime {
  descriptor: PluginDescriptor
  active: boolean
  error?: string
}

export type BuildStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'stopped'

/** How the explorer shows the folder: the classic tree, the project map, or the code map. */
export type ExplorerMode = 'classic' | 'map' | 'codemap'

export interface DebugSnapshot {
  state: DebugState
  threadId: number | null
  frames: StackFrame[]
  selectedFrameId: number | null
  scopes: DebugScope[]
  reason?: string
  location?: { path: string; line: number }
}

export interface CodemapAppState {
  appInfo: AppInfo | null
  theme: string
  recentFolders: string[]
  workspace: WorkspaceInfo | null
  settings: WorkspaceSettings | null

  expanded: Record<string, boolean>
  children: Record<string, DirEntry[] | undefined>
  selectedPath: string | null
  renamingPath: string | null
  creating: { parent: string; kind: 'file' | 'directory' } | null
  cutPaths: string[]
  dropTarget: string | null

  tabs: Tab[]
  activeTabId: string | null
  dirty: Record<string, boolean>
  cursor: { line: number; column: number; selected: number } | null

  sidebarView: string
  sidebarVisible: boolean
  sidebarWidth: number
  panelVisible: boolean
  panelView: string
  panelHeight: number
  explorerMode: ExplorerMode
  /** In map and code map mode: the editor is raised over the map (true) or the map is showing (false). */
  mapEditorOpen: boolean
  /** How many items (folders and files) a map level shows when you enter it. */
  mapItemsPerScreen: number

  build: { status: BuildStatus; taskId: string | null; startedAt?: number; durationMs?: number; exitCode?: number | null }
  output: OutputLine[]
  diagnostics: Diagnostic[]

  git: GitStatus | null
  branches: GitBranch[]
  commits: GitCommit[]
  gitBusy: string | null

  debug: DebugSnapshot
  variables: Record<number, DebugVariable[]>
  breakpoints: Record<string, number[]>
  debugConsole: ConsoleLine[]

  plugins: PluginRuntime[]
  registryVersion: number
  lspServers: LspServerStatus[]

  quickPick: { mode: 'files' | 'commands'; session: number } | null
  settingsOpen: boolean
  prompt: PromptRequest | null
  toasts: Toast[]
}

function readNumber(key: string, fallback: number): number {
  const value = Number(localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function readExplorerMode(): ExplorerMode {
  const saved = localStorage.getItem('layout.explorerMode')
  return saved === 'map' || saved === 'codemap' ? saved : 'classic'
}

export const initialDebug: DebugSnapshot = {
  state: 'idle',
  threadId: null,
  frames: [],
  selectedFrameId: null,
  scopes: []
}

export const useStore = create<CodemapAppState>(() => ({
  appInfo: null,
  theme: 'graphite',
  recentFolders: [],
  workspace: null,
  settings: null,

  expanded: {},
  children: {},
  selectedPath: null,
  renamingPath: null,
  creating: null,
  cutPaths: [],
  dropTarget: null,

  tabs: [],
  activeTabId: null,
  dirty: {},
  cursor: null,

  sidebarView: 'explorer',
  sidebarVisible: localStorage.getItem('layout.sidebarVisible') !== '0',
  sidebarWidth: readNumber('layout.sidebarWidth', 272),
  panelVisible: localStorage.getItem('layout.panelVisible') === '1',
  panelView: 'output',
  panelHeight: readNumber('layout.panelHeight', 240),
  explorerMode: readExplorerMode(),
  mapEditorOpen: false,
  mapItemsPerScreen: readNumber('map.itemsPerScreen', 40),

  build: { status: 'idle', taskId: null },
  output: [],
  diagnostics: [],

  git: null,
  branches: [],
  commits: [],
  gitBusy: null,

  debug: initialDebug,
  variables: {},
  breakpoints: {},
  debugConsole: [],

  plugins: [],
  registryVersion: 0,
  lspServers: [],

  quickPick: null,
  settingsOpen: false,
  prompt: null,
  toasts: []
}))

export const getState = useStore.getState
export const setState = useStore.setState

useStore.subscribe((state, previous) => {
  if (state.sidebarVisible !== previous.sidebarVisible) localStorage.setItem('layout.sidebarVisible', state.sidebarVisible ? '1' : '0')
  if (state.panelVisible !== previous.panelVisible) localStorage.setItem('layout.panelVisible', state.panelVisible ? '1' : '0')
  if (state.sidebarWidth !== previous.sidebarWidth) localStorage.setItem('layout.sidebarWidth', String(Math.round(state.sidebarWidth)))
  if (state.panelHeight !== previous.panelHeight) localStorage.setItem('layout.panelHeight', String(Math.round(state.panelHeight)))
  if (state.explorerMode !== previous.explorerMode) localStorage.setItem('layout.explorerMode', state.explorerMode)
  if (state.mapItemsPerScreen !== previous.mapItemsPerScreen) localStorage.setItem('map.itemsPerScreen', String(state.mapItemsPerScreen))
})

let nextId = 1
export function uid(): number {
  return nextId++
}
