import { dirname } from '@shared/paths'
import type { WorkspaceInfo, WorkspaceSettings } from '@shared/types'
import { getState, initialDebug, setState } from '../state/store'
import { closeAllTabs, handleDeleted, syncFromDisk } from './documents'
import { refreshGit } from './git'
import { reportError } from './ui'
import { Emitter } from '../lib/events'
import { t } from '../lib/i18n'

export const onDidOpenWorkspace = new Emitter<WorkspaceInfo>()
export const onDidCloseWorkspace = new Emitter<void>()
export const onDidChangeFiles = new Emitter<string[]>()

export async function loadChildren(dir: string): Promise<void> {
  try {
    const entries = await window.codemap.fs.list(dir)
    setState({ children: { ...getState().children, [dir]: entries } })
  } catch {
    const children = { ...getState().children }
    delete children[dir]
    setState({ children })
  }
}

export async function toggleFolder(dir: string, open?: boolean): Promise<void> {
  const isOpen = open ?? !getState().expanded[dir]
  setState({ expanded: { ...getState().expanded, [dir]: isOpen } })
  if (isOpen && !getState().children[dir]) await loadChildren(dir)
}

export async function revealInTree(path: string): Promise<void> {
  const root = getState().workspace?.root
  if (!root || !path.startsWith(root)) return
  const chain: string[] = []
  let current = dirname(path)
  while (current.length >= root.length) {
    chain.unshift(current)
    if (current === root) break
    current = dirname(current)
  }
  for (const dir of chain) await toggleFolder(dir, true)
  setState({ selectedPath: path })
}

export async function openWorkspace(info: WorkspaceInfo): Promise<void> {
  if (getState().workspace && !(await closeAllTabs())) return
  let settings: WorkspaceSettings | null = null
  try {
    settings = await window.codemap.workspace.getSettings()
  } catch (error) {
    reportError(error)
  }
  const state = await window.codemap.app.state().catch(() => null)
  setState({
    workspace: info,
    settings,
    recentFolders: state?.recentFolders ?? getState().recentFolders,
    expanded: { [info.root]: true },
    children: {},
    selectedPath: null,
    tabs: [],
    activeTabId: null,
    dirty: {},
    output: [],
    diagnostics: [],
    git: null,
    branches: [],
    commits: [],
    debug: initialDebug,
    variables: {},
    breakpoints: {},
    debugConsole: [],
    build: { status: 'idle', taskId: null }
  })
  await loadChildren(info.root)
  void refreshGit()
  onDidOpenWorkspace.emit(info)
}

export async function openFolderDialog(): Promise<void> {
  try {
    const info = await window.codemap.workspace.openDialog()
    if (info) await openWorkspace(info)
  } catch (error) {
    reportError(error, t('Cannot open folder'))
  }
}

export async function openFolderPath(path: string): Promise<void> {
  try {
    const info = await window.codemap.workspace.open(path)
    await openWorkspace(info)
  } catch (error) {
    reportError(error, t('Cannot open folder'))
    const state = await window.codemap.app.state().catch(() => null)
    if (state) setState({ recentFolders: state.recentFolders })
  }
}

export async function closeWorkspace(): Promise<void> {
  if (!(await closeAllTabs())) return
  await window.codemap.workspace.close()
  setState({ workspace: null, settings: null, children: {}, expanded: {}, git: null, debug: initialDebug })
  onDidCloseWorkspace.emit()
}

export async function saveSettings(settings: WorkspaceSettings): Promise<void> {
  const saved = await window.codemap.workspace.saveSettings(settings)
  setState({ settings: saved })
}

// Coalesces watcher events into folder reloads, buffer syncs, and one git refresh.
export function handleFsChanges(paths: string[]): void {
  const state = getState()
  const root = state.workspace?.root
  if (!root) return
  const dirs = new Set<string>()
  let gitTouched = false
  for (const path of paths) {
    if (path.includes('/.git/') || path.endsWith('/.git')) {
      gitTouched = true
      continue
    }
    gitTouched = true
    const parent = dirname(path)
    if (state.children[parent]) dirs.add(parent)
    if (state.children[path]) dirs.add(path)
  }
  for (const dir of dirs) void loadChildren(dir)
  void syncFromDisk(paths)
  if (gitTouched) scheduleGitRefresh()
  onDidChangeFiles.emit(paths)
}

let gitTimer: number | null = null
function scheduleGitRefresh(): void {
  if (gitTimer) window.clearTimeout(gitTimer)
  gitTimer = window.setTimeout(() => {
    gitTimer = null
    void refreshGit()
  }, 400)
}

export async function createEntry(parent: string, name: string, kind: 'file' | 'directory'): Promise<string | null> {
  try {
    const created = await window.codemap.fs.create(parent, name, kind)
    await toggleFolder(parent, true)
    await loadChildren(parent)
    return created
  } catch (error) {
    reportError(error, t('Cannot create {name}', { name }))
    return null
  }
}

export async function deleteEntry(path: string): Promise<void> {
  await window.codemap.fs.trash(path)
  await handleDeleted(path)
  await loadChildren(dirname(path))
}
