export type FileKind = 'file' | 'directory'

export interface DirEntry {
  name: string
  path: string
  kind: FileKind
}

export interface WorkspaceInfo {
  root: string
  name: string
}

export interface WorkspaceSettings {
  buildCommand: string
  debug: DebugLaunchConfig
}

export interface DebugLaunchConfig {
  program: string
  args: string[]
  cwd: string
  stopOnEntry: boolean
  preLaunchBuild: boolean
}

export interface FsChange {
  root: string
  path: string
}

export interface TransferResult {
  created: string[]
  failed: { path: string; error: string }[]
}

/** Input for the project map: workspace-relative file paths and per-file git churn (0..1). */
export interface MapIndex {
  files: string[]
  churn: Record<string, number>
  truncated: boolean
}

/** One node library loaded from disk (code map). Docs are raw YAML objects; rules run in the renderer. */
export interface CodemapLoad {
  /** none: no library found; choose: several found and none chosen yet; ready: loaded. */
  status: 'none' | 'choose' | 'ready'
  /** Absolute path of the library folder. */
  library: string | null
  /** How the library was picked. */
  source: 'saved' | 'detected' | null
  candidates: string[]
  docs: { file: string; node: Record<string, any> }[]
  links: { file: string; data: Record<string, any> }[]
  requirements: Array<Record<string, any> & { file: string }>
  /** To-do notes: each folder's todo/*.md with its first heading. */
  todos: { file: string; dir: string; title: string }[]
  errors: { level: 'error' | 'warn' | 'info'; rule: string; where: string; msg: string }[]
  fileCount: number
}

export type CodemapRead =
  | { ok: true; path: string; text: string }
  | { ok: false; reason: 'access'; folder: string }
  | { ok: false; reason: 'missing' | 'error'; message: string }

export type CodemapSide = 'top' | 'bottom' | 'left' | 'right'

/** Text fields of one node edited from the detail panel; null or '' removes the key. */
export interface CodemapNodePatch {
  /** Global id of the node. */
  node: string
  fields: Partial<Record<'name' | 'brief' | 'desc' | 'fn.trigger' | 'fn.outcome', string | null>>
}

export interface CodemapLayoutPatch {
  /** Global id of the map node. */
  map: string
  /** Node key (as written in the map) → [x, y]; null removes the layout. Omitted: unchanged. */
  layout?: Record<string, [number, number]> | null
  /** Edge key (`id`, or `from->to` as written) → [from side, to side]; null removes ports. */
  ports?: Record<string, [CodemapSide | null, CodemapSide | null] | null>
}

export type TaskStream = 'stdout' | 'stderr' | 'system'

export interface TaskOutput {
  taskId: string
  stream: TaskStream
  text: string
}

export interface TaskExit {
  taskId: string
  code: number | null
  signal: string | null
  durationMs: number
}

export interface TerminalInfo {
  id: string
  shell: string
  pid: number
}

export interface TerminalExit {
  id: string
  code: number
  signal: number | null
}

export interface Diagnostic {
  file: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'note'
  message: string
}

export type GitFileState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'copied' | 'typechange'

export interface GitFileChange {
  path: string
  originalPath?: string
  index: GitFileState | null
  worktree: GitFileState | null
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
  files: GitFileChange[]
}

export interface GitBranch {
  name: string
  current: boolean
  remote: boolean
}

export interface GitCommit {
  hash: string
  shortHash: string
  author: string
  date: string
  subject: string
}

export interface GitDiffContent {
  path: string
  original: string
  modified: string
}

export type DebugState = 'idle' | 'starting' | 'running' | 'stopped' | 'terminated'

export interface DebugBreakpoint {
  path: string
  line: number
  verified?: boolean
}

export interface StackFrame {
  id: number
  name: string
  path: string | null
  line: number
  column: number
  presentationHint?: string
}

export interface DebugVariable {
  name: string
  value: string
  type?: string
  variablesReference: number
}

export interface DebugScope {
  name: string
  variablesReference: number
  expensive: boolean
}

export interface DebugThread {
  id: number
  name: string
}

export type DebugEvent =
  | { type: 'state'; state: DebugState; reason?: string; threadId?: number; description?: string }
  | { type: 'output'; category: string; text: string }
  | { type: 'breakpoints'; breakpoints: DebugBreakpoint[] }
  | { type: 'error'; message: string }

export interface PluginContributionView {
  id: string
  title: string
  location: 'sidebar' | 'panel'
  icon?: string
}

export interface PluginContributionCommand {
  id: string
  title: string
  keybinding?: string
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  renderer?: string
  permissions?: {
    network?: string[]
  }
  contributes?: {
    commands?: PluginContributionCommand[]
    views?: PluginContributionView[]
  }
}

export interface PluginDescriptor {
  manifest: PluginManifest
  directory: string
  source: 'builtin' | 'user'
  enabled: boolean
  error?: string
  rendererUrl?: string
}

export interface AppInfo {
  version: string
  platform: string
  arch: string
  userPluginsDir: string
  e2e: boolean
}

export interface AppStateSnapshot {
  recentFolders: string[]
  lastFolder: string | null
  theme: string
  locale: 'en' | 'zh'
}

export interface MenuItemSpec {
  id?: string
  label?: string
  enabled?: boolean
  separator?: boolean
}

export interface ConfirmOptions {
  message: string
  detail?: string
  buttons: string[]
  cancelId?: number
  defaultId?: number
  destructive?: boolean
}

export interface PluginFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface PluginFetchResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}
