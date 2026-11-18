import {
  ArrowUp,
  BookOpen,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  FileCode,
  FileText,
  FolderOpen,
  FolderPlus,
  ListTodo,
  HeartPulse,
  KeyRound,
  Layers,
  LayoutGrid,
  LoaderCircle,
  Locate,
  Map as MapIcon,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Scan,
  StepForward,
  TriangleAlert,
  Undo2,
  Workflow,
} from 'lucide-react'
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  apiData,
  asList,
  fnOf,
  heartbeatOf,
  ioOf,
  roleOf,
  sampleEntries,
  type ChangeMark,
  type CodemapData,
  type Issue
} from '@shared/codemap/codemap.mjs'
import { basename } from '@shared/paths'
import type { CodemapSide } from '@shared/types'
import { IconButton } from '../components/IconButton'
import { ballMarkup, CodeMapEngine, type EngineHost, type FlowMode, type HeartbeatTrack, type Scene } from '../codemap/engine'
import { computeLayout } from '../codemap/layout'
import {
  buildView,
  changedCounts,
  containersOf,
  fieldRefs,
  filledFields,
  isMap,
  mapGroups,
  missingRef,
  nodeName,
  refinedFlowIn,
  refiningFlow,
  stepsOf,
  structCard,
  type BallKind,
  type FlowStep,
  type MapContext,
  type MapView,
  requirementReport,
  type ReportChange
} from '../codemap/model'
import { monaco } from '../editor/monaco'
import { languageFor } from '../lib/language'
import { t } from '../lib/i18n'
import {
  allIssues,
  anchorOf,
  chooseLibrary,
  createLibrary,
  clearFocus,
  clearTouched,
  ensureCodeMap,
  linkRepository,
  mapContext,
  openInEditor,
  openIssue,
  openKnowledge,
  readForMap,
  reloadCodeMap,
  requestAccess,
  setFlow,
  setNavigation,
  toggleRequirement,
  saveNodePositions,
  saveEdgePorts,
  edgeFileKey,
  canEditLayout,
  resetLayout,
  undoLayout,
  canUndoLayout,
  editingMap,
  nodeEditBlock,
  nodeFile,
  saveNodeFields,
  type NodeField,
  startLayoutEdit,
  saveLayoutEdit,
  cancelLayoutEdit,
  confirmLeaveLayoutEdit,
  isLayoutDirty,
  isSavingLayout,
  useCodeMap,
  useLibrary,
  openTodo,
  type Anchor,
  type CodeMapData,
  type TodoItem
} from '../services/codeMap'
import { getState, setState, useStore } from '../state/store'
import { EditorArea } from '../workbench/EditorArea'
import { AgentTab } from './AgentTab'
import { getAgent, onAgentLit } from '../services/agent'

type Detail =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; key: string }
  | { kind: 'type'; id: string }
  | { kind: 'api'; id: string }
  | { kind: 'step'; index: number; fromBall: boolean }
  | { kind: 'field'; key: string }
  | { kind: 'heartbeat'; track: HeartbeatTrack }
  | { kind: 'issues' }
  | { kind: 'map' }
  | { kind: 'todos' }
  | null

const KIND_LABELS = (): Record<string, string> => ({
  project: t('Project'),
  component: t('Component'),
  sdk: t('SDK'),
  resource: t('Storage / Middleware'),
  function: t('Function'),
  type: t('Data'),
  api: t('Link')
})
const REQ_LABELS = (): Record<ChangeMark, string> => ({ add: t('Added'), mod: t('Changed'), del: t('Removed') })
const EDGE_KINDS = (): Record<string, string> => ({ next: t('Next step'), call: t('Sync call'), send: t('Async send'), return: t('Return') })
const BALL_LABELS = (): Record<BallKind, string> => ({ data: t('Data'), ack: t('Return'), err: t('Error'), hb: t('Heartbeat') })

function BallIcon({ kind }: { kind: BallKind }) {
  return <svg className="cm-shape-icon" width="12" height="12" viewBox="-8 -8 16 16" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ballMarkup(kind, 5.2, false) }} />
}

export function CodeMapView() {
  const workspace = useStore((s) => s.workspace)
  const editorOpen = useStore((s) => s.mapEditorOpen)
  const hasTabs = useStore((s) => s.tabs.length > 0)
  const data = useCodeMap()

  useEffect(() => {
    void ensureCodeMap()
  }, [workspace?.root])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !getState().mapEditorOpen) return
      if (getState().quickPick || getState().prompt || getState().settingsOpen) return
      const target = event.target as HTMLElement | null
      if (target && target !== document.body && !target.closest('.code-map')) return
      event.preventDefault()
      setState({ mapEditorOpen: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!workspace) return null
  const showEditor = editorOpen && hasTabs
  return (
    <div className={`code-map${showEditor ? ' is-editing' : ''}`}>
      {data.status === 'ready' && data.check && data.stack.length ? <CodeMapStage data={data} frozen={showEditor} /> : <CodeMapEmpty data={data} />}
      <section className="map-editor" aria-label={t('Editor')} aria-hidden={!showEditor} inert={!showEditor}>
        <EditorArea />
        <button type="button" className="map-liftoff" data-tooltip={t('Back to Code Map (Esc)')} aria-label={t('Back to Code Map')} onClick={() => setState({ mapEditorOpen: false })}>
          <Workflow size={14} />
          <span>MAP</span>
        </button>
      </section>
    </div>
  )
}

/**
 * No map to show yet: the start page on the left, and the Codemap panel on the right so a map
 * can be built from here. Building needs a node library; without one, the start page offers to
 * pick or create it (the panel asks for it too when sending).
 */
function CodeMapEmpty({ data }: { data: CodeMapData }) {
  const busy = data.status === 'loading' || data.status === 'idle'
  const hasLibrary = data.status === 'ready' && Boolean(data.library)
  return (
    <div className="cm-stage">
      <div className="cm-body">
        <div className="cm-canvas-wrap">{hasLibrary ? <CodeMapNoMaps data={data} /> : <CodeMapPlaceholder data={data} />}</div>
        <aside className="cm-side" aria-label={t('Codemap')}>
          <div className="cm-tabs" role="tablist">
            <button type="button" role="tab" aria-selected className="cm-tab is-on" id="cm-tab-ai">
              Codemap
            </button>
          </div>
          <div className="cm-panel cm-panel--ai" role="tabpanel">
            {busy ? null : <AgentTab selected={null} onFocusNode={() => undefined} />}
          </div>
        </aside>
      </div>
    </div>
  )
}

function CodeMapNoMaps({ data }: { data: CodeMapData }) {
  return (
    <div className="cm-placeholder">
      <Workflow size={20} />
      <span className="cm-placeholder-title">{t('No maps yet')}</span>
      <span className="cm-placeholder-detail">{t('Build one in the Codemap panel on the right: pick the repositories, then describe the business.')}</span>
      <span className="cm-placeholder-detail mono">{data.library}</span>
      <div className="cm-placeholder-actions">
        <button type="button" className="button" onClick={() => void chooseLibrary()}>
          <FolderOpen size={14} />
          {t('Choose Node Library…')}
        </button>
      </div>
    </div>
  )
}

function CodeMapPlaceholder({ data }: { data: CodeMapData }) {
  if (data.status === 'loading' || data.status === 'idle') {
    return (
      <div className="cm-placeholder" role="status">
        <LoaderCircle size={18} className="spin" />
        <span>{t('Reading the code map')}</span>
      </div>
    )
  }
  if (data.status === 'choose') {
    return (
      <div className="cm-placeholder">
        <Workflow size={20} />
        <span className="cm-placeholder-title">{t('Choose a node library')}</span>
        <div className="cm-candidates">
          {data.candidates.map((path) => (
            <button key={path} type="button" className="cm-candidate" onClick={() => void useLibrary(path)}>
              <FolderOpen size={14} />
              <span className="cm-candidate-name">{basename(path)}</span>
              <span className="cm-candidate-path">{path}</span>
            </button>
          ))}
        </div>
        <div className="cm-placeholder-actions">
          <button type="button" className="button" onClick={() => void chooseLibrary()}>
            {t('Other Folder…')}
          </button>
          <button type="button" className="button" onClick={() => void createLibrary()}>
            <FolderPlus size={14} />
            {t('New Node Library…')}
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="cm-placeholder">
      {data.status === 'error' ? <TriangleAlert size={20} /> : <Workflow size={20} />}
      <span className="cm-placeholder-title">{data.status === 'error' ? t('Cannot load the code map') : t('No node library in this folder')}</span>
      {data.error ? <span className="cm-placeholder-detail">{data.error}</span> : null}
      {data.status !== 'error' ? <span className="cm-placeholder-detail">{t('Create a node library, then build the first map in the Codemap panel on the right.')}</span> : null}
      <div className="cm-placeholder-actions">
        <button type="button" className="button button--primary" onClick={() => void createLibrary()}>
          <FolderPlus size={14} />
          {t('New Node Library…')}
        </button>
        <button type="button" className="button" onClick={() => void chooseLibrary()}>
          <FolderOpen size={14} />
          {t('Choose Node Library…')}
        </button>
        <button type="button" className="button" onClick={() => void reloadCodeMap()}>
          <RefreshCw size={14} />
          {t('Try Again')}
        </button>
      </div>
    </div>
  )
}

// ---------- Stage ----------

interface PlayState {
  idx: number
  playing: boolean
  busy: boolean
}

export type PanelTab = 'detail' | 'flow' | 'req' | 'ai'

function CodeMapStage({ data, frozen }: { data: CodeMapData; frozen: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const engineRef = useRef<CodeMapEngine | null>(null)
  const [zoom, setZoom] = useState(1)
  const [detail, setDetailState] = useState<Detail>(null)
  const [selEdge, setSelEdge] = useState<string | null>(null)
  const [selField, setSelField] = useState<string | null>(null)
  const [play, setPlay] = useState<PlayState>({ idx: -1, playing: false, busy: false })
  const [tab, setTab] = useState<PanelTab>(() => (localStorage.getItem('codemap.tab') as PanelTab) || 'detail')
  // Requirement whose report is open in the Requirements tab (null: the list).
  const [reportIndex, setReportIndex] = useState<number | null>(null)
  const [flowMode, setFlowMode] = useState<FlowMode>(() => {
    const saved = localStorage.getItem('codemap.flowMode')
    return saved === 'off' || saved === 'all' ? saved : 'focus'
  })
  const [heartbeatOn, setHeartbeatOn] = useState(() => localStorage.getItem('codemap.heartbeat') !== '0')
  const [size, setSize] = useState({ width: 0, height: 0 })
  const timer = useRef<number | null>(null)
  const playRef = useRef(play)
  playRef.current = play

  const tabRef = useRef(tab)
  tabRef.current = tab
  const switchTab = useCallback((next: PanelTab) => {
    setTab(next)
    localStorage.setItem('codemap.tab', next)
  }, [])
  // Steps live in the Flow tab (the current one expands in the list); everything else is a detail.
  const setDetail = useCallback(
    (next: Detail) => {
      if (next?.kind === 'step') {
        switchTab('flow')
        return
      }
      setDetailState(next)
      // While talking to the assistant, picking a node only sets the context; the AI tab stays.
      if (next && tabRef.current !== 'ai') switchTab('detail')
    },
    [switchTab]
  )

  const ctx = mapContext(data) as MapContext
  const top = data.stack[data.stack.length - 1] ?? null
  const view = useMemo(() => (top ? buildView(ctx, top) : null), [data.version, top]) // eslint-disable-line react-hooks/exhaustive-deps
  const flowId = view && view.flows.some((f) => f.id === data.flowId) ? data.flowId : (view?.flows[0]?.id ?? null)
  const steps = useMemo(() => (view ? stepsOf(view, flowId) : []), [view, flowId])
  // The saved layout of this map: a change (drag, undo, reset) re-lays out the map. `layoutRev`
  // also forces it after save / cancel, since the engine moves dragged boxes in place.
  const layoutSig = view ? JSON.stringify([data.layoutRev, view.node(view.X)?.layout ?? null, view.edges.map((e) => e.data.ports ?? null)]) : ''
  const layout = useMemo(
    () => (view && size.width ? computeLayout(view, size) : null),
    // Layout depends on the map, the requirement, and the saved layout, not on the flow or the
    // layer toggle. A hand-arranged map ignores the window size (its positions are fixed).
    [view?.X, data.check, data.reqIndex, layoutSig, size.width > 0, ...(view?.node(view.X)?.layout ? [] : [Math.round(size.width / 200), Math.round(size.height / 200)])] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const counts = useMemo(() => changedCounts(ctx), [data.version]) // eslint-disable-line react-hooks/exhaustive-deps
  const issues = useMemo(() => allIssues(data), [data.check, data.yamlErrors]) // eslint-disable-line react-hooks/exhaustive-deps

  // The engine lives as long as the stage.
  const hostRef = useRef<EngineHost | null>(null)
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const engine = new CodeMapEngine(svg, makeHost(() => hostRef.current))
    engineRef.current = engine
    const observer = new ResizeObserver(() => {
      const rect = svg.getBoundingClientRect()
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
    })
    observer.observe(svg)
    return () => {
      observer.disconnect()
      engine.dispose()
      engineRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    if (timer.current) window.clearInterval(timer.current)
    timer.current = null
    setPlay((p) => ({ ...p, playing: false }))
    engineRef.current?.setPlaying(false)
  }, [])

  // Render whenever the map, the layer, or the layout changes.
  const sceneKey = `${data.version}|${layout ? 1 : 0}`
  const lastMap = useRef<string | null>(null)
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !view || !layout) return
    const scene: Scene = {
      view,
      layout,
      isMap: (id) => isMap(ctx, id),
      missing: (id) => missingRef(view, id),
      counts,
      touched: data.touched,
      todos: (id) => {
        const count = data.todos.counts.get(id) ?? 0
        if (!count) return { count: 0, titles: [] }
        // Own to-dos first, then those of nodes inside it (as many as fit in a tooltip).
        const titles: string[] = []
        const walk = (n: string, seen: Set<string>) => {
          if (seen.has(n) || titles.length >= 5) return
          seen.add(n)
          for (const it of data.todos.byNode.get(n) ?? []) if (titles.length < 5) titles.push(it.title.length > 60 ? `${it.title.slice(0, 60)}…` : it.title)
          for (const m of data.check?.model.members.get(n) ?? []) if (!data.check?.model.refs?.get(n)?.has(m)) walk(m, seen)
        }
        walk(id, new Set())
        return { count, titles }
      },
      focus: data.focus,
      text: {
        kinds: KIND_LABELS(),
        req: REQ_LABELS(),
        fail: t('Fail'),
        noPath: t('No path'),
        badPath: t('Path not found'),
        heartbeat: t('Heartbeat'),
        codeChanged: t('Code changed since the map was loaded'),
        goroutine: t('Goroutine'),
        thread: t('Thread'),
        loop: t('Loop'),
        todos: t('To-dos')
      }
    }
    const sameMap = lastMap.current === view.X
    lastMap.current = view.X
    engine.render(scene, sameMap)
    if (!sameMap) {
      stop()
      setPlay({ idx: -1, playing: false, busy: false })
      setSelEdge(null)
      setSelField(null)
      setDetail(data.focus ? { kind: 'node', id: data.focus } : null)
    }
    if (data.focus && layout.pos.has(data.focus)) engine.centerOn(data.focus)
  }, [sceneKey, view, layout]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset playback when the flow changes.
  useEffect(() => {
    stop()
    setPlay({ idx: -1, playing: false, busy: false })
    engineRef.current?.paint([], -1)
    engineRef.current?.showBall(null)
  }, [flowId, view?.X, stop])

  useEffect(() => engineRef.current?.select(selEdge), [selEdge, sceneKey])
  useEffect(() => engineRef.current?.paint(steps, play.idx), [steps, play.idx, sceneKey])
  useEffect(() => engineRef.current?.setFrozen(frozen), [frozen])
  const editable = view ? canEditLayout(view.X) : false
  const editing = Boolean(view && editingMap() === view.X)
  const dirty = editing && isLayoutDirty()
  const saving = editing && isSavingLayout()
  useEffect(() => engineRef.current?.setEditing(editing && !saving), [editing, saving, sceneKey])
  // While arranging, ⌘Z undoes the last move and Esc cancels (the editor keeps its own keys).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (frozen || !view || editingMap() !== view.X) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('.monaco-editor') || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return
      if (event.key === 'Escape' && !isLayoutDirty()) {
        event.preventDefault()
        cancelLayoutEdit()
        return
      }
      if (!(event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'z') || !canUndoLayout(view.X)) return
      event.preventDefault()
      undoLayout(view.X)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [frozen, view])
  useEffect(() => {
    engineRef.current?.setFlowMode(flowMode)
    localStorage.setItem('codemap.flowMode', flowMode)
  }, [flowMode])
  useEffect(() => {
    engineRef.current?.setHeartbeat(heartbeatOn)
    localStorage.setItem('codemap.heartbeat', heartbeatOn ? '1' : '0')
  }, [heartbeatOn])
  useEffect(() => {
    if (!selField || !view) return engineRef.current?.trace([])
    engineRef.current?.trace(view.members.filter((id) => fieldRefs(view, id, 'writes').includes(selField)))
  }, [selField, view])
  useEffect(() => () => stop(), [stop])
  // The assistant lights up the nodes it is looking at; re-applied after every render of the map.
  useEffect(() => {
    engineRef.current?.agentMark(getAgent().lit)
    return onAgentLit((ids) => engineRef.current?.agentMark(ids))
  }, [sceneKey])

  // ---------- Navigation ----------

  const go = useCallback(
    (stack: string[], nextFlow: string | null, direction: 'in' | 'out' | null, focusFrom: string | null, landOn: string | null = null) => {
      // Leaving the map being arranged asks about unsaved changes first.
      if (editingMap() && stack[stack.length - 1] !== editingMap()) {
        void confirmLeaveLayoutEdit().then((ok) => ok && go(stack, nextFlow, direction, focusFrom, landOn))
        return
      }
      stop()
      const engine = engineRef.current
      const swap = () => {
        setNavigation(stack, nextFlow, null)
        return landOn
      }
      if (engine && direction) engine.transition(direction, focusFrom, swap)
      else swap()
    },
    [stop] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const enter = useCallback(
    (id: string) => {
      if (!view || !isMap(ctx, id)) return
      const sub = refiningFlow(ctx, id, flowId ? `${view.X}.${flowId}` : null)
      go([...data.stack, id], sub?.id ?? null, 'in', id)
    },
    [view, ctx, flowId, data.stack, go]
  )

  const goUp = useCallback(
    (container: string) => {
      const child = data.stack[0]
      go([container], refinedFlowIn(ctx, container, child, flowId), 'out', null, child)
    },
    [data.stack, ctx, flowId, go]
  )

  const exit = useCallback(() => {
    if (data.stack.length < 2) {
      const ups = containersOf(ctx, data.stack[0])
      if (ups.length === 1) goUp(ups[0])
      return
    }
    const child = data.stack[data.stack.length - 1]
    const parent = data.stack[data.stack.length - 2]
    go(data.stack.slice(0, -1), refinedFlowIn(ctx, parent, child, flowId), 'out', null, child)
  }, [data.stack, ctx, flowId, go, goUp])

  const openMap = useCallback(
    (id: string) => {
      if (!isMap(ctx, id)) return
      const i = data.stack.indexOf(id)
      go(i >= 0 ? data.stack.slice(0, i + 1) : [id], null, null, null)
    },
    [ctx, data.stack, go]
  )

  /** Single click: select the node and show its details; nothing opens. */
  const onNode = useCallback(
    (id: string) => {
      if (!view) return
      clearFocus()
      stop()
      engineRef.current?.setFocus(id)
      setDetail({ kind: 'node', id })
    },
    [view, stop] // eslint-disable-line react-hooks/exhaustive-deps
  )

  /**
   * Double-click (or the Enter button in the details): go into the node's map. A neighbour on
   * the same level is reached sideways; a neighbour without a map takes you up to where it is.
   */
  const openNode = useCallback(
    (id: string) => {
      if (!view || !layout || editingMap() === view.X || missingRef(view, id)) return
      const p = layout.pos.get(id)
      if (p?.outside) {
        const parent = data.stack[data.stack.length - 2]
        const siblings = parent ? [...(data.check!.model.members.get(parent) ?? []), ...(ctx.check.reqs[ctx.reqIndex]?.model.members.get(parent) ?? [])] : []
        if (parent && siblings.includes(id)) {
          // Crossing sideways to a neighbour on the same level replaces the top of the stack.
          if (isMap(ctx, id)) {
            const parentFlow = refinedFlowIn(ctx, parent, view.X, flowId)
            const sub = refiningFlow(ctx, id, parentFlow ? `${parent}.${parentFlow}` : null)
            return go([...data.stack.slice(0, -1), id], sub?.id ?? null, 'in', null)
          }
          return go(data.stack.slice(0, -1), refinedFlowIn(ctx, parent, view.X, flowId), 'out', null, id)
        }
        if (isMap(ctx, id)) go([...data.stack, id], null, null, null)
        return
      }
      if (isMap(ctx, id)) enter(id)
    },
    [view, layout, data.stack, data.check, ctx, flowId, go, enter]
  )

  // ---------- Playback ----------

  const next = useCallback(() => {
    const engine = engineRef.current
    const state = playRef.current
    if (!engine || state.busy || !steps.length) return
    if (state.idx >= steps.length - 1) {
      stop()
      return
    }
    const step = steps[state.idx + 1]
    setSelEdge(step.edge?.key ?? null)
    if (step.from) {
      setPlay((p) => ({ ...p, busy: true }))
      engine.animateStep(step, () => {
        setPlay((p) => ({ ...p, busy: false, idx: p.idx + 1 }))
        setDetail({ kind: 'step', index: state.idx + 1, fromBall: false })
      })
    } else {
      engine.showBall(null)
      setPlay((p) => ({ ...p, idx: p.idx + 1 }))
      setDetail({ kind: 'step', index: state.idx + 1, fromBall: false })
    }
  }, [steps, stop])
  const nextRef = useRef(next)
  nextRef.current = next

  const togglePlay = useCallback(() => {
    if (timer.current) return stop()
    if (playRef.current.idx >= steps.length - 1) {
      setPlay({ idx: -1, playing: false, busy: false })
      playRef.current = { idx: -1, playing: false, busy: false }
    }
    setPlay((p) => ({ ...p, playing: true }))
    engineRef.current?.setPlaying(true)
    nextRef.current()
    timer.current = window.setInterval(() => nextRef.current(), 1500)
  }, [steps.length, stop])

  const jump = useCallback(
    (index: number) => {
      stop()
      const step = steps[index]
      setPlay({ idx: index, playing: false, busy: false })
      setSelEdge(step?.edge?.key ?? null)
      engineRef.current?.showBall(step ?? null, 1)
      setDetail({ kind: 'step', index, fromBall: false })
    },
    [steps, stop]
  )

  const reset = useCallback(() => {
    stop()
    setPlay({ idx: -1, playing: false, busy: false })
    engineRef.current?.showBall(null)
    setSelEdge(null)
    setDetail(null)
  }, [stop])

  hostRef.current = {
    node: onNode,
    edge: (key) => {
      stop()
      setSelEdge(key)
      setDetail({ kind: 'edge', key })
    },
    heartbeat: (track) => {
      stop()
      if (track.edge) {
        setSelEdge(track.edge.key)
        setDetail({ kind: 'edge', key: track.edge.key })
      } else setDetail({ kind: 'heartbeat', track })
    },
    ball: () => {
      stop()
      const step = steps[playRef.current.idx]
      setSelEdge(step?.edge?.key ?? null)
      setDetail({ kind: 'step', index: playRef.current.idx, fromBall: true })
    },
    // Empty space: the current map itself (its summary in Details; in the Codemap tab it
    // becomes what the conversation is about).
    background: () => {
      clearFocus()
      engineRef.current?.setFocus(null)
      setSelEdge(null)
      setSelField(null)
      setDetailState({ kind: 'map' })
    },
    enter,
    open: openNode,
    exit,
    zoom: setZoom,
    moved: (moves) => {
      if (!view || !layout || editingMap() !== view.X) return
      // The first drag freezes the whole map where it is now. A loop moves as one (one undo step).
      const positions: Record<string, [number, number]> = {}
      const written = view.node(view.X)?.layout as Record<string, unknown> | undefined
      const keyOf = (nodeId: string) => layoutKey(view, nodeId, written)
      if (!layout.manual) for (const [nodeId, p] of layout.pos) positions[keyOf(nodeId)] = [p.x, p.y]
      for (const [nodeId, xy] of moves) positions[keyOf(nodeId)] = xy
      saveNodePositions(view.X, positions)
    },
    ported: (key, end, side) => {
      if (!view || editingMap() !== view.X) return
      const e = view.edges.find((x) => x.key === key)
      if (!e) return
      const current = (Array.isArray(e.data.ports) ? e.data.ports : []) as Array<string | undefined>
      const norm = (s: string | undefined): CodemapSide | null => (s === 'top' || s === 'bottom' || s === 'left' || s === 'right' ? s : null)
      const next: [CodemapSide | null, CodemapSide | null] = [norm(current[0]), norm(current[1])]
      next[end] = side
      saveEdgePorts(view.X, edgeFileKey(e.data), next[0] || next[1] ? next : null)
    }
  }

  if (!view) return null
  const filled = filledFields(view, steps, play.idx)
  const struct = structCard(view, flowId)
  const ups = containersOf(ctx, data.stack[0])
  const canUp = data.stack.length > 1 || ups.length === 1
  const errors = issues.filter((i) => i.level === 'error').length
  const warnings = issues.filter((i) => i.level === 'warn').length
  const mapNode = view.node(view.X)

  const panel: PanelProps = {
    view,
    ctx,
    data,
    steps,
    flowId,
    detail,
    issues,
    selField,
    onSelectField: (key) => {
      stop()
      setSelField((current) => (current === key ? null : key))
      setDetail({ kind: 'field', key })
    },
    onDetail: (next) => {
      stop()
      if (next?.kind === 'node') engineRef.current?.setFocus(next.id)
      setDetail(next)
    },
    onEnter: openNode,
    onOpenMap: openMap,
    filled,
    struct,
    tab,
    onTab: switchTab,
    play,
    onFlow: (id) => setFlow(id),
    onPlay: togglePlay,
    onNext: () => {
      stop()
      next()
    },
    onReset: reset,
    onJump: jump,
    reportIndex,
    onReport: setReportIndex,
    onFocusNode: (id, map) => {
      stop()
      if (map && map !== view.X) {
        go([map], null, null, null)
        window.setTimeout(() => engineRef.current?.setFocus(id), 50)
      } else engineRef.current?.setFocus(id)
      if (id && layout?.pos.has(id)) engineRef.current?.centerOn(id)
    }
  }

  return (
    <div className="cm-stage">
      <header className="cm-toolbar">
        <MapPicker data={data} current={data.stack[0]} onOpen={(id) => go([id], null, null, null)} />
        <nav className="cm-crumbs" aria-label={t('Map path')}>
          {ups.length ? (
            <IconButton
              size="sm"
              label={ups.length === 1 ? t('Up to {name}', { name: nodeName(ctx, ups[0]) }) : t('Up')}
              onClick={(event) => {
                if (ups.length === 1) return goUp(ups[0])
                void window.codemap.app
                  .popupMenu(ups.map((id) => ({ id, label: `${nodeName(ctx, id)} (${id})` })))
                  .then((choice) => choice && goUp(choice))
                event.stopPropagation()
              }}
            >
              <ArrowUp size={14} />
            </IconButton>
          ) : null}
          {data.stack.map((id, i) => {
            const last = i === data.stack.length - 1
            const desc = view.node(id)?.desc ?? data.check!.model.nodes.get(id)?.node.desc
            return (
              <Fragment key={`${id}-${i}`}>
                {i ? <span className="cm-crumb-sep">›</span> : null}
                <button
                  type="button"
                  className={`cm-crumb${last ? ' is-last' : ''}`}
                  data-tooltip={[desc, id].filter(Boolean).join(' · ')}
                  onClick={() => (last ? setDetailState({ kind: 'map' }) : go(data.stack.slice(0, i + 1), null, 'out', null, data.stack[i + 1] ?? null))}
                >
                  {view.node(id)?.name ?? nodeName(ctx, id)}
                </button>
              </Fragment>
            )
          })}
          <span className="cm-level">
            L{data.stack.length - 1} · {KIND_LABELS()[mapNode?.kind] ?? mapNode?.kind ?? ''}
          </span>
        </nav>
        <div className="cm-tools">
          <div className="cm-legend" aria-label={t('Legend')}>
            {(Object.keys(BALL_LABELS()) as BallKind[]).map((kind) => (
              <span key={kind}>
                <BallIcon kind={kind} />
                {BALL_LABELS()[kind]}
              </span>
            ))}
          </div>
          <div className="segmented cm-flowmode" role="radiogroup" aria-label={t('Balls flowing along edges')}>
            {(
              [
                ['off', t('Off'), t('No balls flow')],
                ['focus', t('Focus'), t('Balls flow on the hovered node or the selected line')],
                ['all', t('All'), t('Balls flow on every line')]
              ] as const
            ).map(([mode, label, tip]) => (
              <button key={mode} type="button" role="radio" aria-checked={flowMode === mode} className={flowMode === mode ? 'is-on' : undefined} data-tooltip={tip} onClick={() => setFlowMode(mode)}>
                {label}
              </button>
            ))}
          </div>
          <label className="cm-toggle" data-tooltip={t('Heartbeats')}>
            <input type="checkbox" checked={heartbeatOn} onChange={(event) => setHeartbeatOn(event.target.checked)} />
            <span>{t('Heartbeat')}</span>
          </label>
          <button
            type="button"
            className={`cm-chip ${errors ? 'is-bad' : warnings ? 'is-warn' : 'is-ok'}`}
            onClick={() => {
              stop()
              setDetail({ kind: 'issues' })
            }}
          >
            {errors ? <CircleAlert size={12} /> : warnings ? <TriangleAlert size={12} /> : <CircleCheck size={12} />}
            {errors ? t('{n} errors', { n: errors }) + (warnings ? ` · ${t('{n} warnings', { n: warnings })}` : '') : warnings ? t('{n} warnings', { n: warnings }) : t('Checks passed')}
          </button>
          {data.todos.items.length ? (
            <button
              type="button"
              className="cm-chip is-todo"
              data-tooltip={t('To-dos: issues on nodes and notes in todo/')}
              onClick={() => {
                stop()
                setDetail({ kind: 'todos' })
              }}
            >
              <ListTodo size={12} />
              {t('{n} to-dos', { n: data.todos.items.length })}
            </button>
          ) : null}
          <IconButton size="sm" label={t('Reload Node Library')} onClick={() => void reloadCodeMap()}>
            <RefreshCw size={14} />
          </IconButton>
          <IconButton
            size="sm"
            label={data.library ? t('Node library: {path}', { path: data.library }) : t('Choose Node Library…')}
            onClick={() => void chooseLibrary()}
          >
            <FolderOpen size={14} />
          </IconButton>
        </div>
      </header>
      <div className="cm-body">
        <div className="cm-canvas-wrap">
          <svg ref={svgRef} className="cm-canvas" role="img" aria-label={t('Code map of {name}', { name: mapNode?.name ?? view.X })} />
          <div className="cm-zoomtag">
            {Math.round(zoom * 100)}%
            {zoom >= 1.4 ? ` · ${t('zoom in further to enter')}` : canUp && zoom < 1 ? ` · ${t('zoom out further to go up')}` : ''}
          </div>
          <div className="cm-canvas-actions">
            {data.touched.size ? (
              <IconButton size="sm" label={t('Clear code change marks')} onClick={clearTouched}>
                <Scan size={14} />
              </IconButton>
            ) : null}
            {editing ? (
              <div className="cm-editbar" role="toolbar" aria-label={t('Editing Layout')}>
                <span className="cm-editbar-tag">{saving ? t('Saving…') : dirty ? t('Editing · unsaved') : t('Editing')}</span>
                <IconButton size="sm" label={t('Undo Move (⌘Z)')} disabled={saving || !canUndoLayout(view.X)} onClick={() => undoLayout(view.X)}>
                  <Undo2 size={14} />
                </IconButton>
                <IconButton
                  size="sm"
                  label={t('Reset Layout')}
                  disabled={saving || (!layout?.manual && !view.edges.some((e) => e.data.ports))}
                  onClick={() => resetLayout(view.X)}
                >
                  <LayoutGrid size={14} />
                </IconButton>
                <button type="button" className="button cm-editbar-btn" disabled={saving} onClick={cancelLayoutEdit}>
                  {t('Cancel')}
                </button>
                <button type="button" className="button button--primary cm-editbar-btn" disabled={saving || !dirty} onClick={() => void saveLayoutEdit()}>
                  <Save size={13} />
                  {t('Save')}
                </button>
              </div>
            ) : editable ? (
              <IconButton
                size="sm"
                label={t('Edit Layout')}
                onClick={() => {
                  stop()
                  startLayoutEdit(view.X)
                }}
              >
                <Pencil size={14} />
              </IconButton>
            ) : null}
            <IconButton size="sm" label={t('Fit Map')} onClick={() => engineRef.current?.resetView()}>
              <Locate size={14} />
            </IconButton>
          </div>
          {view.flows.length ? (
            <div className="cm-playpad" aria-label={t('Flow playback')}>
              <IconButton size="sm" label={play.playing ? t('Pause') : t('Play')} tone="accent" onClick={togglePlay}>
                {play.playing ? <Pause size={14} /> : <Play size={14} />}
              </IconButton>
              <IconButton
                size="sm"
                label={t('Next Step')}
                onClick={() => {
                  stop()
                  next()
                }}
              >
                <StepForward size={14} />
              </IconButton>
              <IconButton size="sm" label={t('Reset')} onClick={reset}>
                <RotateCcw size={14} />
              </IconButton>
              <button type="button" className="cm-playpad-progress" data-tooltip={t('Show steps')} onClick={() => switchTab('flow')}>
                {Math.max(0, play.idx + 1)} / {steps.length}
              </button>
            </div>
          ) : null}
        </div>
        <DetailPanel {...panel} />
      </div>
    </div>
  )
}

function makeHost(get: () => EngineHost | null): EngineHost {
  return {
    node: (id) => get()?.node(id),
    edge: (key) => get()?.edge(key),
    heartbeat: (track) => get()?.heartbeat(track),
    ball: () => get()?.ball(),
    background: () => get()?.background(),
    enter: (id) => get()?.enter(id),
    open: (id) => get()?.open(id),
    exit: () => get()?.exit(),
    zoom: (k) => get()?.zoom(k),
    moved: (moves) => get()?.moved(moves),
    ported: (key, end, side) => get()?.ported(key, end, side)
  }
}

/**
 * The key a node gets in the map's `layout`: the one already written for it, else its short id
 * when that resolves back to it from the map (as edges write it), else the global id.
 */
function layoutKey(view: MapView, id: string, written: Record<string, unknown> | undefined): string {
  for (const key of Object.keys(written ?? {})) if ((view.resolve(key) ?? key) === id) return key
  const short = id.slice(id.lastIndexOf('.') + 1)
  return view.resolve(short) === id ? short : id
}

function MapPicker({ data, current, onOpen }: { data: CodeMapData; current: string; onOpen: (id: string) => void }) {
  const check = data.check!
  const { roots, others } = mapGroups(check)
  const label = (id: string) => `${check.model.nodes.get(id)?.node.name ?? id} (${id})`
  return (
    <label className="cm-picker" data-tooltip={t('Open Map')}>
      <Layers size={14} />
      <select className="cm-select" value={current} onChange={(event) => onOpen(event.target.value)} aria-label={t('Open Map')}>
        <optgroup label={t('Top level')}>
          {roots.map((id) => (
            <option key={id} value={id}>
              {label(id)}
            </option>
          ))}
        </optgroup>
        {others.length ? (
          <optgroup label={t('All maps')}>
            {others.map((id) => (
              <option key={id} value={id}>
                {label(id)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </label>
  )
}

// ---------- Detail panel ----------

interface PanelProps {
  view: MapView
  ctx: MapContext
  data: CodeMapData
  steps: FlowStep[]
  flowId: string | null
  detail: Detail
  issues: Issue[]
  selField: string | null
  onSelectField(key: string): void
  onDetail(detail: Detail): void
  onEnter(id: string): void
  onOpenMap(id: string): void
  filled: Set<string>
  struct: ReturnType<typeof structCard>
  tab: PanelTab
  onTab(tab: PanelTab): void
  play: PlayState
  onFlow(id: string): void
  onPlay(): void
  onNext(): void
  onReset(): void
  onJump(index: number): void
  reportIndex: number | null
  onReport(index: number | null): void
  /** Selects a node on the map (opening `map` first when it is another map). */
  onFocusNode(id: string | null, map?: string | null): void
}

function DetailPanel(props: PanelProps) {
  const { view, data, detail, struct, filled, selField, onSelectField, tab, onTab, steps, play } = props
  const scrollRef = useRef<HTMLDivElement>(null)
  // One code excerpt open at a time across the whole panel; a new detail closes it.
  const [openCode, setOpenCode] = useState<string | null>(null)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setOpenCode(null)
  }, [detail, tab])
  const mapKb = asList(view.node(view.X)?.kb).filter((k: CodemapData) => k?.url)
  const mapFile = view.modelOf(view.X).nodes.get(view.X)?.file ?? null
  const reqCount = data.check?.reqs.length ?? 0
  const tabs: Array<{ id: PanelTab; label: string; count?: string }> = [
    { id: 'detail', label: t('Details') },
    { id: 'flow', label: t('Flow'), count: view.flows.length ? `${Math.max(0, play.idx + 1)}/${steps.length}` : undefined },
    { id: 'req', label: t('Requirements'), count: reqCount ? String(reqCount) : undefined },
    { id: 'ai', label: 'Codemap' }
  ]
  return (
    <OpenCodeContext.Provider value={{ open: openCode, setOpen: setOpenCode }}>
    <aside className="cm-side" aria-label={t('Details')}>
      <div className="cm-tabs" role="tablist" aria-label={t('Panel')}>
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`cm-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="cm-tabpanel"
            className={`cm-tab${tab === item.id ? ' is-on' : ''}`}
            onClick={() => onTab(item.id)}
          >
            {item.label}
            {item.count ? <span className="cm-tab-count">{item.count}</span> : null}
          </button>
        ))}
      </div>
    <div className={`cm-panel${tab === 'ai' ? ' cm-panel--ai' : ''}`} ref={scrollRef} role="tabpanel" id="cm-tabpanel" aria-labelledby={`cm-tab-${tab}`}>
      {tab === 'flow' ? <FlowTab {...props} /> : null}
      {tab === 'req' ? <RequirementsTab {...props} /> : null}
      {tab === 'ai' ? (
        <AgentTab
          selected={detail?.kind === 'node' ? detail.id : detail?.kind === 'map' ? view.X : null}
          onFocusNode={(id) => {
            const map = props.ctx.check.model.members.has(id) ? id : ([...(props.ctx.check.model.containedBy.get(id) ?? [])][0] ?? null)
            props.onFocusNode(id === map ? null : id, map)
          }}
        />
      ) : null}
      {tab === 'detail' ? (
        <>
      {detail ? (
        <section className="cm-detail">
          <DetailBody {...props} />
        </section>
      ) : (
        <section className="cm-detail cm-detail--map">
          <MapSummary {...props} />
        </section>
      )}
          {struct ? <StructCard struct={struct} filled={filled} selField={selField} onSelectField={onSelectField} /> : null}
      {mapKb.length ? (
        <section className="cm-section">
          <h3>
            {t('Knowledge')} <span>{mapKb.length}</span>
          </h3>
          {mapKb.map((k: CodemapData, i: number) => (
            <KbItem key={i} kb={k} file={mapFile} />
          ))}
        </section>
      ) : null}
        </>
      ) : null}
    </div>
    </aside>
    </OpenCodeContext.Provider>
  )
}

function StructCard({
  struct,
  filled,
  selField,
  onSelectField
}: {
  struct: NonNullable<ReturnType<typeof structCard>>
  filled: Set<string>
  selField: string | null
  onSelectField(key: string): void
}) {
  return (
    <section className="cm-struct">
      <div className="cm-struct-head">
        {struct.name} {'{ }'}
      </div>
      {struct.rows.map((row) => {
        const on = filled.has(row.key)
        return (
          <button
            key={row.key}
            type="button"
            className={`cm-field${on ? ' is-on' : ''}${row.status ? ` req-${row.status}` : ''}${selField === row.key ? ' is-selected' : ''}`}
            data-tooltip={row.desc || undefined}
            onClick={() => onSelectField(row.key)}
          >
            <span className="cm-field-name">{row.name}</span>
            <span className="cm-field-type">{row.type}</span>
            <span className="cm-field-value">{on && row.value !== undefined ? String(row.value) : '—'}</span>
          </button>
        )
      })}
    </section>
  )
}

// ---------- Flow tab ----------

function FlowTab(props: PanelProps) {
  const { view, ctx, steps, flowId, play, onFlow, onPlay, onNext, onReset, onJump, onEnter, struct, filled, selField, onSelectField, data } = props
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('li.is-current')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [play.idx])
  if (!view.flows.length) return <div className="cm-empty">{t('This map has no flows.')}</div>
  const flow = view.flows.find((f) => f.id === flowId)
  const added = (s: FlowStep) => Boolean(view.reqOn && view.R?.marks.steps.has(s.s))
  // Coming from a parent flow: show where this one continues from.
  const parentRef = flow?.refines ? String(flow.refines) : null
  const parentMap = data.stack.length > 1 ? data.stack[data.stack.length - 2] : null
  return (
    <section className="cm-flow">
      <div className="cm-flow-head">
        <select className="cm-select cm-flow-select" value={flowId ?? ''} onChange={(event) => onFlow(event.target.value)} aria-label={t('Flows')}>
          {view.flows.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name ?? f.id}
            </option>
          ))}
        </select>
        <div className="cm-flow-controls">
          <IconButton size="sm" label={play.playing ? t('Pause') : t('Play')} tone="accent" onClick={onPlay}>
            {play.playing ? <Pause size={14} /> : <Play size={14} />}
          </IconButton>
          <IconButton size="sm" label={t('Next Step')} onClick={onNext}>
            <StepForward size={14} />
          </IconButton>
          <IconButton size="sm" label={t('Reset')} onClick={onReset}>
            <RotateCcw size={14} />
          </IconButton>
          <span className="cm-flow-progress">
            {Math.max(0, play.idx + 1)} / {steps.length}
          </span>
        </div>
      </div>
      {flow?.scenario?.desc ? <p className="cm-desc">{flow.scenario.desc}</p> : null}
      {parentRef && parentMap ? (
        <div className="cm-flow-parent">
          <ArrowUp size={12} />
          {t('Continues {flow} in {map}', { flow: parentRef.split('.').pop() ?? parentRef, map: nodeName(ctx, parentMap) })}
        </div>
      ) : null}
      <ol className="cm-steplist" ref={listRef}>
        {steps.map((s, i) => {
          const current = i === play.idx
          const sub = s.to && isMap(ctx, s.to) ? refiningFlow(ctx, s.to, `${view.X}.${flowId}`) : null
          const route = s.from ? `${view.node(s.from)?.name ?? s.from} → ${view.node(s.to)?.name ?? s.to}` : (view.node(s.to)?.name ?? s.to ?? '')
          const data = s.dataType ? (view.node(s.dataType)?.name ?? s.dataType) : s.label
          return (
            <li key={i} className={`cm-step${current ? ' is-current' : i < play.idx ? ' is-past' : ''}${added(s) ? ' is-added' : ''}`}>
              <button type="button" className="cm-step-row" aria-expanded={current} onClick={() => onJump(i)}>
                <span className="cm-step-no">{i + 1}</span>
                <span className="cm-step-icon">{s.from ? <BallIcon kind={s.kind} /> : <span className="cm-step-dot" />}</span>
                <span className="cm-step-main">
                  <span className="cm-step-title">{s.title}</span>
                  <span className="cm-step-route">
                    {route}
                    {data ? <span className="cm-step-data">{data}</span> : null}
                  </span>
                </span>
                {added(s) ? <span className="cm-rq add">{t('Added')}</span> : null}
              </button>
              {sub && s.to ? (
                <button type="button" className="cm-step-sub" onClick={() => onEnter(s.to!)}>
                  <MapIcon size={12} />
                  {t('Enter {name}', { name: view.node(s.to)?.name ?? s.to })} · {sub.name ?? sub.id}
                </button>
              ) : null}
              {current ? (
                <div className="cm-step-detail">
                  <StepDetail {...props} index={i} fromBall={false} compact />
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>
      {struct ? <StructCard struct={struct} filled={filled} selField={selField} onSelectField={onSelectField} /> : null}
    </section>
  )
}

// ---------- Requirements tab ----------

const REQ_STATUS = (): Record<string, string> => ({ designing: t('Designing'), developing: t('Developing'), merged: t('Merged') })

function RequirementsTab(props: PanelProps) {
  const { data, reportIndex, onReport } = props
  const reqs = data.check?.reqs ?? []
  if (reportIndex !== null && reqs[reportIndex]) return <RequirementReportView {...props} index={reportIndex} onBack={() => onReport(null)} />
  return (
    <section className="cm-section">
      {reqs.length ? (
        reqs.map((r, i) => {
          const meta = r.req.requirement ?? {}
          const n = (op: string) => r.changes.filter((c) => c.op === op).length
          const errors = r.issues.filter((x) => x.level === 'error').length
          const on = data.reqOn && data.reqIndex === i
          return (
            <div key={i} className={`cm-req${on ? ' is-on' : ''}`}>
              <button type="button" role="switch" aria-checked={on} className="cm-req-toggle" data-tooltip={t('Show on the map')} onClick={() => toggleRequirement(i)}>
                <span className="cm-req-tick" aria-hidden="true" />
              </button>
              <button type="button" className="cm-req-open" onClick={() => onReport(i)}>
                <span className="cm-req-name">
                  {meta.name ?? r.req.file}
                  {meta.status ? <span className="cm-req-status">{REQ_STATUS()[meta.status] ?? meta.status}</span> : null}
                </span>
                <span className="cm-req-meta">
                  <span className="is-add">+{n('add')}</span>
                  <span className="is-mod">~{n('modify')}</span>
                  <span className="is-del">−{n('remove')}</span>
                  {errors ? <span className="is-del">{t('{n} errors', { n: errors })}</span> : null}
                </span>
              </button>
              <ChevronRight size={14} className="cm-req-chevron" />
            </div>
          )
        })
      ) : (
        <div className="cm-empty">{t('No requirements yet. Change sets under requirements/ show up here.')}</div>
      )}
    </section>
  )
}

const CHANGE_WHAT = (): Record<string, string> => ({
  node: t('node'),
  member: t('node on map'),
  edge: t('edge'),
  flow: t('flow'),
  lane: t('lane'),
  link: t('link'),
  data: t('data'),
  field: t('field'),
  kb: t('knowledge')
})

function RequirementReportView(props: PanelProps & { index: number; onBack(): void }) {
  const { ctx, data, index, onBack, onFocusNode } = props
  const R = data.check!.reqs[index]
  const report = useMemo(() => requirementReport(ctx, index), [data.version, index]) // eslint-disable-line react-hooks/exhaustive-deps
  const meta = R.req.requirement ?? {}
  const on = data.reqOn && data.reqIndex === index
  // Looking at a requirement turns its layer on, so changes are visible on the map.
  useEffect(() => {
    if (!on) toggleRequirement(index)
  }, [index]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!report) return null
  const name = (id: string) => nodeName(ctx, id)
  const focus = (ch: ReportChange) => {
    const target = ch.what === 'node' || ch.what === 'member' ? ch.target : null
    onFocusNode(target, ch.map)
  }
  const ups = report.neighbors.filter((n) => n.side === 'up')
  const downs = report.neighbors.filter((n) => n.side === 'down')
  return (
    <section className="cm-report">
      <button type="button" className="cm-report-back" onClick={onBack}>
        <ArrowUp size={12} className="cm-report-back-icon" />
        {t('All requirements')}
      </button>
      <div className="cm-title">
        {meta.name ?? R.req.file}
        {meta.status ? <span className="cm-req-status">{REQ_STATUS()[meta.status] ?? meta.status}</span> : null}
      </div>
      <div className="cm-muted">{R.req.file}</div>
      {meta.desc ? <p className="cm-desc">{meta.desc}</p> : null}
      <KbList kb={meta.kb} file={R.req.file} />
      <label className="cm-toggle cm-report-layer">
        <input type="checkbox" checked={on} onChange={() => toggleRequirement(index)} />
        <span>{t('Show on the map')}</span>
      </label>

      {report.impact.length ? (
        <>
          <div className="cm-lab">{t('Impact')}</div>
          <div className="cm-pills">
            {report.impact.map((item) => (
              <Pill key={item.id} onClick={() => onFocusNode(null, item.id)}>
                {name(item.id)} · {item.count}
              </Pill>
            ))}
          </div>
        </>
      ) : null}

      {ups.length || downs.length ? (
        <>
          <div className="cm-lab">{t('Upstream and downstream')}</div>
          <div className="cm-neighbors">
            {[...ups, ...downs].map((n) => (
              <button key={`${n.side}-${n.id}`} type="button" className="cm-neighbor" onClick={() => onFocusNode(n.id, n.map)}>
                <span className={`cm-neighbor-side is-${n.side}`}>{n.side === 'up' ? t('Upstream') : t('Downstream')}</span>
                <span className="cm-neighbor-name">{name(n.id)}</span>
                <span className="cm-neighbor-via">
                  {n.side === 'up' ? '→ ' : '← '}
                  {n.via.map(name).join(', ')}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="cm-lab">{t('Changes')}</div>
      {[...report.byMap, ...(report.other.length ? [{ map: null as string | null, changes: report.other }] : [])].map((group) => (
        <div key={group.map ?? '_'} className="cm-change-group">
          <button type="button" className="cm-change-map" disabled={!group.map} onClick={() => group.map && onFocusNode(null, group.map)}>
            <Layers size={12} />
            {group.map ? name(group.map) : t('Other')}
            <span className="cm-tab-count">{group.changes.length}</span>
          </button>
          {group.changes.map((ch) => (
            <ChangeRow key={ch.index} change={ch} name={name} onFocus={() => focus(ch)} />
          ))}
        </div>
      ))}

      {R.issues.length ? (
        <>
          <div className="cm-lab">{t('Check results')}</div>
          {R.issues.map((issue, i) => (
            <button key={i} type="button" className="cm-issue" onClick={() => void openIssue(issue)}>
              <b className={`is-${issue.level}`}>{({ error: t('Error'), warn: t('Warning'), info: t('Info') } as Record<string, string>)[issue.level]}</b>
              <span className="mono">[{issue.rule}]</span> {issue.msg}
            </button>
          ))}
        </>
      ) : null}
    </section>
  )
}

function ChangeRow({ change, name, onFocus }: { change: ReportChange; name(id: string): string; onFocus(): void }) {
  const [open, setOpen] = useState(false)
  const mark = change.op === 'add' ? 'add' : change.op === 'remove' ? 'del' : 'mod'
  const raw = change.raw
  const label =
    raw?.value?.name ?? raw?.value?.id ?? (change.what === 'edge' && raw?.value ? `${raw.value.from} → ${raw.value.to}` : null) ?? raw?.id ?? (change.target ? name(change.target) : '')
  const proposed = raw?.proposed as { file?: string; new?: string; diff?: string } | undefined
  const detail = raw?.set ?? raw?.value ?? raw?.replace
  return (
    <div className={`cm-change${change.problems.length ? ' has-problem' : ''}`}>
      <div className="cm-change-row">
        <button type="button" className="cm-change-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight size={12} className={`cm-codelink-chevron${open ? ' is-open' : ''}`} />
          <span className={`cm-rq ${mark}`}>{REQ_LABELS()[mark]}</span>
          <span className="cm-change-what">{CHANGE_WHAT()[change.what] ?? change.what}</span>
          <span className="cm-change-label">{String(label ?? '')}</span>
        </button>
        <IconButton size="sm" label={t('Show on the map')} onClick={onFocus}>
          <Locate size={12} />
        </IconButton>
      </div>
      {change.problems.map((p, i) => (
        <div key={i} className="cm-change-problem">
          <CircleAlert size={12} />
          {p}
        </div>
      ))}
      {open ? (
        <div className="cm-change-body">
          {detail ? <pre className="cm-pre">{JSON.stringify(detail, null, 2)}</pre> : null}
          {proposed?.new || proposed?.diff ? (
            <>
              <div className="cm-lab">
                {t('Proposed code')}
                {proposed.file ? ` · ${proposed.file}` : ''}
              </div>
              <pre className="cm-pre">
                {String(proposed.diff ?? proposed.new)
                  .replace(/\n$/, '')
                  .split('\n')
                  .map((line, i) => {
                    const trimmed = line.trimStart()
                    const cls = proposed.diff ? (trimmed.startsWith('+') ? 'is-add' : trimmed.startsWith('-') ? 'is-del' : '') : 'is-add'
                    return (
                      <span key={i} className={cls}>
                        {line}
                        {'\n'}
                      </span>
                    )
                  })}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function MapSummary({ view, ctx }: PanelProps) {
  const editing = useEditingNode()
  const n = view.node(view.X)
  if (!n) return null
  if (editing === view.X) return <NodeEditForm view={view} id={view.X} />
  const counts = { nodes: view.members.length, edges: view.edges.length, flows: view.flows.length }
  return (
    <>
      <div className="cm-title cm-title--edit">
        <span className="cm-title-text">{n.name ?? view.X}</span>
        <NodeEditButton id={view.X} reqOn={view.reqOn} />
      </div>
      <div className="cm-muted">
        {KIND_LABELS()[n.kind] ?? n.kind}
        {n.brief ? ` · ${n.brief}` : ''} · {view.X}
      </div>
      {n.desc ? <p className="cm-desc">{n.desc}</p> : null}
      <div className="cm-rows">
        <span>{t('On this map')}</span>
        <span>{t('{nodes} nodes · {edges} edges · {flows} flows', counts)}</span>
        {n.repo ? (
          <>
            <span>{t('Repository')}</span>
            <span className="mono">{typeof n.repo === 'string' ? n.repo : (n.repo.remote ?? '')}</span>
          </>
        ) : null}
        {containersOf(ctx, view.X).length ? (
          <>
            <span>{t('Also in')}</span>
            <span className="cm-pills">
              {containersOf(ctx, view.X).map((id) => (
                <span key={id} className="cm-pill">
                  {nodeName(ctx, id)}
                </span>
              ))}
            </span>
          </>
        ) : null}
      </div>
      <p className="cm-hint">{t('Click a node, an edge, or a ball for details.')}</p>
    </>
  )
}

function DetailBody(props: PanelProps) {
  const { detail } = props
  if (!detail) return null
  switch (detail.kind) {
    case 'map':
      return <MapSummary {...props} />
    case 'node':
      return <NodeDetail {...props} id={detail.id} />
    case 'edge':
      return <EdgeDetail {...props} edgeKey={detail.key} />
    case 'type':
      return <TypeDetail {...props} id={detail.id} />
    case 'api':
      return <ApiDetail {...props} id={detail.id} />
    case 'step':
      return <StepDetail {...props} index={detail.index} fromBall={detail.fromBall} />
    case 'field':
      return <FieldDetail {...props} fieldKey={detail.key} />
    case 'heartbeat':
      return <HeartbeatDetail {...props} track={detail.track} />
    case 'issues':
      return <IssuesDetail {...props} />
    case 'todos':
      return <TodosDetail {...props} />
  }
}

function ReqTag({ status }: { status: ChangeMark | null | undefined }) {
  if (!status) return null
  return <span className={`cm-rq ${status}`}>{REQ_LABELS()[status]}</span>
}

function Pill({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return onClick ? (
    <button type="button" className="cm-pill is-link" onClick={onClick}>
      {children}
    </button>
  ) : (
    <span className="cm-pill">{children}</span>
  )
}

// The node whose text is being edited in the details (one at a time).
let editingNode: string | null = null
const editListeners = new Set<() => void>()
function setEditingNode(id: string | null): void {
  editingNode = id
  for (const l of [...editListeners]) l()
}
function useEditingNode(): string | null {
  const [, bump] = useState(0)
  useEffect(() => {
    const l = () => bump((x) => x + 1)
    editListeners.add(l)
    return () => {
      editListeners.delete(l)
    }
  }, [])
  return editingNode
}

function NodeEditButton({ id, reqOn }: { id: string; reqOn: boolean }) {
  const block = nodeEditBlock(id)
  if (block === 'not-here' || block === 'outside') return null
  const disabled = block === 'layout' || reqOn
  return (
    <IconButton
      size="sm"
      label={block === 'layout' ? t('Finish editing the layout first') : reqOn ? t('Turn off the requirement layer to edit') : t('Edit Node')}
      disabled={disabled}
      onClick={() => setEditingNode(id)}
    >
      <Pencil size={13} />
    </IconButton>
  )
}

const TRIGGERS = ['grpc', 'http', 'tcp', 'mq', 'cron', 'func']

function NodeEditForm({ view, id }: { view: MapView; id: string }) {
  const n = view.node(id) ?? {}
  const f = fnOf(n)
  const isFn = n.kind === 'function'
  const initial: Record<NodeField, string> = {
    name: String(n.name ?? ''),
    brief: String(n.brief ?? ''),
    desc: String(n.desc ?? ''),
    'fn.trigger': String(f.trigger ?? ''),
    'fn.outcome': String(f.outcome ?? '')
  }
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const changed = (Object.keys(initial) as NodeField[]).filter((k) => form[k] !== initial[k])
  const set = (key: NodeField) => (event: { target: { value: string } }) => setForm((x) => ({ ...x, [key]: event.target.value }))
  const save = async () => {
    setSaving(true)
    const fields = Object.fromEntries(changed.map((k) => [k, form[k].trim() ? form[k] : null]))
    const ok = await saveNodeFields(id, fields)
    setSaving(false)
    if (ok) setEditingNode(null)
  }
  const file = nodeFile(id)
  return (
    <form
      className="cm-edit"
      onSubmit={(event) => {
        event.preventDefault()
        if (changed.length && form.name.trim()) void save()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          setEditingNode(null)
        }
      }}
    >
      <div className="cm-title">{t('Edit Node')}</div>
      <div className="cm-muted mono">
        {id}
        {file ? ` · ${file}` : ''}
      </div>
      <label className="cm-edit-field">
        <span>{t('Name')}</span>
        <input className="input" value={form.name} onChange={set('name')} autoFocus required />
      </label>
      <label className="cm-edit-field">
        <span>{t('Brief')}</span>
        <input className="input" value={form.brief} onChange={set('brief')} placeholder={t('Small text under the name')} />
      </label>
      <label className="cm-edit-field">
        <span>{t('Description')}</span>
        <textarea className="input" rows={5} value={form.desc} onChange={set('desc')} />
      </label>
      {isFn && n.fn ? (
        <div className="cm-edit-row">
          <label className="cm-edit-field">
            <span>{t('Trigger')}</span>
            <select className="input" value={form['fn.trigger']} onChange={set('fn.trigger')}>
              <option value="">{t('None')}</option>
              {TRIGGERS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
              {form['fn.trigger'] && !TRIGGERS.includes(form['fn.trigger']) ? <option value={form['fn.trigger']}>{form['fn.trigger']}</option> : null}
            </select>
          </label>
          <label className="cm-edit-field">
            <span>{t('Result')}</span>
            <select className="input" value={form['fn.outcome']} onChange={set('fn.outcome')}>
              <option value="">{t('None')}</option>
              <option value="success">{t('Ends successfully')}</option>
              <option value="error">{t('Ends with an error')}</option>
            </select>
          </label>
        </div>
      ) : null}
      <div className="cm-edit-actions">
        <button type="button" className="button" disabled={saving} onClick={() => setEditingNode(null)}>
          {t('Cancel')}
        </button>
        <button type="submit" className="button button--primary" disabled={saving || !changed.length || !form.name.trim()}>
          <Save size={13} />
          {saving ? t('Saving…') : t('Save')}
        </button>
      </div>
    </form>
  )
}

function NodeDetail(props: PanelProps & { id: string }) {
  const editing = useEditingNode()
  // Another node selected while editing: leave the form.
  useEffect(() => {
    if (editingNode && editingNode !== props.id) setEditingNode(null)
  }, [props.id])
  if (editing === props.id) return <NodeEditForm view={props.view} id={props.id} />
  return <NodeDetailView {...props} />
}

function NodeDetailView({ view, ctx, data, id, onDetail, onEnter, onOpenMap }: PanelProps & { id: string }) {
  const n = view.node(id)
  const miss = missingRef(view, id)
  if (miss) {
    const where = miss.from ? (view.entry(miss.from)?.file ?? miss.from) : ''
    return (
      <>
        <div className="cm-title">{id}</div>
        <div className="cm-muted">{t('The referenced node was not read, so it cannot be opened')}</div>
        <div className="cm-rows">
          <span>{t('Reason')}</span>
          <span>{miss.path ? t('No node {id} under path {path}', { id, path: miss.path }) : t('No path configured')}</span>
          <span>{t('Fix')}</span>
          <span className="mono">
            {where}: contains → {`{ ref: ${id}, path: … }`}
          </span>
        </div>
      </>
    )
  }
  if (!n) return null
  const status = view.reqOn ? view.status.get(id) : null
  const f = fnOf(n)
  const role = roleOf(n)
  const ROLE: Record<string, string> = { entry: t('Entry'), step: t('Step'), gate: t('Check gate'), end: t('End') }
  const io = ioOf(view.modelOf(id), id)
  const ups = containersOf(ctx, id).filter((c) => c !== view.X)
  const typeLink = (type: string) => (
    <Pill key={type} onClick={() => onDetail({ kind: 'type', id: type })}>
      {view.node(type)?.name ?? type}
    </Pill>
  )
  const rows: Array<[string, ReactNode]> = []
  if (role) rows.push([t('Role'), ROLE[role]])
  if (f.trigger) rows.push([t('Trigger'), String(f.trigger)])
  if (f.type === 'listen') rows.push([t('Function type'), t('Listener')])
  if (f.type === 'timer') rows.push([t('Function type'), f.every ? `${t('Timer')} · ${t('Every {period}', { period: String(f.every) })}` : t('Timer')])
  if (f.check) rows.push([t('Checks'), String(f.check)])
  if (f.outcome) rows.push([t('Result'), f.outcome === 'error' ? t('Ends with an error') : t('Ends successfully')])
  if (n.resource) rows.push([t('Type'), String(n.resource)])
  if (f.serves)
    rows.push([
      t('Implements'),
      <span className="cm-pills">
        {asList(f.serves).map((ref: string) => {
          const api = view.resolve(ref) ?? ref
          return (
            <Pill key={api} onClick={() => onDetail({ kind: 'api', id: api })}>
              {view.modelOf(api).nodes.get(api)?.node.name ?? api}
            </Pill>
          )
        })}
      </span>
    ])
  if (io.in.length) rows.push([t('Input'), <span className="cm-pills">{io.in.map(typeLink)}</span>])
  if (io.out) rows.push([t('Output'), <span className="cm-pills">{typeLink(io.out)}</span>])
  for (const [key, label] of [
    ['writes', t('Assigns')],
    ['reads', t('Reads')],
    ['guards', t('Checks fields')]
  ] as const) {
    const list = asList(f[key])
    if (list.length)
      rows.push([
        label,
        <span className="cm-pills">
          {list.map((x: string) => (
            <Pill key={x}>{x}</Pill>
          ))}
        </span>
      ])
  }
  if (n.repo) {
    const r = typeof n.repo === 'string' ? { remote: n.repo } : n.repo
    rows.push([t('Repository'), <span className="mono">{r.remote ?? ''}</span>])
  }
  return (
    <>
      <div className="cm-title cm-title--edit">
        <span className="cm-title-text">
          {n.name ?? id}
          <ReqTag status={status} />
        </span>
        <NodeEditButton id={id} reqOn={view.reqOn} />
      </div>
      <div className="cm-muted">
        {KIND_LABELS()[n.kind] ?? n.kind}
        {n.brief ? ` · ${n.brief}` : ''} · {id}
      </div>
      {n.desc ? <p className="cm-desc">{n.desc}</p> : null}
      {rows.length ? (
        <div className="cm-rows">
          {rows.map(([a, b], i) => (
            <Fragment key={i}>
              <span>{a}</span>
              <span>{b}</span>
            </Fragment>
          ))}
        </div>
      ) : null}
      <CodeBlock view={view} id={id} />
      <TodoList view={view} id={id} data={data} onDetail={onDetail} />
      <KbList kb={n.kb} file={view.modelOf(id).nodes.get(id)?.file ?? null} />
      {ups.length ? (
        <>
          <div className="cm-lab">{t('Also in')}</div>
          <div className="cm-pills">
            {ups.map((up) => (
              <Pill key={up} onClick={() => onOpenMap(up)}>
                {nodeName(ctx, up)}
              </Pill>
            ))}
          </div>
        </>
      ) : null}
      {isMap(ctx, id) ? (
        <div className="cm-go">
          <button type="button" className="button" data-tooltip={t('Or double-click the node')} onClick={() => onEnter(id)}>
            <MapIcon size={14} />
            {t('Enter {name}', { name: n.name ?? id })}
          </button>
        </div>
      ) : null}
    </>
  )
}

function EdgeDetail({ view, edgeKey, onDetail }: PanelProps & { edgeKey: string }) {
  const e = view.edges.find((x) => x.key === edgeKey)
  if (!e) return null
  const d = e.data
  const rows: Array<[string, string]> = [[t('Type'), EDGE_KINDS()[e.kind] ?? e.kind]]
  if (d.when) rows.push([t('Condition'), d.when === 'pass' ? t('Pass') : d.when === 'fail' ? t('Fail') : String(d.when)])
  if (d.mode === 'go' || d.mode === 'thread') rows.push([t('Call mode'), d.mode === 'go' ? t('Goroutine') : t('Thread')])
  if (d.error) rows.push([t('Branch'), t('Error branch')])
  if (d.swallow) rows.push([t('Swallowed error'), String(d.swallow)])
  if (d.name) rows.push([t('Note'), String(d.name)])
  for (const beat of e.beats) rows.push([t('Heartbeat'), `${beat.name} · ${beat.period ? t('Every {period}', { period: beat.period }) : t('Period set by the client')}`])
  return (
    <>
      <div className="cm-title">
        {view.node(e.from)?.name ?? e.from} → {view.node(e.to)?.name ?? e.to}
        <ReqTag status={view.reqOn ? e.status : null} />
      </div>
      <div className="cm-rows">
        {rows.map(([a, b]) => (
          <Fragment key={a}>
            <span>{a}</span>
            <span>{b}</span>
          </Fragment>
        ))}
      </div>
      {e.io.apis.length ? (
        <ApiList key={e.key} view={view} apis={e.io.apis} onDetail={onDetail} />
      ) : (
        <div className="cm-lab">{t('This edge has no via, so it is unknown what it carries')}</div>
      )}
      <KbList kb={d.kb} file={view.modelOf(view.X).nodes.get(view.X)?.file ?? null} />
    </>
  )
}

/** Nodes whose fn.serves points at this link. */
function implementersOf(view: MapView, apiId: string | null): string[] {
  if (!apiId) return []
  return [...view.B.nodes.keys()].filter((id) => asList(fnOf(view.B.nodes.get(id)!.node).serves).some((ref: string) => view.B.resolve(ref, id) === apiId))
}

type ApiItems = ReturnType<typeof apiData>

// A flow step shows only the data it actually carries: when the step names its data, every link
// keeps just that item (links that do not carry it drop out); otherwise all of this direction.
function stepApis(apis: ApiItems[], dataType: string | null): ApiItems[] {
  if (!dataType) return apis
  const carrying = apis.filter((a) => a.items.some((it) => it.type === dataType))
  return (carrying.length ? carrying : apis).map((a) => ({ ...a, items: a.items.filter((it) => it.type === dataType) }))
}

// The link that carries the step's data opens by default; with no data named, the first one.
function stepOpen(apis: ApiItems[], dataType: string | null): number[] {
  const shown = stepApis(apis, dataType)
  return shown.length ? [0] : []
}

/**
 * The links an edge (or a flow step) goes through: one collapsible row per link. Expanding a
 * row shows its data (request / response), who implements it, and its knowledge links, in
 * place. Several rows can be open at once.
 */
function ApiList({
  view,
  apis,
  onDetail,
  focus,
  sample,
  initiallyOpen
}: {
  view: MapView
  apis: ApiItems[]
  onDetail(d: Detail): void
  /** The data this step actually carries: shown first, with the sample values filled in. */
  focus?: string | null
  sample?: string | null
  /** Rows open at first; by default the only link, if there is just one. */
  initiallyOpen?: number[]
}) {
  const [open, setOpen] = useState<Set<number>>(() => new Set(initiallyOpen ?? (apis.length === 1 ? [0] : [])))
  const toggle = (i: number) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  return (
    <div className="cm-apilist">
      {apis.map((a, i) => {
        const api = a.api
        if (!api) return null
        const expanded = open.has(i)
        const implementers = implementersOf(view, a.apiId)
        const items = a.items.filter((item) => item.type)
        const ordered = focus ? [...items.filter((it) => it.type === focus), ...items.filter((it) => it.type !== focus)] : items
        const apiFile = a.apiId ? (view.modelOf(a.apiId).nodes.get(a.apiId)?.file ?? null) : null
        return (
          <div key={`${a.apiId ?? i}`} className={`cm-api${expanded ? ' is-open' : ''}`}>
            <button type="button" className="cm-api-toggle" aria-expanded={expanded} onClick={() => toggle(i)}>
              <span className="cm-api-head">
                {api.protocol ? <span className={`cm-proto ${api.protocol}`}>{api.protocol}</span> : null}
                <span className="cm-api-name">{api.name ?? a.apiId}</span>
                {heartbeatOf(api) !== null ? (
                  <span className="cm-hb-tag" data-tooltip={heartbeatOf(api) ? t('Every {period}', { period: heartbeatOf(api)! }) : t('Period set by the client')}>
                    <HeartPulse size={11} />
                    {heartbeatOf(api) || t('Heartbeat')}
                  </span>
                ) : null}
                {items.length ? <span className="cm-tab-count">{items.length}</span> : null}
                <ChevronRight size={13} className={`cm-api-chevron${expanded ? ' is-open' : ''}`} />
              </span>
              {api.desc ? <span className="cm-api-desc">{api.desc}</span> : null}
            </button>
            {expanded ? (
              <div className="cm-api-body">
                {ordered.length ? (
                  ordered.map((item, j) => {
                    const role = item.dir === 'response' ? t('Response') : t('Request')
                    const other = Boolean(focus && item.type !== focus)
                    return (
                      <DataBlock
                        key={`${item.type}-${j}`}
                        view={view}
                        type={item.type!}
                        role={other ? `${role} · ${t('not sent in this step')}` : role}
                        sample={item.type === focus ? sample : null}
                        dim={other}
                        onDetail={onDetail}
                      />
                    )
                  })
                ) : (
                  <div className="cm-lab">{t('The link has no data')}</div>
                )}
                {implementers.length ? (
                  <div className="cm-api-meta">
                    {t('Implemented by')}{' '}
                    {implementers.map((id, k) => (
                      <Fragment key={id}>
                        {k ? ', ' : ''}
                        <button type="button" className="cm-link" onClick={() => onDetail({ kind: 'node', id })}>
                          {view.node(id)?.name ?? id}
                        </button>
                      </Fragment>
                    ))}
                  </div>
                ) : null}
                <KbList kb={api.kb} file={apiFile} />
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}



function DataBlock({ view, type, role, sample, dim, onDetail }: { view: MapView; type: string; role?: string; sample?: string | null; dim?: boolean; onDetail(d: Detail): void }) {
  const M = view.modelOf(type)
  const entry = M.nodes.get(type)
  const n = entry?.node
  if (!n)
    return (
      <div className="cm-dblock">
        <div className="cm-dhead">
          <b>{type}</b>
          <span className="cm-role">{t('Type not defined')}</span>
        </div>
      </div>
    )
  const R = view.R
  const parsed = sample ? sampleEntries(sample) : null
  const values = new Map((parsed && parsed.type === n.name ? parsed.entries : []).map((e) => [e.key, e.value]))
  const fields: Array<CodemapData & { st?: ChangeMark | null }> = ((n.fields ?? []) as CodemapData[]).map((f) => ({
    ...f,
    st: R && view.reqOn ? (R.marks.fields.get(`${type}.${f.name}`) ?? null) : null
  }))
  if (view.reqOn && R) {
    for (const [key, st] of R.marks.fields) {
      if (st === 'del' && key.startsWith(`${type}.`) && !fields.some((f) => `${type}.${f.name}` === key)) fields.push({ name: key.slice(type.length + 1), st })
    }
  }
  const known = new Set(fields.map((f) => f.name))
  const extra = [...values.keys()].filter((k) => !known.has(k))
  const hasValues = values.size > 0
  const ownerId = entry.how === 'data' && entry.owner && M.nodes.get(entry.owner)?.node.kind === 'api' ? M.nodes.get(entry.owner)!.owner : entry.owner
  const owner = ownerId ? (M.nodes.get(ownerId)?.node.name ?? ownerId) : ''
  const anchor = anchorOf(M, type)
  return (
    <div className={`cm-dblock${dim ? ' is-dim' : ''}`}>
      <div className="cm-dhead">
        <button type="button" className="cm-dname" onClick={() => onDetail({ kind: 'type', id: type })}>
          {n.name}
        </button>
        {role ? <span className="cm-role">{role}</span> : null}
        {owner ? <span className="cm-owner">{owner}</span> : null}
      </div>
      <table className="cm-dt">
        <colgroup>
          <col style={{ width: '30%' }} />
          <col style={{ width: '26%' }} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>{t('Field')}</th>
            <th>{t('Type')}</th>
            <th>{hasValues ? t('Sample') : t('Description')}</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => {
            const v = values.get(f.name)
            return (
              <tr key={f.name} className={f.st ? `req-${f.st}` : undefined}>
                <td className="cm-fname">{f.name}</td>
                <td className="cm-ftype">{f.type ?? ''}</td>
                {hasValues && v !== undefined ? <td className="cm-fvalue">{v}</td> : <td className="cm-fdesc">{f.desc ?? ''}</td>}
              </tr>
            )
          })}
          {extra.map((k) => (
            <tr key={`x-${k}`} className="is-unknown">
              <td className="cm-fname">{k}</td>
              <td>?</td>
              <td>{t('In the sample but not in the type')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {anchor?.file ? (
        <CodeLink anchor={anchor} codeKey={`data:${type}:${role ?? ''}`} variant="foot" />
      ) : null}
    </div>
  )
}

function TypeDetail({ view, id, onDetail }: PanelProps & { id: string }) {
  const M = view.modelOf(id)
  const n = M.nodes.get(id)?.node
  if (!n) return null
  const apis = [...M.nodes.keys()].filter((api) => M.nodes.get(api)!.node.kind === 'api' && apiData(M, api, api).items.some((i) => i.type === id))
  const here = view.edges.filter((e) => e.io.request.includes(id) || e.io.response.includes(id))
  return (
    <>
      <div className="cm-title">
        {n.name}
        <span className="cm-rq">{t('Data')}</span>
      </div>
      <div className="cm-muted">{id}</div>
      {n.desc ? <p className="cm-desc">{n.desc}</p> : null}
      <DataBlock view={view} type={id} onDetail={onDetail} />
      {apis.length ? (
        <>
          <div className="cm-lab">{t('Links that carry it')}</div>
          <div className="cm-pills">
            {apis.map((api) => (
              <Pill key={api} onClick={() => onDetail({ kind: 'api', id: api })}>
                {M.nodes.get(api)?.node.name ?? api}
              </Pill>
            ))}
          </div>
        </>
      ) : null}
      {here.length ? (
        <>
          <div className="cm-lab">{t('Edges on this map that carry it')}</div>
          <div className="cm-pills">
            {here.map((e) => (
              <Pill key={e.key} onClick={() => onDetail({ kind: 'edge', key: e.key })}>
                {view.node(e.from)?.name ?? e.from} → {view.node(e.to)?.name ?? e.to}
              </Pill>
            ))}
          </div>
        </>
      ) : null}
      <KbList kb={n.kb} file={M.nodes.get(id)?.file ?? null} />
    </>
  )
}

function ApiDetail({ view, id, onDetail }: PanelProps & { id: string }) {
  const M = view.modelOf(id)
  const n = M.nodes.get(id)?.node
  if (!n) return null
  const d = apiData(M, id, id)
  return (
    <>
      <div className="cm-title">
        {n.name}
        <span className="cm-rq">{t('Link')}</span>
      </div>
      <div className="cm-muted">{id}</div>
      <ApiList key={id} view={view} apis={[d]} initiallyOpen={[0]} onDetail={onDetail} />
    </>
  )
}

function StepDetail({
  view,
  ctx,
  steps,
  flowId,
  index,
  fromBall,
  onDetail,
  onEnter,
  compact = false
}: PanelProps & { index: number; fromBall: boolean; compact?: boolean }) {
  const s = steps[index]
  if (!s) return null
  const raw = s.s
  const added = Boolean(view.reqOn && view.R?.marks.steps.has(raw))
  const dir = s.back || s.edge?.kind === 'return' ? 'response' : 'request'
  const apis = s.edge?.io.apis.map((a) => ({ ...a, items: a.items.filter((i) => i.dir === dir) })) ?? []
  const sub = s.to && isMap(ctx, s.to) ? refiningFlow(ctx, s.to, `${view.X}.${flowId}`) : null
  const outside = s.to ? !view.memSet.has(s.to) : true
  return (
    <>
      {compact ? null : (
        <div className="cm-title">
          {index + 1}. {s.title}
          {added ? <span className="cm-rq add">{t('Added')}</span> : null}
        </div>
      )}
      {s.from && !compact ? (
        <div className="cm-lab">
          <BallIcon kind={s.kind} />
          {fromBall ? t('Ball') : t('Step')} · {BALL_LABELS()[s.kind]} · {view.node(s.from)?.name ?? s.from} → {view.node(s.to)?.name ?? s.to}
          {s.edge ? ` · ${EDGE_KINDS()[s.edge.kind] ?? s.edge.kind}` : ''}
        </div>
      ) : null}
      {s.from ? (
        s.edge?.io.apis.length ? (
          <>
            <ApiList
              key={`${flowId}-${index}`}
              view={view}
              apis={stepApis(apis, s.dataType)}
              focus={s.dataType}
              sample={raw.sample}
              initiallyOpen={stepOpen(apis, s.dataType)}
              onDetail={onDetail}
            />
            {!s.dataType && s.choices.length > 1 ? <div className="cm-lab">{t('This step does not say which data it carries')}</div> : null}
          </>
        ) : (
          <div className="cm-lab">
            {t('This edge has no via, so it is unknown what it carries')}
            {s.label ? ` · ${s.label}` : ''}
          </div>
        )
      ) : null}
      {raw.sample ? (
        <>
          <div className="cm-lab">{t('Sample payload')}</div>
          <pre className="cm-pre is-payload">{String(raw.sample).replace(/\n$/, '')}</pre>
        </>
      ) : null}
      {s.to && !outside ? <CodeBlock view={view} id={s.to} /> : null}
      {raw.result ? <div className="cm-result">→ {raw.result}</div> : null}
      {sub && s.to && !compact ? (
        <div className="cm-go">
          <button type="button" className="button" onClick={() => onEnter(s.to!)}>
            <MapIcon size={14} />
            {t('Enter {name}', { name: view.node(s.to)?.name ?? s.to })} · {sub.name ?? sub.id}
          </button>
        </div>
      ) : null}
    </>
  )
}

function FieldDetail({ view, fieldKey, onDetail }: PanelProps & { fieldKey: string }) {
  const live = (id: string) => !(view.reqOn && view.status.get(id) === 'del')
  const owners = view.members.filter((id) => live(id) && fieldRefs(view, id, 'writes').includes(fieldKey))
  const readers = view.members.filter((id) => live(id) && fieldRefs(view, id, 'reads').includes(fieldKey))
  const guards = view.members.filter((id) => live(id) && fieldRefs(view, id, 'guards').includes(fieldKey))
  const status = view.reqOn ? view.R?.marks.fields.get(fieldKey) : null
  const list = (ids: string[]) =>
    ids.length ? (
      ids.map((id) => (
        <Pill key={id} onClick={() => onDetail({ kind: 'node', id })}>
          {view.node(id)?.name ?? id}
        </Pill>
      ))
    ) : (
      <span className="cm-muted">{t('None')}</span>
    )
  return (
    <>
      <div className="cm-title">
        {t('Field {name}', { name: fieldKey.slice(fieldKey.lastIndexOf('.') + 1) })}
        <ReqTag status={status} />
      </div>
      <div className="cm-lab">{t('Assigned by (highlighted on the map)')}</div>
      <div className="cm-pills">{list(owners)}</div>
      {readers.length ? (
        <>
          <div className="cm-lab">{t('Read by')}</div>
          <div className="cm-pills">{list(readers)}</div>
        </>
      ) : null}
      {guards.length ? (
        <>
          <div className="cm-lab">{t('Checked by')}</div>
          <div className="cm-pills">{list(guards)}</div>
        </>
      ) : null}
      {owners.map((id) => (
        <CodeBlock key={id} view={view} id={id} />
      ))}
    </>
  )
}

function HeartbeatDetail({ view, track }: PanelProps & { track: HeartbeatTrack }) {
  return (
    <>
      <div className="cm-title">
        {track.name} · {view.node(track.from)?.name ?? track.from} → {view.node(track.to)?.name ?? track.to}
      </div>
      <div className="cm-lab">
        <BallIcon kind="hb" />
        {t('Runs in the background · every {period}', { period: track.period ?? '—' })}
      </div>
      {track.sample ? <pre className="cm-pre is-payload">{track.sample}</pre> : null}
    </>
  )
}

function IssuesDetail({ issues }: PanelProps) {
  const LV: Record<string, string> = { error: t('Error'), warn: t('Warning'), info: t('Info') }
  const [showInfo, setShowInfo] = useState(false)
  const visible = issues.filter((i) => showInfo || i.level !== 'info')
  const infoCount = issues.length - issues.filter((i) => i.level !== 'info').length
  return (
    <>
      <div className="cm-title">{t('Check results')}</div>
      {infoCount ? (
        <label className="cm-toggle">
          <input type="checkbox" checked={showInfo} onChange={(event) => setShowInfo(event.target.checked)} />
          <span>{t('Show {n} hints', { n: infoCount })}</span>
        </label>
      ) : null}
      {visible.length ? (
        visible.map((issue, i) => (
          <button key={i} type="button" className="cm-issue" onClick={() => void openIssue(issue)}>
            <b className={`is-${issue.level}`}>{LV[issue.level]}</b>
            <span className="mono">[{issue.rule}]</span> {issue.where}: {issue.msg}
          </button>
        ))
      ) : (
        <div className="cm-result">{t('Nodes and requirements have no problems')}</div>
      )}
    </>
  )
}

// ---------- Code ----------

const OpenCodeContext = createContext<{ open: string | null; setOpen(key: string | null): void }>({ open: null, setOpen: () => undefined })

const lineSuffix = (lines: [number, number] | null) => (lines ? `:${lines[0]}${lines[1] !== lines[0] ? `-${lines[1]}` : ''}` : '')

/**
 * A code location as one row: click to expand the excerpt in place (only one open at a time),
 * then "Open in Editor" from the excerpt. The arrow on the right jumps to the editor directly.
 */
function CodeLink({ anchor, codeKey, variant = 'row', label }: { anchor: Anchor; codeKey: string; variant?: 'row' | 'foot'; label?: string }) {
  const { open, setOpen } = useContext(OpenCodeContext)
  const expanded = open === codeKey
  return (
    <div className={`cm-codelink cm-codelink--${variant}${expanded ? ' is-open' : ''}`}>
      <div className="cm-codelink-row">
        <button type="button" className="cm-codelink-toggle" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : codeKey)}>
          <ChevronRight size={12} className="cm-codelink-chevron" />
          <FileCode size={12} />
          {label ? <span className="cm-codelink-label">{label}</span> : null}
          <span className="cm-codelink-repo">{anchor.repoName}</span>
          <span className="cm-codelink-file">
            {anchor.display}
            {lineSuffix(anchor.lines)}
          </span>
        </button>
        {anchor.path ? (
          <IconButton size="sm" label={t('Open in Editor')} onClick={() => void openInEditor(anchor.path!, anchor.lines, anchor.repoRoot)}>
            <ExternalLink size={12} />
          </IconButton>
        ) : null}
      </div>
      {expanded ? <SourceView anchor={anchor} /> : null}
    </div>
  )
}

function CodeBlock({ view, id }: { view: MapView; id: string }) {
  const M = view.modelOf(id)
  const anchor = anchorOf(M, id)
  const n = view.node(id)
  const status = view.reqOn ? view.status.get(id) : null
  const proposed = view.reqOn ? view.R?.marks.code.get(id) : null
  return (
    <>
      {anchor ? (
        <>
          <div className="cm-lab">{t('Code')}</div>
          <CodeLink anchor={anchor} codeKey={`node:${id}`} />
          {n?.review?.commit ? (
            <div className="cm-lab">{t('Last reviewed at commit {commit} · shape {shape}', { commit: n.review.commit, shape: n.review.shape ?? '—' })}</div>
          ) : null}
        </>
      ) : null}
      {proposed && status !== 'del' ? (
        <>
          <div className="cm-lab">
            {t('Proposed code')}
            {proposed.file ? ` · ${proposed.file}` : ''}
            <ReqTag status={status} />
          </div>
          <pre className="cm-pre">
            {proposed.diff
              ? String(proposed.diff)
                  .replace(/\n$/, '')
                  .split('\n')
                  .map((line, i) => {
                    const trimmed = line.trimStart()
                    const cls = trimmed.startsWith('+ ') || trimmed === '+' ? 'is-add' : trimmed.startsWith('- ') || trimmed === '-' ? 'is-del' : ''
                    return (
                      <span key={i} className={cls}>
                        {line}
                        {'\n'}
                      </span>
                    )
                  })
              : String(proposed.new ?? '')
                  .replace(/\n$/, '')
                  .split('\n')
                  .map((line, i) => (
                    <span key={i} className="is-add">
                      {line}
                      {'\n'}
                    </span>
                  ))}
          </pre>
        </>
      ) : null}
    </>
  )
}

type SourceState =
  | { kind: 'loading' }
  | { kind: 'ok'; lines: string[]; html: string[] | null }
  | { kind: 'access'; folder: string }
  | { kind: 'missing'; message: string }

function SourceView({ anchor }: { anchor: Anchor }) {
  const [state, setState_] = useState<SourceState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const theme = useStore((s) => s.theme)

  useEffect(() => {
    if (!anchor.path) return
    let cancelled = false
    setState_({ kind: 'loading' })
    void readForMap(anchor.path, anchor.repoRoot).then(async (result) => {
      if (cancelled) return
      if (!result.ok) {
        setState_(result.reason === 'access' ? { kind: 'access', folder: result.folder } : { kind: 'missing', message: result.message })
        return
      }
      const lines = result.text.replace(/\r/g, '').split('\n')
      if (lines.at(-1) === '') lines.pop()
      setState_({ kind: 'ok', lines, html: null })
      // Syntax colors come from Monaco's tokenizer; skip very large files.
      if (lines.length > 4000) return
      try {
        const html = await monaco.editor.colorize(lines.join('\n'), languageFor(anchor.path!), { tabSize: 4 })
        if (!cancelled) setState_({ kind: 'ok', lines, html: html.split('<br/>') })
      } catch {
        /* plain text is fine */
      }
    })
    return () => {
      cancelled = true
    }
  }, [anchor.path, anchor.repoRoot, attempt, theme])

  const scrollToAnchor = useCallback((smooth: boolean) => {
    const body = bodyRef.current
    const row = body?.querySelector<HTMLElement>('[data-anchor]')
    if (!body || !row) return
    body.scrollTo({ top: Math.max(0, row.offsetTop - body.clientHeight / 4), behavior: smooth ? 'smooth' : 'auto' })
  }, [])
  useEffect(() => {
    if (state.kind === 'ok') scrollToAnchor(false)
  }, [state, scrollToAnchor])

  const [a0, b0] = anchor.lines ?? [0, -1]
  const lineLabel = anchor.lines ? (a0 === b0 ? t('line {n}', { n: a0 }) : t('lines {a}–{b}', { a: a0, b: b0 })) : ''
  const header = (
    <div className="cm-src-head">
      <span className="cm-src-repo">{anchor.repoName || '?'}</span>
      <span className="cm-src-file">{anchor.display || t('(no file)')}</span>
      <span>{lineLabel}</span>
      <span className="cm-src-actions">
        {anchor.lines && state.kind === 'ok' ? (
          <IconButton size="sm" label={t('Scroll to the anchored lines')} onClick={() => scrollToAnchor(true)}>
            <Locate size={12} />
          </IconButton>
        ) : null}
        {anchor.path ? (
          <IconButton size="sm" label={t('Open in Editor')} onClick={() => void openInEditor(anchor.path!, anchor.lines, anchor.repoRoot)}>
            <ExternalLink size={12} />
          </IconButton>
        ) : null}
      </span>
    </div>
  )

  if (!anchor.file) return <div className="cm-src">{header}<div className="cm-src-miss">{t('No file')}</div></div>
  if (!anchor.path)
    return (
      <div className="cm-src">
        {header}
        <div className="cm-src-miss">
          {t('Repository not linked: the node has no repo.local')}
          {anchor.remote ? ` (${anchor.remote})` : ''}
          {anchor.remote ? (
            <button type="button" className="button" onClick={() => void linkRepository(anchor.remote!)}>
              <FolderOpen size={13} />
              {t('Choose Local Folder…')}
            </button>
          ) : null}
        </div>
      </div>
    )
  if (state.kind === 'loading') return <div className="cm-src">{header}<div className="cm-src-miss is-muted">{t('Reading…')}</div></div>
  if (state.kind === 'access')
    return (
      <div className="cm-src">
        {header}
        <div className="cm-src-miss">
          <span>{t('{folder} is outside the open folder', { folder: state.folder })}</span>
          <button
            type="button"
            className="button"
            onClick={() => {
              void requestAccess(state.folder).then((granted) => granted && setAttempt((n) => n + 1))
            }}
          >
            <KeyRound size={13} />
            {t('Allow Reading…')}
          </button>
        </div>
      </div>
    )
  if (state.kind === 'missing') return <div className="cm-src">{header}<div className="cm-src-miss">{t('Cannot read {path}', { path: state.message })}</div></div>

  const out = Boolean(anchor.lines && a0 > state.lines.length)
  const b = Math.min(b0, state.lines.length)
  return (
    <div className="cm-src">
      {header}
      {out ? <div className="cm-src-miss">{t('The file has only {n} lines; line {a} is out of range (the code may have changed)', { n: state.lines.length, a: a0 })}</div> : null}
      <div className="cm-src-body" ref={bodyRef}>
        <table>
          <tbody>
            {state.lines.map((text, i) => {
              const ln = i + 1
              const hl = ln >= a0 && ln <= b
              const cls = hl ? `is-hl${ln === a0 ? ' is-first' : ''}${ln === b ? ' is-last' : ''}` : undefined
              return (
                <tr key={ln} className={cls} data-anchor={ln === a0 ? '1' : undefined}>
                  <td className="cm-ln">{ln}</td>
                  {state.html ? <td dangerouslySetInnerHTML={{ __html: state.html[i] ?? '' }} /> : <td>{text}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------- Knowledge base and requirements ----------

// ---------- To-dos ----------

/** One to-do: a todo/ note opens in the editor; an issue shows its code (expandable) or opens the YAML. */
function TodoRow({ item, view, codeKey }: { item: TodoItem; view: MapView | null; codeKey: string }) {
  const anchor = item.kind === 'issue' && item.code && item.node && view ? anchorOf(view.modelOf(item.node), item.node, item.code) : null
  if (anchor) {
    return (
      <div className="cm-todo">
        <div className="cm-todo-text">{item.title}</div>
        <CodeLink anchor={anchor} codeKey={codeKey} />
      </div>
    )
  }
  return (
    <button type="button" className="cm-todo is-link" onClick={() => void openTodo(item)} data-tooltip={item.kind === 'note' ? item.file : t('Open the YAML')}>
      {item.kind === 'note' ? <ListTodo size={13} /> : <TriangleAlert size={13} />}
      <span className="cm-todo-text">{item.title}</span>
      {item.kind === 'note' ? <span className="cm-todo-file">{basename(item.file)}</span> : null}
    </button>
  )
}

/** The node's own to-dos, and how many more are inside it (with a link to the full list). */
function TodoList({ view, id, data, onDetail }: { view: MapView; id: string; data: CodeMapData; onDetail: (d: Detail) => void }) {
  const own = data.todos.byNode.get(id) ?? []
  const total = data.todos.counts.get(id) ?? 0
  const inside = total - own.length
  if (!total) return null
  return (
    <>
      <div className="cm-lab cm-todo-lab">
        <ListTodo size={12} />
        {t('To-dos')}
        <span className="cm-tab-count">{total}</span>
      </div>
      {own.map((it, i) => (
        <TodoRow key={`${it.file}-${i}`} item={it} view={view} codeKey={`todo:${id}:${i}`} />
      ))}
      {inside ? (
        <button type="button" className="cm-todo-more" onClick={() => onDetail({ kind: 'todos' })}>
          {t('{n} more inside', { n: inside })}
        </button>
      ) : null}
    </>
  )
}

/** Every to-do of the library, by component (folders with no node yet included). */
function TodosDetail({ view, data, onDetail }: PanelProps) {
  const groups = useMemo(() => {
    const map = new Map<string, TodoItem[]>()
    for (const it of data.todos.items) {
      const key = it.node ?? `dir:${it.dir}`
      map.set(key, [...(map.get(key) ?? []), it])
    }
    return [...map.entries()].sort(([a], [b]) => Number(a.startsWith('dir:')) - Number(b.startsWith('dir:')) || a.localeCompare(b))
  }, [data.todos])
  const nodeName = (id: string) => data.check?.model.nodes.get(id)?.node.name ?? id
  return (
    <>
      <div className="cm-title">
        {t('To-dos')} <span className="cm-tab-count">{data.todos.items.length}</span>
      </div>
      {groups.length ? (
        groups.map(([key, list]) => (
          <section key={key} className="cm-todo-group">
            <div className="cm-lab">
              {key.startsWith('dir:') ? (
                <span>
                  {key.slice(4) || '/'} <span className="cm-muted">· {t('no node yet')}</span>
                </span>
              ) : (
                <button type="button" className="cm-todo-node" onClick={() => onDetail({ kind: 'node', id: key })}>
                  {nodeName(key)} <span className="cm-muted mono">{key}</span>
                </button>
              )}
            </div>
            {list.map((it, i) => (
              <TodoRow key={`${it.file}-${i}`} item={it} view={view} codeKey={`todos:${key}:${i}`} />
            ))}
          </section>
        ))
      ) : (
        <div className="cm-muted">{t('No to-dos')}</div>
      )}
    </>
  )
}

function KbItem({ kb, file }: { kb: CodemapData; file: string | null }) {
  const web = /^https?:\/\//i.test(kb.url)
  return (
    <button type="button" className="cm-kb" onClick={() => void openKnowledge(kb.url, file)}>
      {web ? <ExternalLink size={13} /> : <FileText size={13} />}
      <span className="cm-kb-title">{kb.title ?? kb.url}</span>
      <span className="cm-kb-url" data-tooltip={kb.url}>
        {web ? kb.url.replace(/^https?:\/\//, '') : kb.url}
      </span>
    </button>
  )
}

function KbList({ kb, file }: { kb: unknown; file: string | null }) {
  const list = asList(kb as CodemapData | CodemapData[] | null).filter((k) => k?.url)
  if (!list.length) return null
  return (
    <>
      <div className="cm-lab">
        <BookOpen size={12} />
        {t('Knowledge')}
      </div>
      {list.map((k, i) => (
        <KbItem key={i} kb={k} file={file} />
      ))}
    </>
  )
}

