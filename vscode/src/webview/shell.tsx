import { useEffect, type FC } from 'react'
import { containersOf, isMap } from '../../../src/renderer/src/codemap/model'
import { CodeMapProblemsView } from '../../../src/renderer/src/views/CodeMapProblems'
import { CodeMapView } from '../../../src/renderer/src/views/CodeMap'
import { ProjectMapView } from '../../../src/renderer/src/views/ProjectMap'
import { PromptDialog, Toasts } from '../../../src/renderer/src/workbench/Overlays'
import { applyTheme } from '../../../src/renderer/src/editor/themes'
import { setLocale, useLocale } from '../../../src/renderer/src/lib/i18n'
import { registerCommand } from '../../../src/renderer/src/services/commands'
import {
  chooseLibrary,
  ensureCodeMap,
  getCodeMap,
  initCodeMap,
  mapContext,
  nodesForCode,
  openInEditor,
  reloadCodeMap,
  setNavigation,
  subscribeCodeMap,
  toggleRequirement
} from '../../../src/renderer/src/services/codeMap'
import { closeTab, getActiveTab, saveActive, saveAll } from '../../../src/renderer/src/services/documents'
import { refreshGit } from '../../../src/renderer/src/services/git'
import { registerLanguageFeatures } from '../../../src/renderer/src/services/lsp'
import { goToLastEdit, navigateHistory } from '../../../src/renderer/src/services/navigation'
import { useSearch } from '../../../src/renderer/src/services/search'
import { handleFsChanges } from '../../../src/renderer/src/services/workspace'
import { getState, setState, useStore } from '../../../src/renderer/src/state/store'
import { isInside } from '../../../src/shared/paths'
import { prefixOf } from '../../../src/shared/codemap/codemap.mjs'
import type { NavigationSnapshot } from '../host/session'
import {
  getWebviewPersistedState,
  onHostCursor,
  onHostMode,
  onHostReveal,
  onHostRevealProject,
  onHostSnapshot,
  onHostSidebarSide,
  onHostWorkspace,
  request,
  setWebviewPersistedState
} from './installBridge'
import { installWebviewKeys } from './keys'
import { getVscodePrefs, setVscodePrefs, subscribeVscodePrefs, useVscodePrefs, withInternalReveal } from './prefs'
import { VscodeTopBar } from './TopBar'
import { ensureMap, initProjectMap, rememberFocus, rememberedFocus, revealInExplorer, setExplorerMode, subscribeMap, toAbsolute } from './wrappers/projectMap'
import { refitCodeMaps } from './wrappers/codeMapEngine'
import { refitProjectMaps } from './wrappers/mapEngine'

let booted = false
let snapshotReady = false
let snapshotTimer: ReturnType<typeof setTimeout> | undefined
let applyingSnapshot = false

type PersistedShell = { mode?: 'map' | 'codemap' }

function initialMode(): 'map' | 'codemap' {
  const saved = getWebviewPersistedState<PersistedShell>()?.mode
  return saved === 'map' || saved === 'codemap' ? saved : 'codemap'
}

function boot(root: string, name: string): void {
  const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast')
  const theme = dark ? 'graphite' : 'paper'
  const locale = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  applyTheme(theme)
  setLocale(locale)
  const workspace = root ? { root, name } : null
  if (booted) {
    const current = getState().workspace
    if (current?.root !== workspace?.root || current?.name !== workspace?.name) {
      setState({ workspace, theme })
    }
    return
  }
  booted = true
  const explorerMode = initialMode()
  setState({
    workspace,
    explorerMode,
    theme,
    settings: { buildCommand: '', debug: { program: '', args: [], cwd: root, stopOnEntry: false, preLaunchBuild: false } }
  })
  registerLanguageFeatures()
  initCodeMap()
  initProjectMap()
  registerCommand('file.save', () => saveActive(), { title: 'Save', category: 'File', source: 'core' })
  registerCommand('file.saveAll', () => saveAll(), { title: 'Save All', category: 'File', source: 'core' })
  registerCommand('editor.closeTab', () => closeEditorTab(), { title: 'Close Tab', category: 'View', source: 'core' })
  registerCommand('editor.navigateBack', () => navigateHistory(-1), { title: 'Go Back', category: 'Go', source: 'core' })
  registerCommand('editor.navigateForward', () => navigateHistory(1), { title: 'Go Forward', category: 'Go', source: 'core' })
  registerCommand('editor.lastEdit', () => goToLastEdit(), { title: 'Go to Last Edit Location', category: 'Go', source: 'core' })
  registerCommand('codemap.reveal', () => revealCodeNodeFromActive(), { title: 'Show in Code Map', category: 'Code Map', source: 'core' })
  registerCommand('codemap.reload', () => reloadCodeMap(), { title: 'Reload Node Library', category: 'Code Map', source: 'core' })
  registerCommand('codemap.chooseLibrary', () => chooseLibrary(), { title: 'Choose Node Library…', category: 'Code Map', source: 'core' })
  registerCommand(
    'codemap.problems',
    () => setState({ panelVisible: !getState().panelVisible, panelView: 'codemap' }),
    { title: 'Show Code Map Checks', category: 'Code Map', source: 'core' }
  )
  installWebviewKeys()
  window.codemap.fs.onChange((paths) => handleFsChanges(paths))
  void refreshGit()
  let focusToken = useSearch.getState().focusToken
  useSearch.subscribe((state) => {
    if (state.focusToken === focusToken) return
    focusToken = state.focusToken
    void request('host:findInFiles', [state.pattern, state.include])
  })
  const syncTheme = () => {
    const nextDark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast')
    const nextTheme = nextDark ? 'graphite' : 'paper'
    if (getState().theme === nextTheme) return
    applyTheme(nextTheme)
    setState({ theme: nextTheme })
  }
  new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] })
}

async function closeEditorTab(): Promise<void> {
  const tab = getActiveTab()
  if (!tab) return
  const closed = await closeTab(tab.id)
  if (closed && getState().tabs.length === 0) setState({ mapEditorOpen: false })
}

/** The map to open for `id`: the node itself when it is a map, else a map that contains it. */
function mapForNode(ctx: NonNullable<ReturnType<typeof mapContext>>, id: string): string | null {
  for (let current: string | null = id; current; current = prefixOf(current)) {
    const ups = containersOf(ctx, current)
    if (current !== id && isMap(ctx, current)) return current
    if (ups.length) return ups[0]
  }
  return isMap(ctx, id) ? id : null
}

/** Highlights the code-map node. Opening the rising editor is opt-in so sidebar reveals cannot loop back into VS Code. */
async function revealCodeNode(path: string, line?: number, openRising = false): Promise<void> {
  selectMode('codemap')
  await ensureCodeMap()
  const ctx = mapContext()
  if (!ctx) return
  const ids = nodesForCode(path, line)
  const targetId = ids[0]
  const map = targetId ? mapForNode(ctx, targetId) : null
  if (map && targetId) {
    setState({ mapEditorOpen: false })
    setNavigation([map], null, targetId)
  }
  if (!openRising) return
  if (getVscodePrefs().surface === 'panel') {
    await withInternalReveal(() => openInEditor(path, line == null ? null : [line, line]))
    setState({ mapEditorOpen: false })
  }
}

async function revealCodeNodeFromActive(): Promise<void> {
  const tab = getActiveTab()
  if (tab?.kind !== 'file' || !tab.path) return
  await revealCodeNode(tab.path, getState().cursor?.line, false)
}

async function revealFromHost(path: string, line: number): Promise<void> {
  await revealCodeNode(path, line, getVscodePrefs().surface === 'panel')
}

async function revealProjectFromHost(path: string): Promise<void> {
  setExplorerMode('map')
  await ensureMap()
  revealInExplorer(path)
}

async function followCursor(path: string, line: number): Promise<void> {
  if (!getVscodePrefs().followCursor || getState().mapEditorOpen) return
  if (getState().explorerMode === 'map') {
    const root = getState().workspace?.root
    if (!root || !isInside(root, path)) return
    await ensureMap()
    revealInExplorer(path)
    return
  }
  await ensureCodeMap()
  const ids = nodesForCode(path, line)
  const ctx = mapContext()
  if (!ids.length || !ctx) return
  const map = mapForNode(ctx, ids[0])
  if (!map) return
  const current = getCodeMap()
  if (current.focus === ids[0] && current.stack.at(-1) === map) return
  setNavigation([map], current.flowId, ids[0])
}

function captureSnapshot(): NavigationSnapshot {
  const root = getState().workspace?.root ?? ''
  const mode = getState().explorerMode === 'map' ? 'map' : 'codemap'
  const cm = getCodeMap()
  const prefs = getVscodePrefs()
  const snapshot: NavigationSnapshot = {
    mode,
    projectFocusRel: root ? (rememberedFocus(root) ?? '') : '',
    codemapLibrary: cm.library,
    codemapStack: cm.stack,
    codemapFlowId: cm.flowId,
    codemapFocus: cm.focus,
    codemapReqIndex: cm.reqIndex,
    codemapReqOn: cm.reqOn,
    followCursor: prefs.followCursor
  }
  return snapshot
}

function flushScheduledSnapshot(): void {
  if (!snapshotTimer) return
  clearTimeout(snapshotTimer)
  snapshotTimer = undefined
  if (!snapshotReady || applyingSnapshot) return
  void request('host:saveSnapshot', [captureSnapshot()])
}

function scheduleSnapshot(): void {
  if (!snapshotReady || applyingSnapshot) return
  if (snapshotTimer) clearTimeout(snapshotTimer)
  snapshotTimer = setTimeout(() => {
    snapshotTimer = undefined
    void request('host:saveSnapshot', [captureSnapshot()])
  }, 120)
}

function installSnapshotWatch(): () => void {
  const stopCode = subscribeCodeMap(scheduleSnapshot)
  const stopMap = subscribeMap(scheduleSnapshot)
  const stopPrefs = subscribeVscodePrefs(scheduleSnapshot)
  const stopStore = useStore.subscribe((state, previous) => {
    if (state.explorerMode !== previous.explorerMode) scheduleSnapshot()
  })
  const onHide = () => {
    if (document.hidden) flushScheduledSnapshot()
  }
  document.addEventListener('visibilitychange', onHide)
  window.addEventListener('pagehide', flushScheduledSnapshot)
  const focusTimer = window.setInterval(() => {
    const root = getState().workspace?.root
    if (!root) return
    const rel = rememberedFocus(root) ?? ''
    const key = `${root} ${rel}`
    if (key === lastFocusKey) return
    lastFocusKey = key
    scheduleSnapshot()
  }, 400)
  return () => {
    flushScheduledSnapshot()
    document.removeEventListener('visibilitychange', onHide)
    window.removeEventListener('pagehide', flushScheduledSnapshot)
    stopCode()
    stopMap()
    stopPrefs()
    stopStore()
    window.clearInterval(focusTimer)
  }
}

let lastFocusKey = ''

async function applySnapshot(snap: NavigationSnapshot): Promise<void> {
  applyingSnapshot = true
  try {
    const patch: { followCursor?: boolean } = {}
    if (typeof snap.followCursor === 'boolean') patch.followCursor = snap.followCursor
    if (Object.keys(patch).length) setVscodePrefs(patch)
    selectMode(snap.mode)
    const root = getState().workspace?.root
    if (snap.projectFocusRel != null && root) {
      rememberFocus(root, snap.projectFocusRel)
      if (snap.mode === 'map') {
        await ensureMap()
        revealInExplorer(toAbsolute(root, snap.projectFocusRel))
        requestAnimationFrame(() => {
          refitProjectMaps(true)
          refitCodeMaps()
        })
      }
    }
    if (snap.codemapStack?.length) {
      await ensureCodeMap()
      const ctx = mapContext()
      if (ctx) {
        const validStack = snap.codemapStack.filter((id) => isMap(ctx, id))
        if (validStack.length) {
          setNavigation(validStack, snap.codemapFlowId ?? null, null)
          if (typeof snap.codemapReqIndex === 'number' && typeof snap.codemapReqOn === 'boolean') {
            const current = getCodeMap()
            if (snap.codemapReqOn) {
              if (!current.reqOn || current.reqIndex !== snap.codemapReqIndex) toggleRequirement(snap.codemapReqIndex)
            } else if (current.reqOn) {
              toggleRequirement(current.reqIndex)
            }
          }
        }
      }
      requestAnimationFrame(() => {
        refitCodeMaps()
      })
    }
  } finally {
    applyingSnapshot = false
  }
}

