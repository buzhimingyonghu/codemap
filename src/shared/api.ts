import type {
  AppInfo,
  AppStateSnapshot,
  CodemapLoad,
  CodemapLayoutPatch,
  CodemapNodePatch,
  CodemapRead,
  ConfirmOptions,
  DebugBreakpoint,
  DebugEvent,
  DebugLaunchConfig,
  DebugScope,
  DebugThread,
  DebugVariable,
  DirEntry,
  GitBranch,
  GitCommit,
  GitDiffContent,
  GitStatus,
  MapIndex,
  MenuItemSpec,
  PluginDescriptor,
  PluginFetchInit,
  PluginFetchResponse,
  StackFrame,
  TaskExit,
  TaskOutput,
  TerminalExit,
  TerminalInfo,
  TransferResult,
  WorkspaceInfo,
  WorkspaceSettings
} from './types'
import type { ReplaceResult, SearchQuery, SearchResult } from './search'
import type { LspHover, LspLocation, LspNavigationKind, LspServerStatus, LspSymbol } from './lsp'
import type { AgentEvent, AgentSessionInfo, AgentSessionSummary, AgentSettings, AgentStartRequest, ProviderConnection } from './agent'

export type Unsubscribe = () => void

// The complete surface the renderer (and therefore every plugin) can reach.
// Anything not listed here is unavailable to web content by design.
export interface CodemapApi {
  app: {
    info(): Promise<AppInfo>
    state(): Promise<AppStateSnapshot>
    setTheme(theme: string): Promise<void>
    setLocale(locale: 'en' | 'zh'): Promise<void>
    setDirtyCount(count: number): void
    confirm(options: ConfirmOptions): Promise<number>
    popupMenu(items: MenuItemSpec[]): Promise<string | null>
    onMenuCommand(listener: (command: string) => void): Unsubscribe
  }
  workspace: {
    openDialog(): Promise<WorkspaceInfo | null>
    open(path: string): Promise<WorkspaceInfo>
    close(): Promise<void>
    getSettings(): Promise<WorkspaceSettings>
    saveSettings(settings: WorkspaceSettings): Promise<WorkspaceSettings>
    pickFile(): Promise<string | null>
  }
  fs: {
    list(dir: string): Promise<DirEntry[]>
    read(file: string): Promise<string>
    readExternal(file: string): Promise<string>
    write(file: string, content: string): Promise<void>
    create(parent: string, name: string, kind: 'file' | 'directory'): Promise<string>
    rename(from: string, newName: string): Promise<string>
    trash(path: string): Promise<void>
    reveal(path: string): Promise<void>
    transfer(sources: string[], targetDir: string, mode: 'copy' | 'move'): Promise<TransferResult>
    duplicate(path: string): Promise<string>
    readClipboardFiles(): Promise<string[]>
    writeClipboardFiles(paths: string[]): Promise<void>
    pathForFile(file: File): string
    listFiles(limit?: number): Promise<string[]>
    mapIndex(): Promise<MapIndex>
    onChange(listener: (paths: string[]) => void): Unsubscribe
  }
  search: {
    /** Resolves to null when a newer search or a cancel superseded this one. */
    run(query: SearchQuery, skip?: string[]): Promise<SearchResult | null>
    cancel(): Promise<void>
    replace(query: SearchQuery, replacement: string, targets: Array<{ path: string; positions: Array<[number, number]> }>): Promise<ReplaceResult>
  }
  tasks: {
    run(command: string): Promise<string>
    stop(taskId: string): Promise<void>
    onOutput(listener: (output: TaskOutput) => void): Unsubscribe
    onExit(listener: (exit: TaskExit) => void): Unsubscribe
  }
  terminal: {
    create(cols: number, rows: number): Promise<TerminalInfo>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<void>
    onData(listener: (event: { id: string; data: string }) => void): Unsubscribe
    onExit(listener: (exit: TerminalExit) => void): Unsubscribe
  }
  git: {
    status(): Promise<GitStatus>
    init(): Promise<void>
    stage(paths: string[]): Promise<void>
    unstage(paths: string[]): Promise<void>
    discard(paths: string[]): Promise<void>
    commit(message: string, amend: boolean): Promise<void>
    branches(): Promise<GitBranch[]>
    checkout(name: string, create: boolean): Promise<void>
    log(limit?: number): Promise<GitCommit[]>
    diff(path: string, staged: boolean): Promise<GitDiffContent>
    show(hash: string): Promise<string>
    pull(): Promise<string>
    push(): Promise<string>
  }
  debug: {
    start(config: DebugLaunchConfig): Promise<void>
    stop(): Promise<void>
    continue(threadId: number): Promise<void>
    pause(threadId: number): Promise<void>
    next(threadId: number): Promise<void>
    stepIn(threadId: number): Promise<void>
    stepOut(threadId: number): Promise<void>
    setBreakpoints(path: string, lines: number[]): Promise<DebugBreakpoint[]>
    threads(): Promise<DebugThread[]>
    stackTrace(threadId: number): Promise<StackFrame[]>
    scopes(frameId: number): Promise<DebugScope[]>
    variables(reference: number): Promise<DebugVariable[]>
    evaluate(expression: string, frameId: number | null): Promise<string>
    onEvent(listener: (event: DebugEvent) => void): Unsubscribe
  }
  plugins: {
    list(): Promise<PluginDescriptor[]>
    setEnabled(id: string, enabled: boolean): Promise<void>
    openFolder(): Promise<void>
    fetch(pluginId: string, url: string, init?: PluginFetchInit): Promise<PluginFetchResponse>
  }
  lsp: {
    open(path: string, languageId: string, text: string): Promise<boolean>
    change(path: string, text: string): void
    save(path: string): Promise<void>
    close(path: string): Promise<void>
    navigate(kind: LspNavigationKind, path: string, line: number, column: number): Promise<LspLocation[]>
    hover(path: string, line: number, column: number): Promise<LspHover | null>
    symbols(path: string): Promise<LspSymbol[]>
    status(): Promise<LspServerStatus[]>
    restart(serverId: string): Promise<void>
    onStatus(listener: () => void): Unsubscribe
    onLog(listener: (entry: { serverId: string; text: string }) => void): Unsubscribe
  }
  codemap: {
    /** Finds and loads the node library for the open folder (saved choice, or detected). */
    load(): Promise<CodemapLoad>
    /** Opens a folder picker and loads the chosen library; null when cancelled. */
    chooseLibrary(): Promise<CodemapLoad | null>
    /** Picks or creates a folder and makes it a new, empty node library; null when cancelled. */
    createLibrary(): Promise<CodemapLoad | null>
    /** Uses one of the detected candidates. */
    useLibrary(path: string): Promise<CodemapLoad>
    /** Picks a local repository folder for a node without `repo.local`; choosing it grants reading. */
    pickRepository(): Promise<string | null>
    /**
     * Writes a map's hand-arranged layout (`layout` on the map node, `ports` on edges) into the
     * YAML file that defines the map. Only those fields change; comments and formatting stay.
     */
    writeLayout(file: string, patch: CodemapLayoutPatch): Promise<void>
    /** Writes a few text fields of one node (name, brief, desc, fn.trigger, fn.outcome). */
    writeNode(file: string, patch: CodemapNodePatch): Promise<void>
    /** Reads a code or doc file; folders outside the open folder need a grant first. */
    read(path: string): Promise<CodemapRead>
    /** Asks in a native dialog to allow reading `folder`; resolves true when granted. */
    requestAccess(folder: string, reason: string): Promise<boolean>
    grants(): Promise<string[]>
    revoke(folder: string): Promise<string[]>
    onChange(listener: () => void): Unsubscribe
  }
  agent: {
    settings(): Promise<AgentSettings>
    saveSettings(settings: AgentSettings): Promise<AgentSettings>
    /** Stores a provider's API key in the keychain; null removes it. */
    setKey(providerId: string, key: string | null): Promise<AgentSettings>
    /** Model ids the provider offers. */
    models(providerId?: string): Promise<string[]>
    /** Checks that the provider and model answer without returning the key. */
    testConnection(providerId?: string | null, model?: string): Promise<ProviderConnection>
    /** Starts a run (new session or continuing one); resolves to the session id. Events follow. */
    start(request: AgentStartRequest): Promise<string>
    stop(sessionId: string): Promise<void>
    sessions(): Promise<AgentSessionSummary[]>
    session(id: string): Promise<AgentSessionInfo>
    deleteSession(id: string): Promise<void>
    /** Writes an accepted change set into the library; resolves to the files written. */
    applyChangeSet(sessionId: string, changeSetId: string): Promise<string[]>
    rejectChangeSet(sessionId: string, changeSetId: string): Promise<void>
    /** Permanently removes an unapplied draft change set from the conversation without touching library files. */
    discardChangeSet(sessionId: string, changeSetId: string): Promise<void>
    /** The knowledge folder the assistant follows (ships with the app). */
    knowledgeDir(): Promise<string>
    /** Folder dialog (multi-select) for repositories; chosen folders become readable. */
    pickRepos(): Promise<string[]>
    /** File dialog (multi-select) for local documents; chosen files become readable. */
    pickDocs(): Promise<string[]>
    onEvent(listener: (event: AgentEvent) => void): Unsubscribe
  }
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }
