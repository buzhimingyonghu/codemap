import { useEffect, type FC } from 'react'
import { containersOf, isMap } from '../../../src/renderer/src/codemap/model'
import { CodeMapProblemsView } from '../../../src/renderer/src/views/CodeMapProblems'
import { CodeMapView } from '../../../src/renderer/src/views/CodeMap'
import { ProjectMapView } from '../../../src/renderer/src/views/ProjectMap'
import { PromptDialog, Toasts } from '../../../src/renderer/src/workbench/Overlays'
import { applyTheme } from '../../../src/renderer/src/editor/themes'
import { setLocale, useLocale } from '../../../src/renderer/src/lib/i18n'
import { registerCommand } from '../../../src/renderer/src/services/commands'
import { getAgent, initAgent, openSession, previewChangeSet, setMode } from '../../../src/renderer/src/services/agent'
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
  toggleRequirement,
  useCodeMap
} from '../../../src/renderer/src/services/codeMap'
import { closeTab, getActiveTab, saveActive, saveAll } from '../../../src/renderer/src/services/documents'
import { refreshGit } from '../../../src/renderer/src/services/git'
import { registerLanguageFeatures } from '../../../src/renderer/src/services/lsp'
import { goToLastEdit, navigateHistory } from '../../../src/renderer/src/services/navigation'
import { useSearch } from '../../../src/renderer/src/services/search'
import { handleFsChanges } from '../../../src/renderer/src/services/workspace'
import { getState, setState, useStore } from '../../../src/renderer/src/state/store'
import { isInside, relativePath } from '../../../src/shared/paths'
import { prefixOf } from '../../../src/shared/codemap/codemap.mjs'
import type { AgentChangeSet, AgentMode } from '@shared/agent'
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
import { AiSettingsDrawer } from './AiSettingsDrawer'
import { ColdStartGuide } from './ColdStartGuide'
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
  initAgent()
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
    const key = `${root}${rel}`
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


interface AskSelectionPayload {
  path: string
  startLine: number
  endLine: number
  mode?: AgentMode
}

interface ExternalFocusPayload {
  map: string | null
  nodes: string[]
  flow?: string | null
  note?: string
}

interface ExternalProposalPayload {
  sessionId: string
  changeSetId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function hostPayload(event: MessageEvent): { channel: string; payload: unknown } | null {
  const data = event.data
  if (!isRecord(data) || data.type !== 'event' || typeof data.channel !== 'string') return null
  return { channel: data.channel, payload: data.payload }
}

async function askSelection(payload: AskSelectionPayload): Promise<void> {
  selectMode('codemap')
  await ensureCodeMap()
  const ctx = mapContext()
  const nodeId = nodesForCode(payload.path, payload.startLine)[0]
  if (ctx && nodeId) {
    const map = mapForNode(ctx, nodeId)
    if (map) setNavigation([map], null, nodeId)
  }
  if (getVscodePrefs().surface === 'sidebar') setVscodePrefs({ sidebarDrawerOpen: true })
  document.getElementById('cm-tab-ai')?.click()
  const mode = payload.mode ?? 'ask'
  if (getAgent().mode !== mode) await setMode(mode)
  fillAgentInput(selectionPrefix(payload))
}

function selectionPrefix(payload: AskSelectionPayload): string {
  const root = getState().workspace?.root ?? ''
  const rel = root && isInside(root, payload.path) ? relativePath(root, payload.path) : payload.path
  const end = payload.endLine || payload.startLine
  return `[${rel}:${payload.startLine}-${end}] `
}

function fillAgentInput(prefix: string): void {
  const write = () => {
    const input = document.querySelector<HTMLTextAreaElement>('.ag-input')
    if (!input) return false
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    proto?.set?.call(input, prefix)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
    return true
  }
  if (write()) return
  requestAnimationFrame(() => {
    if (!write()) requestAnimationFrame(write)
  })
}

async function externalFocus(payload: ExternalFocusPayload): Promise<void> {
  selectMode('codemap')
  await ensureCodeMap()
  const nodes = payload.nodes.filter((id) => typeof id === 'string')
  const data = getCodeMap()
  if (!data.check) return
  const model = data.check.model
  const target = payload.map && model.members.has(payload.map) ? payload.map : mapOfExternal(nodes[0])
  if (!target || !model.members.has(target)) return
  const index = data.stack.indexOf(target)
  const stack = index >= 0 ? data.stack.slice(0, index + 1) : pathToExternal(target)
  const sameMap = target === data.stack[data.stack.length - 1]
  setNavigation(stack, payload.flow ?? (sameMap ? data.flowId : null), nodes[0] ?? null)
  window.setTimeout(() => paintExternalMarks(nodes, payload.note), 0)
}

function paintExternalMarks(nodes: string[], note?: string): void {
  const lit = new Set(nodes)
  for (const el of document.querySelectorAll<SVGGElement>('g.cm-node')) {
    const id = el.dataset.id ?? ''
    el.classList.toggle('agent', lit.has(id))
    el.querySelector('.cm-agent-note')?.remove()
  }
  if (!note || !nodes[0]) return
  const first = document.querySelector<SVGGElement>(`g.cm-node[data-id="${cssEscape(nodes[0])}"]`)
  const shape = first?.querySelector<SVGGraphicsElement>('.cm-shape')
  if (!first || !shape) return
  const box = shape.getBBox()
  const text = note.length > 80 ? `${note.slice(0, 79)}…` : note
  const width = Math.min(340, Math.max(60, text.length * 12 + 20))
  const x = box.x + box.width / 2
  const y = box.y - 12
  const noteNode = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  noteNode.setAttribute('class', 'cm-agent-note')
  noteNode.innerHTML = `<rect x="${x - width / 2}" y="${y - 22}" width="${width}" height="22" rx="11"/><path d="M${x - 5},${y} L${x},${y + 6} L${x + 5},${y} Z"/><text x="${x}" y="${y - 7}">${escapeXml(text)}</text>`
  first.appendChild(noteNode)
}

function cssEscape(value: string): string {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char)
}

function mapOfExternal(id: string | undefined): string | null {
  if (!id) return null
  const model = getCodeMap().check?.model
  if (!model) return null
  const up = [...(model.containedBy.get(id) ?? [])]
  if (up.length) return up[0]
  for (const [map, members] of model.members) if (members.includes(id)) return map
  return null
}

function pathToExternal(id: string): string[] {
  const model = getCodeMap().check?.model
  if (!model) return [id]
  const out = [id]
  const seen = new Set([id])
  let current = id
  for (;;) {
    const up = [...(model.containedBy.get(current) ?? [])].find((parent) => !seen.has(parent))
    if (!up) break
    out.unshift(up)
    seen.add(up)
    current = up
  }
  return out
}

async function externalProposal(payload: ExternalProposalPayload): Promise<void> {
  if (!payload.sessionId) return
  selectMode('codemap')
  await ensureCodeMap()
  const opened = await openSession(payload.sessionId)
  if (!opened) return
  const sets = getAgent().changeSets
  const chosen = (payload.changeSetId ? sets.find((set) => set.id === payload.changeSetId) : null) ?? latestProposal(sets)
  if (chosen) previewChangeSet(chosen)
  if (getVscodePrefs().surface === 'sidebar') setVscodePrefs({ sidebarDrawerOpen: true })
  document.getElementById('cm-tab-ai')?.click()
}

function latestProposal(sets: AgentChangeSet[]): AgentChangeSet | null {
  const proposed = sets.filter((set) => set.status === 'proposed')
  return proposed.at(-1) ?? sets.at(-1) ?? null
}


export const CodeMapShell: FC<{ root: string; name: string }> & { boot(root: string, name: string): void } = function CodeMapShell({ root, name }) {
  useLocale()
  const panelVisible = useStore((s) => s.panelVisible)
  const explorerMode = useStore((s) => s.explorerMode)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const codeMap = useCodeMap()
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

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = hostPayload(event)
      if (!message) return
      if (message.channel === 'host:openAiSettings') {
        setState({ settingsOpen: true })
        return
      }
      if (message.channel === 'host:askSelection' && isAskSelection(message.payload)) {
        void askSelection(message.payload)
        return
      }
      if (message.channel === 'host:externalFocus' && isExternalFocus(message.payload)) {
        void externalFocus(message.payload)
        return
      }
      if (message.channel === 'host:externalProposal' && isExternalProposal(message.payload)) void externalProposal(message.payload)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const coldStart = explorerMode === 'codemap' && codeMap.status === 'none'

  return (
    <div
      className={`lumen-vscode${surface === 'sidebar' ? ` is-sidebar is-dock-${sidebarSide}` : ''}${sidebarDrawerOpen ? ' is-drawer-open' : ''}`}
      data-sidebar-side={sidebarSide}
    >
      <VscodeTopBar onSelectMode={selectMode} onExpandToPanel={expandToPanel} onCollapseToSidebar={collapseToSidebar} />
      <div className="lumen-vscode-stage">
        {explorerMode === 'map' ? (
          <ProjectMapView />
        ) : coldStart ? (
          <div className="code-map">
            <div className="cm-stage">
              <ColdStartGuide onSelectMode={selectMode} onExpandToPanel={expandToPanel} />
            </div>
          </div>
        ) : (
          <CodeMapView />
        )}
        {explorerMode === 'codemap' && panelVisible ? (
          <div className="lumen-vscode-problems">
            <CodeMapProblemsView />
          </div>
        ) : null}
      </div>
      <AiSettingsDrawer open={settingsOpen} onClose={() => setState({ settingsOpen: false })} />
      <PromptDialog />
      <Toasts />
    </div>
  )
}


function isAskSelection(value: unknown): value is AskSelectionPayload {
  if (!isRecord(value) || typeof value.path !== 'string') return false
  return typeof value.startLine === 'number' && typeof value.endLine === 'number'
}

function isExternalFocus(value: unknown): value is ExternalFocusPayload {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return false
  return value.map === null || typeof value.map === 'string'
}

function isExternalProposal(value: unknown): value is ExternalProposalPayload {
  return isRecord(value) && typeof value.sessionId === 'string'
}

CodeMapShell.boot = boot