function selectMode(mode: 'map' | 'codemap'): void {
  setExplorerMode(mode)
  if (mode === 'map') void ensureMap()
  else void ensureCodeMap()
}

function expandToPanel(): void {
  void request('host:expandToPanel', [captureSnapshot()])
}

function collapseToSidebar(): void {
  void request('host:collapseToSidebar', [captureSnapshot()])
}

export const CodeMapShell: FC<{ root: string; name: string }> & { boot(root: string, name: string): void } = function CodeMapShell({ root, name }) {
  useLocale()
  const panelVisible = useStore((s) => s.panelVisible)
  const explorerMode = useStore((s) => s.explorerMode)
  const { surface, sidebarDrawerOpen, sidebarSide } = useVscodePrefs()
  useEffect(() => {
    boot(root, name)
    return onHostReveal(({ path, line }) => {
      void revealFromHost(path, line)
    })
  }, [root, name])

  useEffect(() => {
    return onHostWorkspace(({ root: nextRoot, name: nextName }) => {
      setState({ workspace: nextRoot ? { root: nextRoot, name: nextName } : null })
    })
  }, [])

  useEffect(() => onHostMode(selectMode), [])

  useEffect(() => onHostSidebarSide((side) => setVscodePrefs({ sidebarSide: side })), [])

  useEffect(() => {
    return onHostRevealProject(({ path }) => {
      void revealProjectFromHost(path)
    })
  }, [])

  useEffect(() => {
    return onHostCursor(({ path, line }) => {
      void followCursor(path, line)
    })
  }, [])

  useEffect(() => {
    return onHostSnapshot((snap) => {
      void applySnapshot(snap)
    })
  }, [])

  useEffect(() => installSnapshotWatch(), [])

  useEffect(() => {
    if (explorerMode !== 'map' && explorerMode !== 'codemap') return
    void request('host:rememberMode', [explorerMode])
    const current = getWebviewPersistedState<PersistedShell>() ?? {}
    if (current.mode === explorerMode) return
    setWebviewPersistedState({ ...current, mode: explorerMode })
    scheduleSnapshot()
  }, [explorerMode])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      refitProjectMaps(false)
      refitCodeMaps()
    })
    return () => cancelAnimationFrame(frame)
  }, [sidebarDrawerOpen, explorerMode])

  useEffect(() => {
    void request('webview:ready').finally(() => {
      snapshotReady = true
    })
  }, [])

  return (
    <div
      className={`lumen-vscode${surface === 'sidebar' ? ` is-sidebar is-dock-${sidebarSide}` : ''}${sidebarDrawerOpen ? ' is-drawer-open' : ''}`}
      data-sidebar-side={sidebarSide}
    >
      <VscodeTopBar onSelectMode={selectMode} onExpandToPanel={expandToPanel} onCollapseToSidebar={collapseToSidebar} />
      <div className="lumen-vscode-stage">
        {explorerMode === 'map' ? <ProjectMapView /> : <CodeMapView />}
        {explorerMode === 'codemap' && panelVisible ? (
          <div className="lumen-vscode-problems">
            <CodeMapProblemsView />
          </div>
        ) : null}
      </div>
      <PromptDialog />
      <Toasts />
    </div>
  )
}

CodeMapShell.boot = boot
