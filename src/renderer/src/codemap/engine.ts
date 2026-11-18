import { fnOf, roleOf, type ChangeMark, type CodemapData } from '@shared/codemap/codemap.mjs'
import { BACK_LANE, edgeGeometry, edgePorts, fitText, loopFrameRect, portGeometry, type Box, type Layout, type Side } from './layout'
import { shown, summaryOf, type BallKind, type FlowStep, type MapView, type ViewEdge, type ViewLoop } from './model'

// Draws one code map into an <svg>: nodes, edges, flowing balls, heartbeats, and the
// played flow. Pan with drag, zoom with the wheel; zooming far into an openable node enters
// it and zooming far out leaves. All state about *what* to show lives in the code map service.

export interface HeartbeatTrack {
  key: string
  reverse: boolean
  name: string
  period: string | null
  sample: string | null
  from: string
  to: string
  edge: ViewEdge | null
}

export interface EngineHost {
  node(id: string): void
  edge(key: string): void
  heartbeat(track: HeartbeatTrack): void
  ball(): void
  background(): void
  enter(id: string): void
  /** Double-click: open the node's own map (sideways for neighbours, in for members). */
  open(id: string): void
  exit(): void
  zoom(k: number): void
  /** Nodes were dragged to new places (layout coordinates, snapped to the grid); a loop moves as one. */
  moved(positions: Map<string, [number, number]>): void
  /** An edge end was dropped on a side of its node (null: back to automatic). */
  ported(key: string, end: 0 | 1, side: Side | null): void
}

export interface SceneText {
  kinds: Record<string, string>
  req: Record<ChangeMark, string>
  fail: string
  noPath: string
  badPath: string
  heartbeat: string
  codeChanged: string
  goroutine: string
  thread: string
  loop: string
  todos: string
}

export interface Scene {
  view: MapView
  layout: Layout
  isMap(id: string): boolean
  missing(id: string): { path: string } | null
  /** Requirement badge counts on openable nodes (only drawn with the requirement layer on). */
  counts: Map<string, number>
  /** Code-change counts per node (files saved or changed since the map loaded). */
  touched: Map<string, number>
  /** To-dos per node (its own plus those inside it), and the first titles for the tooltip. */
  todos?(id: string): { count: number; titles: string[] }
  focus: string | null
  text: SceneText
}

const ENTER_K = 2.2
const EXIT_K = 0.7
const MIN_K = 0.5
const MAX_K = 3
const FOCUS_K = 3.2
const SEED_K = 0.3
const GESTURE_GAP_MS = 220
const GRID = 10
const SNAP = 6

export const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** One shape per ball kind, shared by the canvas, the legend, and the step list. */
export function ballMarkup(kind: BallKind, r = 6.5, glow = true): string {
  const cls = `cm-ball cm-ball--${kind}${glow ? ' is-glow' : ''}`
  if (kind === 'ack') return `<path class="${cls}" d="M0,${-r - 0.8}L${r + 0.8},0L0,${r + 0.8}L${-r - 0.8},0Z"/>`
  if (kind === 'hb') return `<circle class="cm-ball cm-ball--hb" r="${r - 2.5}"/>`
  return `<circle class="${cls}" r="${r}"/>`
}

interface Ambient {
  key: string
  kind: BallKind
  back: boolean
  infra?: boolean
}

/**
 * How data moves on the map at rest. `focus` (default): lines only hint their direction, and
 * balls run on the lines of the hovered / clicked node or the selected line; `all`: every line
 * runs its balls; `off`: nothing moves (heartbeats have their own switch).
 */
export type FlowMode = 'off' | 'focus' | 'all'

interface ViewTransform {
  k: number
  x: number
  y: number
}

export class CodeMapEngine {
  private scene: Scene | null = null
  private view: ViewTransform = { k: 1, x: 0, y: 0 }
  private paths = new Map<string, { el: SVGPathElement; from: string; to: string }>()
  private nodes = new Map<string, SVGGElement>()
  private ambient: Ambient[] = []
  private ambientEls: SVGGElement[] = []
  private tracks: HeartbeatTrack[] = []
  private trackEls: SVGGElement[] = []
  private loop = 0
  private tweenFrame = 0
  private ballFrame = 0
  private drag: { sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null
  private lastWheel = 0
  private gestureLocked = false
  private lockUntil = 0
  private transitioning = false
  private flowMode: FlowMode = 'focus'
  private heartbeatOn = true
  private frozen = false
  /** Edit session open: nodes and edge ends can be dragged, nothing opens on click. */
  private editing = false
  private selectedEdge: string | null = null
  /** Live positions while editing (same objects as the scene layout). */
  /** The dragged node (`id`), and every node that moves with it (its loop, or just itself). */
  private nodeDrag: {
    id: string
    group: string[]
    dx: number
    dy: number
    sx: number
    sy: number
    ox: number
    oy: number
    start: Map<string, [number, number]>
    moved: boolean
  } | null = null
  /** Loop frames as drawn (recomputed when nodes move). */
  private frames: LoopFrame[] = []
  private clipSeq = 0
  private portDrag: { key: string; end: 0 | 1; side: Side | null } | null = null
  /** Node whose infrastructure lines are highlighted: hovered, else the last clicked one. */
  private linkedPinned: string | null = null
  private linkedHover: string | null = null
  /** Lines of the hovered / clicked node (their balls run in `focus` mode). */
  private linkedKeys = new Set<string>()
  private disposers: Array<() => void> = []

  constructor(
    private readonly svg: SVGSVGElement,
    private readonly host: EngineHost
  ) {
    this.attachInput()
    const onVisibility = () => this.syncLoop()
    document.addEventListener('visibilitychange', onVisibility)
    this.disposers.push(() => document.removeEventListener('visibilitychange', onVisibility))
  }

  get zoom(): number {
    return this.view.k
  }

  get busy(): boolean {
    return this.transitioning
  }

  dispose(): void {
    cancelAnimationFrame(this.loop)
    cancelAnimationFrame(this.tweenFrame)
    cancelAnimationFrame(this.ballFrame)
    for (const dispose of this.disposers) dispose()
    this.svg.replaceChildren()
  }

  // ---------- Rendering ----------

  render(scene: Scene, keepView: boolean): void {
    this.scene = scene
    cancelAnimationFrame(this.ballFrame)
    const { view: V, layout: L, text } = scene
    if (!keepView) this.view = { k: 1, x: 0, y: 0 }
    this.svg.setAttribute('viewBox', `${L.box.x} ${L.box.y} ${L.box.w} ${L.box.h}`)
    const markers = ['', 'On', 'Err', 'Add', 'Del', 'Async']
      .map(
        (name) =>
          `<marker id="cm-arrow${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="cm-arrow cm-arrow--${name || 'base'}" d="M0,0L10,5L0,10z"/></marker>`
      )
      .join('')
    let h = `<defs>${markers}</defs><g class="cm-vp">`
    const reqClass = (status: ChangeMark | null | undefined) => (V.reqOn && status ? ` req-${status}` : '')
    const visible = V.edges.filter(
      (e) => shown(e.status, V.reqOn) && shown(V.status.get(e.from), V.reqOn) && shown(V.status.get(e.to), V.reqOn) && L.pos.has(e.from) && L.pos.has(e.to)
    )
    const both = new Set(visible.map((e) => `${e.from}->${e.to}`))
    const labels: string[] = []
    this.ambient = []
    // Loop frames sit under the lines and nodes.
    this.frames = loopFrames(V.loops, L.pos)
    h += `<g class="cm-loops">${this.frames.map((f) => frameMarkup(f, text.loop)).join('')}</g>`
    for (const e of visible) {
      const a = L.pos.get(e.from)!
      const b = L.pos.get(e.to)!
      const g = this.geometry(e, both.has(`${e.to}->${e.from}`) ? 7 : 0)
      const key = esc(e.key)
      if (e.hb) {
        h += `<path class="cm-hbline" data-key="${key}" d="${g.d}"/><path class="cm-hit" data-key="${key}" d="${g.d}"/>`
        continue
      }
      const err = Boolean(e.data.error || e.data.when === 'fail')
      // Starts a goroutine / thread: the same line in its own colour, one way, not awaited.
      const mode = e.data.mode === 'go' || e.data.mode === 'thread' ? String(e.data.mode) : null
      const infra = Boolean(a.dock || b.dock) && !mode
      // Lines that carry data (`via`) hint their direction with a slow, faint dash at rest.
      const carries = e.io.apis.length > 0
      const cls =
        ['cm-edge', e.kind === 'call' && !mode && 'bi', e.kind === 'return' && 'ret', err && 'err', (a.outside || b.outside) && 'ext', infra && 'infra', carries && 'carries', mode && 'async']
          .filter(Boolean)
          .join(' ') + reqClass(e.status)
      h += `<path class="${cls}" data-key="${key}" d="${g.d}"/>`
      if (carries) h += `<path class="cm-edge-hint${err ? ' err' : ''}${mode ? ' async' : ''}" data-key="${key}" d="${g.d}"/>`
      const tip = mode === 'go' ? text.goroutine : mode === 'thread' ? text.thread : ''
      h += `<path class="cm-hit" data-key="${key}" d="${g.d}">${tip ? `<title>${esc(tip)}</title>` : ''}</path>`
      const when = e.data.when && e.data.when !== 'pass' ? (e.data.when === 'fail' ? text.fail : String(e.data.when)) : ''
      // A loop's back line leaves its node to the left: its condition sits under that run, right-aligned to the node.
      const back = this.frames.some((f) => f.loop.back.has(e.key)) && !edgePorts(e.data)
      if (when && back) labels.push(`<text class="cm-elabel is-back${err ? ' err' : ''}" x="${a.x - a.w / 2 - 6}" y="${a.y + 13}">${esc(when)}</text>`)
      else if (when) labels.push(`<text class="cm-elabel${err ? ' err' : ''}" x="${g.mid[0]}" y="${g.mid[1] - 4}">${esc(when)}</text>`)
      this.ambient.push(...ambientBalls(e, err).map((ball) => ({ ...ball, infra })))
    }
    h += labels.join('')
    h += this.ambient
      .map((ball) => `<g class="cm-amb${ball.infra ? ' infra' : ''}" data-key="${esc(ball.key)}"><circle class="cm-amb-hit" r="10"/>${ballMarkup(ball.kind, 4.2, false)}</g>`)
      .join('')
    for (const id of [...V.members, ...V.outside]) {
      const p = L.pos.get(id)
      if (p && shown(V.status.get(id), V.reqOn)) h += this.nodeMarkup(id, p)
    }
    this.tracks = []
    // Heartbeats ride on the business line whose `via` has a heartbeat link.
    for (const e of visible) {
      if (!e.beats.length) continue
      const beat = e.beats[0]
      this.tracks.push({ key: e.key, reverse: false, name: beat.name, period: beat.period || null, sample: null, from: e.from, to: e.to, edge: e })
    }
    for (const flow of V.bgFlows) {
      for (const s of (flow.steps ?? []) as CodemapData[]) {
        if (!s.from) continue
        const from = V.resolve(s.from)
        const to = V.resolve(s.to)
        if (!from || !to) continue
        const e = V.pair.get(`${from}->${to}`) ?? V.pair.get(`${to}->${from}`)
        if (!e || !L.pos.has(from) || !L.pos.has(to)) continue
        // One heartbeat per line: a heartbeat link on it already runs one.
        if (this.tracks.some((t) => t.key === e.key)) continue
        this.tracks.push({ key: e.key, reverse: e.from !== from, name: flow.name ?? text.heartbeat, period: flow.period ?? null, sample: s.sample ?? null, from, to, edge: null })
      }
    }
    h += this.tracks.map((_, i) => `<g class="cm-hb" data-i="${i}"><circle class="cm-hb-hit" r="9"/>${ballMarkup('hb', 6.5, false)}</g>`).join('')
    h += '<g class="cm-guides"></g><g class="cm-ports"></g><g class="cm-ball-layer" style="display:none"></g></g>'
    this.svg.innerHTML = h

    this.paths.clear()
    for (const el of this.svg.querySelectorAll<SVGPathElement>('path.cm-edge, path.cm-hbline')) {
      const e = V.edges.find((x) => x.key === el.dataset.key)
      if (e) this.paths.set(e.key, { el, from: e.from, to: e.to })
    }
    this.nodes.clear()
    for (const el of this.svg.querySelectorAll<SVGGElement>('g.cm-node')) this.nodes.set(el.dataset.id ?? '', el)
    this.ambientEls = [...this.svg.querySelectorAll<SVGGElement>('g.cm-amb')]
    this.trackEls = [...this.svg.querySelectorAll<SVGGElement>('g.cm-hb')]
    this.applyFlowMode()
    this.svg.classList.toggle('no-hb', !this.heartbeatOn)
    this.svg.classList.toggle('is-editing', this.editing)
    this.both = new Set(visible.map((e) => `${e.from}->${e.to}`))
    this.drawPorts()
    if (this.linkedPinned && !V.memSet.has(this.linkedPinned) && !V.outside.includes(this.linkedPinned)) this.linkedPinned = null
    this.applyLinked()
    this.applyView()
    this.syncLoop()
  }

  private nodeMarkup(id: string, p: Box): string {
    const scene = this.scene!
    const V = scene.view
    const n = V.node(id) ?? { name: id }
    const status = V.status.get(id)
    const { w, h } = p
    const x0 = p.x - w / 2
    const y0 = p.y - h / 2
    const drill = scene.isMap(id)
    const role = roleOf(n)
    const outcome = fnOf(n).outcome
    const miss = scene.missing(id)
    const cls =
      [
        'cm-node',
        p.outside && 'ext',
        miss && 'miss',
        role === 'gate' && 'gate',
        role === 'end' && (outcome === 'error' ? 'end-err' : 'end-ok'),
        n.kind === 'resource' && 'store',
        n.kind === 'sdk' && 'sdk',
        p.dock && 'docked',
        drill && 'drill',
        scene.focus === id && 'focus'
      ]
        .filter(Boolean)
        .join(' ') + (V.reqOn && status ? ` req-${status}` : '')
    // Function type: a listener ripples inside its box, a timer lights up every period.
    const fnType = fnOf(n).type === 'listen' || fnOf(n).type === 'timer' ? String(fnOf(n).type) : null
    const period = fnType === 'timer' ? periodSeconds(fnOf(n).every) : 0
    let g = `<g class="${cls}${fnType ? ` is-${fnType}` : ''}" data-id="${esc(id)}"${period ? ` style="--every:${period}s"` : ''}>`
    const shape =
      role === 'gate'
        ? `<polygon points="${x0 + 14},${y0} ${x0 + w - 14},${y0} ${x0 + w},${p.y} ${x0 + w - 14},${y0 + h} ${x0 + 14},${y0 + h} ${x0},${p.y}"/>`
        : `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="${n.kind === 'resource' ? 14 : 6}"/>`
    g += shape.replace(/^<(\w+)/, '<$1 class="cm-shape"')
    if (fnType === 'listen') {
      // Rings from the centre, clipped to the node's own shape so they never leave it.
      const clip = `cm-clip-${this.clipSeq++}`
      const r = Math.hypot(w, h) / 2
      g +=
        `<clipPath id="${clip}">${shape}</clipPath><g class="cm-ripple" clip-path="url(#${clip})">` +
        [0, 1].map((i) => `<circle cx="${p.x}" cy="${p.y}" r="${r}" style="animation-delay:${i * 1.2}s"/>`).join('') +
        '</g>'
    }
    const sub = miss ? (miss.path ? scene.text.badPath : scene.text.noPath) : (n.brief ?? scene.text.kinds[n.kind] ?? '')
    g += `<text class="cm-name" x="${p.x}" y="${sub ? p.y - 8 : p.y}">${esc(fitText(n.name ?? id, w - 22, 13))}</text>`
    if (sub) g += `<text class="cm-sub" x="${p.x}" y="${p.y + 11}">${esc(fitText(sub, w - 18, 11))}</text>`
    if (drill) g += `<text class="cm-drill" x="${x0 + w - 10}" y="${y0 + 10}">⤢</text>`
    if (V.reqOn && status) g += `<text class="cm-rtag ${status}" x="${x0}" y="${y0 - 7}">${status === 'add' ? '+ ' : status === 'del' ? '− ' : '~ '}${esc(scene.text.req[status])}</text>`
    const count = drill ? (scene.counts.get(id) ?? 0) : 0
    if (V.reqOn && count) g += `<g class="cm-badge"><circle cx="${x0 + w}" cy="${y0}" r="9"/><text x="${x0 + w}" y="${y0 + 1}">${count}</text></g>`
    // To-dos (issues on the node and todo/ notes), counted with everything inside it.
    const todo = scene.todos?.(id)
    if (todo?.count) {
      const tx = x0 + w - (V.reqOn && count ? 22 : 0)
      const tip = `${scene.text.todos}：${todo.count}\n${todo.titles.map((x) => `· ${x}`).join('\n')}`
      g += `<g class="cm-todo-badge"><title>${esc(tip)}</title><rect x="${tx - 12}" y="${y0 - 8}" width="24" height="16" rx="8"/><text x="${tx}" y="${y0 + 3.5}">${todo.count > 99 ? '99+' : todo.count}</text></g>`
    }
    const touched = scene.touched.get(id) ?? 0
    if (touched) g += `<g class="cm-touch"><title>${esc(scene.text.codeChanged)}</title><circle cx="${x0}" cy="${y0}" r="5"/></g>`
    if (drill && !p.outside) {
      const lines = summaryOf(V, id)
      if (lines.length) {
        const ph = lines.length * 14 + 8
        g +=
          `<g class="cm-preview"><rect x="${x0}" y="${y0 + h + 4}" width="${w}" height="${ph}" rx="4"/>` +
          lines.map((s, i) => `<text x="${x0 + 8}" y="${y0 + h + 16 + i * 14}">${i + 1}. ${esc(fitText(s, w - 30, 10))}</text>`).join('') +
          '</g>'
      }
    }
    return `${g}</g>`
  }

  // ---------- State shown on the canvas ----------

  select(key: string | null): void {
    for (const el of this.svg.querySelectorAll('.cm-edge.sel, .cm-amb.sel')) el.classList.remove('sel')
    this.selectedEdge = key
    this.drawPorts()
    this.applyBallState()
    if (!key) return
    this.paths.get(key)?.el.classList.add('sel')
    for (const el of this.ambientEls) if (el.dataset.key === key) el.classList.add('sel')
  }

  /** Marks the played part of a flow: visited nodes, the current node, lit edges. */
  paint(steps: FlowStep[], idx: number): void {
    for (const el of this.nodes.values()) el.classList.remove('current', 'visited')
    for (const { el } of this.paths.values()) el.classList.remove('on')
    steps.forEach((s, i) => {
      if (i > idx || !s.to) return
      this.nodes.get(s.to)?.classList.add(i === idx ? 'current' : 'visited')
      if (s.edge) this.paths.get(s.edge.key)?.el.classList.add('on')
    })
  }

  trace(ids: string[]): void {
    for (const el of this.nodes.values()) el.classList.toggle('trace', ids.includes(el.dataset.id ?? ''))
  }

  /** Nodes the AI assistant is looking at or pointing to; they pulse until cleared. */
  agentMark(ids: string[]): void {
    const set = new Set(ids)
    for (const el of this.nodes.values()) el.classList.toggle('agent', set.has(el.dataset.id ?? ''))
  }

  setFocus(id: string | null): void {
    for (const el of this.nodes.values()) el.classList.toggle('focus', el.dataset.id === id)
    this.linkedPinned = id
    this.applyLinked()
  }

  /** Lights up the infrastructure lines of the hovered (or last clicked) node. */
  private applyLinked(): void {
    const id = this.linkedHover ?? this.linkedPinned
    const keys = new Set<string>()
    for (const { el, from, to } of this.paths.values()) {
      const linked = Boolean(id && (from === id || to === id))
      el.classList.toggle('is-linked', linked)
      if (linked) keys.add(el.dataset.key ?? '')
    }
    for (const el of this.ambientEls) el.classList.toggle('is-linked', keys.has(el.dataset.key ?? ''))
    this.svg.classList.toggle('has-linked', Boolean(id))
    this.linkedKeys = keys
    this.applyBallState()
  }

  /** Shows the balls that run now and hides the rest (see `ballActive`). */
  private applyBallState(): void {
    let any = false
    this.ambient.forEach((ball, i) => {
      const on = this.ballActive(ball)
      any ||= on
      this.ambientEls[i]?.classList.toggle('is-active', on)
    })
    this.svg.classList.toggle('has-active-balls', any)
    this.syncLoop()
  }

  setPlaying(playing: boolean): void {
    this.svg.classList.toggle('playing', playing)
  }

  setFlowMode(mode: FlowMode): void {
    this.flowMode = mode
    this.applyFlowMode()
    this.syncLoop()
  }

  private applyFlowMode(): void {
    for (const mode of ['off', 'focus', 'all'] as const) this.svg.classList.toggle(`flow-${mode}`, this.flowMode === mode)
  }

  /** Whether the balls of `ball` run now: all of them in `all`, only the focused ones in `focus`. */
  private ballActive(ball: Ambient): boolean {
    if (this.flowMode === 'all') return true
    if (this.flowMode === 'off') return false
    if (this.selectedEdge) return ball.key === this.selectedEdge
    // A hovered / clicked node: the outbound balls on its lines; replies only on a selected line.
    return !ball.back && ball.kind !== 'ack' ? this.linkedKeys.has(ball.key) : false
  }

  setHeartbeat(on: boolean): void {
    this.heartbeatOn = on
    this.svg.classList.toggle('no-hb', !on)
    this.syncLoop()
  }

  /** While the editor covers the map nothing animates. */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen
    this.syncLoop()
  }

  setEditing(editing: boolean): void {
    this.editing = editing
    this.svg.classList.toggle('is-editing', editing)
    this.drawPorts()
  }

  // ---------- Editing the layout ----------

  private both = new Set<string>()

  /** Edge path honoring `ports`; plain facing-side curves otherwise. */
  private geometry(e: ViewEdge, offset: number): { d: string; mid: [number, number]; ends: [[number, number], [number, number]] | null } {
    const L = this.scene!.layout
    const a = L.pos.get(e.from)!
    const b = L.pos.get(e.to)!
    const ports = this.portDrag?.key === e.key ? this.overridePorts(e) : edgePorts(e.data)
    // A loop's back line runs down the frame's left side and re-enters the loop head from the left.
    const frame = ports ? null : this.frames.find((f) => f.loop.back.has(e.key))
    if (frame) return backGeometry(a, b, frame, [...frame.loop.back].indexOf(e.key))
    if (ports || L.manual) {
      const g = portGeometry(a, b, ports?.[0] ?? null, ports?.[1] ?? null, offset)
      return g
    }
    return { ...edgeGeometry(a, b, offset), ends: null }
  }

  private overridePorts(e: ViewEdge): [Side | null, Side | null] {
    const current = edgePorts(e.data) ?? [null, null]
    const drag = this.portDrag!
    const next: [Side | null, Side | null] = [current[0], current[1]]
    next[drag.end] = drag.side
    return next
  }

  /** Re-draws the edges touching `id` (or all) after a node moved, without rebuilding the SVG. */
  private refreshEdges(id: string | null): void {
    const V = this.scene?.view
    if (!V) return
    for (const e of V.edges) {
      if (id && e.from !== id && e.to !== id) continue
      const entry = this.paths.get(e.key)
      if (!entry) continue
      const g = this.geometry(e, this.both.has(`${e.to}->${e.from}`) ? 7 : 0)
      entry.el.setAttribute('d', g.d)
      for (const extra of this.svg.querySelectorAll<SVGPathElement>(`path.cm-hit[data-key="${CSS.escape(e.key)}"], path.cm-edge-hint[data-key="${CSS.escape(e.key)}"]`)) {
        extra.setAttribute('d', g.d)
      }
    }
  }

  private moveNodeTo(id: string, x: number, y: number): void {
    const p = this.scene?.layout.pos.get(id)
    const el = this.nodes.get(id)
    if (!p || !el) return
    const dx = x - p.x
    const dy = y - p.y
    p.x = x
    p.y = y
    const prev = el.getAttribute('transform')?.match(/translate\(([-\d.]+),([-\d.]+)\)/)
    const tx = (prev ? Number(prev[1]) : 0) + dx
    const ty = (prev ? Number(prev[2]) : 0) + dy
    el.setAttribute('transform', `translate(${tx},${ty})`)
    this.refreshEdges(id)
    this.drawPorts()
  }

  /** Moves every node of a drag group by the same offset, then redraws its loop frame and lines. */
  private moveGroup(group: string[], start: Map<string, [number, number]>, dx: number, dy: number): void {
    for (const id of group) {
      const [x, y] = start.get(id)!
      this.moveNodeTo(id, x + dx, y + dy)
    }
    if (!this.scene || !this.frames.length) return
    this.frames = loopFrames(this.scene.view.loops, this.scene.layout.pos)
    const layer = this.svg.querySelector('.cm-loops')
    if (layer) layer.innerHTML = this.frames.map((f) => frameMarkup(f, this.scene!.text.loop)).join('')
    this.refreshEdges(null)
  }

  /** The nodes that move together with `id`: its whole loop, or just itself. */
  private groupOf(id: string): string[] {
    return this.scene?.view.loops.find((l) => l.nodes.includes(id))?.nodes ?? [id]
  }

  /** Snap to the grid, and to other nodes' centres when close; returns the alignment guides. */
  private snap(group: string[], x: number, y: number): { x: number; y: number; guides: Array<['x' | 'y', number]> } {
    const guides: Array<['x' | 'y', number]> = []
    let sx = Math.round(x / GRID) * GRID
    let sy = Math.round(y / GRID) * GRID
    for (const [other, p] of this.scene!.layout.pos) {
      if (group.includes(other)) continue
      if (Math.abs(p.x - x) <= SNAP) (sx = p.x), guides.push(['x', p.x])
      if (Math.abs(p.y - y) <= SNAP) (sy = p.y), guides.push(['y', p.y])
    }
    return { x: sx, y: sy, guides }
  }

  private drawGuides(guides: Array<['x' | 'y', number]>): void {
    const layer = this.svg.querySelector('.cm-guides')
    if (!layer || !this.scene) return
    const box = this.scene.layout.box
    layer.innerHTML = guides
      .map(([axis, v]) =>
        axis === 'x'
          ? `<line x1="${v}" y1="${box.y}" x2="${v}" y2="${box.y + box.h}"/>`
          : `<line x1="${box.x}" y1="${v}" x2="${box.x + box.w}" y2="${v}"/>`
      )
      .join('')
  }

  /** Handles on both ends of the selected edge; drag one onto a side of its node. */
  private drawPorts(): void {
    const layer = this.svg.querySelector('.cm-ports')
    if (!layer) return
    const path = this.selectedEdge && this.editing ? this.paths.get(this.selectedEdge)?.el : null
    if (!path) {
      layer.innerHTML = ''
      return
    }
    // The handles sit on the ends of the line as drawn (two-way pairs are offset sideways).
    const len = path.getTotalLength()
    const ends = [path.getPointAtLength(0), path.getPointAtLength(len)]
    // Same size on screen at any zoom or map size: 7px dot, 13px grab area.
    const scale = (layer as SVGGraphicsElement).getScreenCTM()?.a || 1
    layer.innerHTML = ends
      .map(
        ({ x, y }, i) =>
          `<g class="cm-port" data-end="${i}" transform="translate(${x},${y}) scale(${1 / scale})"><circle class="cm-port-hit" r="13"/><circle class="cm-port-dot" r="7"/></g>`
      )
      .join('')
  }

  /** Which side of `box` the point is closest to. */
  private nearestSide(box: Box, x: number, y: number): Side {
    const d: Array<[Side, number]> = [
      ['top', Math.abs(y - (box.y - box.h / 2))],
      ['bottom', Math.abs(y - (box.y + box.h / 2))],
      ['left', Math.abs(x - (box.x - box.w / 2))],
      ['right', Math.abs(x - (box.x + box.w / 2))]
    ]
    return d.sort((a, b) => a[1] - b[1])[0][0]
  }

  centerOn(id: string): void {
    const p = this.scene?.layout.pos.get(id)
    if (!p) return
    const k = Math.max(this.view.k, 1.25)
    this.tween(this.focusView(p, k), 380, null, () => undefined)
  }

  resetView(): void {
    this.tween({ k: 1, x: 0, y: 0 }, 320, null, () => undefined)
  }

  // ---------- Flow ball ----------

  private pointOn(step: FlowStep, p: number): { x: number; y: number } | null {
    const L = this.scene?.layout
    if (!L || !step.from || !step.to) return null
    const g = step.edge ? this.paths.get(step.edge.key) : null
    if (!g) {
      const a = L.pos.get(step.from)
      const b = L.pos.get(step.to)
      if (!a || !b) return null
      return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p }
    }
    const len = g.el.getTotalLength()
    return g.el.getPointAtLength(len * (g.from === step.from ? p : 1 - p))
  }

  private ballLayer(): SVGGElement | null {
    return this.svg.querySelector<SVGGElement>('.cm-ball-layer')
  }

  showBall(step: FlowStep | null, at = 1): void {
    const layer = this.ballLayer()
    if (!layer) return
    if (!step?.from) {
      layer.style.display = 'none'
      return
    }
    layer.innerHTML =
      `<circle class="cm-ball-hit" r="13"/>${ballMarkup(step.kind)}` + `<text class="cm-blabel${step.kind === 'err' ? ' err' : ''}" y="-12">${esc(step.label)}</text>`
    layer.style.display = ''
    this.placeBall(step, at)
  }

  private placeBall(step: FlowStep, p: number): void {
    const point = this.pointOn(step, p)
    if (point) this.ballLayer()?.setAttribute('transform', `translate(${point.x},${point.y})`)
  }

  animateStep(step: FlowStep, done: () => void): void {
    this.showBall(step, 0)
    if (step.edge) this.paths.get(step.edge.key)?.el.classList.add('on')
    const start = performance.now()
    const duration = 800
    cancelAnimationFrame(this.ballFrame)
    const frame = (now: number) => {
      const p = Math.min((now - start) / duration, 1)
      const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2
      this.placeBall(step, eased)
      if (p < 1) this.ballFrame = requestAnimationFrame(frame)
      else done()
    }
    this.ballFrame = requestAnimationFrame(frame)
  }

  // ---------- Level transitions ----------

  private center(): { x: number; y: number } {
    const box = this.scene!.layout.box
    return { x: box.x + box.w / 2, y: box.y + box.h / 2 }
  }

  private focusView(p: Box, k: number): ViewTransform {
    const c = this.center()
    return { k, x: c.x - p.x * k, y: c.y - p.y * k }
  }

  private seedView(): ViewTransform {
    const c = this.center()
    return { k: SEED_K, x: c.x * (1 - SEED_K), y: c.y * (1 - SEED_K) }
  }

  /**
   * Flies into `focusId` (direction in) or pulls back (out), calls `swap` to render the next
   * level, then settles on it. `swap` returns the id to start from on the new level, if any.
   */
  transition(direction: 'in' | 'out', focusId: string | null, swap: () => string | null): void {
    if (this.transitioning || !this.scene) {
      swap()
      return
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      swap()
      this.view = { k: 1, x: 0, y: 0 }
      this.applyView()
      return
    }
    this.transitioning = true
    const from = direction === 'in' && focusId ? this.scene.layout.pos.get(focusId) : null
    this.tween(from ? this.focusView(from, FOCUS_K) : this.seedView(), direction === 'in' ? 380 : 320, 'out', () => {
      const landing = swap()
      const at = direction === 'out' && landing ? this.scene?.layout.pos.get(landing) : null
      this.view = at ? this.focusView(at, FOCUS_K) : this.seedView()
      this.applyView()
      this.tween({ k: 1, x: 0, y: 0 }, 450, 'in', () => {
        this.transitioning = false
        this.lockUntil = performance.now() + 500
      })
    })
  }

  private tween(to: ViewTransform, duration: number, fade: 'in' | 'out' | null, done: () => void): void {
    const from = { ...this.view }
    const start = performance.now()
    const vp = this.svg.querySelector<SVGGElement>('.cm-vp')
    cancelAnimationFrame(this.tweenFrame)
    const frame = (now: number) => {
      const p = Math.min((now - start) / duration, 1)
      const e = 1 - Math.pow(1 - p, 3)
      this.view = { k: from.k * Math.pow(to.k / from.k, e), x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e }
      this.applyView()
      const layer = this.svg.querySelector<SVGGElement>('.cm-vp') ?? vp
      if (layer && fade) layer.style.opacity = String(fade === 'in' ? 0.15 + 0.85 * e : 1 - 0.85 * e)
      if (p < 1) this.tweenFrame = requestAnimationFrame(frame)
      else {
        if (layer) layer.style.opacity = ''
        done()
      }
    }
    this.tweenFrame = requestAnimationFrame(frame)
  }

  private applyView(): void {
    this.svg.querySelector('.cm-vp')?.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`)
    if (this.selectedEdge && this.editing) this.drawPorts()
    this.svg.classList.toggle('zoomed', this.view.k >= 1.4)
    this.host.zoom(this.view.k)
  }

  // ---------- Ambient balls and heartbeats ----------

  private syncLoop(): void {
    const balls = this.flowMode !== 'off' && this.ambient.some((ball) => this.ballActive(ball))
    const wanted = !this.frozen && !document.hidden && (balls || (this.heartbeatOn && this.tracks.length > 0))
    if (wanted && !this.loop) this.loop = requestAnimationFrame((t) => this.tick(t))
    else if (!wanted && this.loop) {
      cancelAnimationFrame(this.loop)
      this.loop = 0
    }
  }

  private tick(t: number): void {
    if (this.heartbeatOn) {
      this.tracks.forEach((track, i) => {
        const el = this.trackEls[i]
        const path = this.paths.get(track.key)?.el
        if (!el || !path) return
        const len = path.getTotalLength()
        let p = (t / periodMs(track.period) + i * 0.23) % 1
        if (track.reverse) p = 1 - p
        const q = path.getPointAtLength(len * p)
        el.setAttribute('transform', `translate(${q.x},${q.y})`)
      })
    }
    if (this.flowMode !== 'off') {
      this.ambient.forEach((ball, i) => {
        const el = this.ambientEls[i]
        const path = this.paths.get(ball.key)?.el
        if (!el || !path || !this.ballActive(ball)) return
        const len = path.getTotalLength()
        // Similar speed on every edge; outbound and return balls half a lap apart.
        const speed = Math.max(1600, len * 9)
        let p = (t / speed + ((i * 0.37) % 1) + (ball.back ? 0.5 : 0)) % 1
        if (ball.back) p = 1 - p
        const q = path.getPointAtLength(len * p)
        el.setAttribute('transform', `translate(${q.x},${q.y})`)
      })
    }
    this.loop = requestAnimationFrame((next) => this.tick(next))
  }

  // ---------- Input ----------

  private listen<K extends keyof SVGElementEventMap>(type: K, handler: (event: SVGElementEventMap[K]) => void, options?: AddEventListenerOptions): void {
    this.svg.addEventListener(type, handler as EventListener, options)
    this.disposers.push(() => this.svg.removeEventListener(type, handler as EventListener, options))
  }

  private toSvg(event: MouseEvent): { x: number; y: number } {
    const point = this.svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const matrix = this.svg.getScreenCTM()
    return matrix ? point.matrixTransform(matrix.inverse()) : { x: 0, y: 0 }
  }

  /** viewBox coordinates → layout coordinates (undoing the pan / zoom of the viewport group). */
  private toWorld(p: { x: number; y: number }): { x: number; y: number } {
    return { x: (p.x - this.view.x) / this.view.k, y: (p.y - this.view.y) / this.view.k }
  }

  private attachInput(): void {
    this.listen(
      'wheel',
      (event) => {
        event.preventDefault()
        if (!this.scene || this.transitioning || this.frozen) return
        const now = performance.now()
        const gap = now - this.lastWheel
        this.lastWheel = now
        if (now < this.lockUntil || (this.gestureLocked && gap < GESTURE_GAP_MS)) return
        this.gestureLocked = false
        const dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
        const rate = event.ctrlKey ? 0.012 : 0.0022
        const p = this.toSvg(event)
        const k = Math.min(MAX_K, Math.max(MIN_K, this.view.k * Math.exp(-dy * rate)))
        this.view.x = p.x - ((p.x - this.view.x) * k) / this.view.k
        this.view.y = p.y - ((p.y - this.view.y) * k) / this.view.k
        this.view.k = k
        this.applyView()
        // Arranging stays on this map: zooming never enters or leaves it.
        if (this.editing) return
        if (dy < 0 && k >= ENTER_K) {
          const id = (event.target as Element | null)?.closest<SVGGElement>('.cm-node')?.dataset.id
          if (id && this.scene.isMap(id) && !this.scene.layout.pos.get(id)?.outside) {
            this.gestureLocked = true
            this.host.enter(id)
          }
        } else if (dy > 0 && k <= EXIT_K) {
          this.gestureLocked = true
          this.host.exit()
        }
      },
      { passive: false }
    )
    this.listen('pointerdown', (event) => {
      if (event.button !== 0) return
      const p = this.toSvg(event)
      const target = event.target as Element
      // Edge end handle: drag it onto a side of its node.
      const port = target.closest<SVGGElement>('.cm-port')
      if (port && this.selectedEdge && this.editing) {
        this.portDrag = { key: this.selectedEdge, end: Number(port.dataset.end) as 0 | 1, side: null }
        this.drag = { sx: p.x, sy: p.y, vx: this.view.x, vy: this.view.y, moved: true }
        event.preventDefault()
        return
      }
      // Node (or a loop frame): while editing, drag to move it; nodes in a loop move together.
      // A click without movement only selects.
      const node = target.closest<SVGGElement>('.cm-node')
      const frameEl = target.closest<SVGGElement>('.cm-loop-frame')
      const id = node?.dataset.id ?? (frameEl ? this.scene?.view.loops.find((l) => l.id === frameEl.dataset.loop)?.nodes[0] : undefined)
      const box = id ? this.scene?.layout.pos.get(id) : null
      if (id && box && this.editing && !this.transitioning) {
        const w = this.toWorld(p)
        const group = this.groupOf(id)
        const start = new Map(group.map((g) => [g, [this.scene!.layout.pos.get(g)!.x, this.scene!.layout.pos.get(g)!.y] as [number, number]]))
        this.nodeDrag = { id, group, dx: w.x - box.x, dy: w.y - box.y, sx: p.x, sy: p.y, ox: box.x, oy: box.y, start, moved: false }
        this.drag = null
        return
      }
      this.drag = { sx: p.x, sy: p.y, vx: this.view.x, vy: this.view.y, moved: false }
    })
    const onMove = (event: PointerEvent) => {
      const p = this.toSvg(event)
      if (this.portDrag && this.scene) {
        const e = this.scene.view.edges.find((x) => x.key === this.portDrag!.key)
        const box = e ? this.scene.layout.pos.get(this.portDrag.end === 0 ? e.from : e.to) : null
        if (!e || !box) return
        const w = this.toWorld(p)
        const side = this.nearestSide(box, w.x, w.y)
        if (side !== this.portDrag.side) {
          this.portDrag.side = side
          this.refreshEdges(null)
          this.drawPorts()
        }
        return
      }
      const nd = this.nodeDrag
      if (nd) {
        if (!nd.moved && Math.abs(p.x - nd.sx) + Math.abs(p.y - nd.sy) > 4) {
          nd.moved = true
          this.svg.classList.add('dragging-node')
          for (const g of nd.group) this.nodes.get(g)?.classList.add('is-dragging')
        }
        if (!nd.moved) return
        const w = this.toWorld(p)
        if (nd.group.length > 1) {
          // A loop moves by whole grid steps, so it keeps its shape exactly.
          const dx = Math.round((w.x - nd.dx - nd.ox) / GRID) * GRID
          const dy = Math.round((w.y - nd.dy - nd.oy) / GRID) * GRID
          this.moveGroup(nd.group, nd.start, dx, dy)
          return
        }
        const snapped = this.snap(nd.group, w.x - nd.dx, w.y - nd.dy)
        this.moveGroup(nd.group, nd.start, snapped.x - nd.ox, snapped.y - nd.oy)
        this.drawGuides(snapped.guides)
        return
      }
      const drag = this.drag
      if (!drag) return
      const dx = p.x - drag.sx
      const dy = p.y - drag.sy
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
        drag.moved = true
        this.svg.classList.add('dragging')
      }
      if (!drag.moved) return
      this.view.x = drag.vx + dx
      this.view.y = drag.vy + dy
      this.applyView()
    }
    const onUp = () => {
      this.svg.classList.remove('dragging')
      if (this.portDrag) {
        const { key, end, side } = this.portDrag
        this.portDrag = null
        if (side) this.host.ported(key, end, side)
        // Keep the click that follows from deselecting the edge.
        window.setTimeout(() => (this.drag = null), 0)
        return
      }
      const nd = this.nodeDrag
      if (nd) {
        this.nodeDrag = null
        this.svg.classList.remove('dragging-node')
        for (const g of nd.group) this.nodes.get(g)?.classList.remove('is-dragging')
        this.drawGuides([])
        if (nd.moved) {
          // Swallow the click that follows a drag, so the node does not open.
          this.drag = { sx: 0, sy: 0, vx: 0, vy: 0, moved: true }
          window.setTimeout(() => (this.drag = null), 0)
          const p = this.scene?.layout.pos.get(nd.id)
          if (p && (p.x !== nd.ox || p.y !== nd.oy)) {
            const positions = new Map(nd.group.map((g) => [g, [this.scene!.layout.pos.get(g)!.x, this.scene!.layout.pos.get(g)!.y] as [number, number]]))
            this.host.moved(positions)
          }
        }
        return
      }
      // Keep `moved` until the click that follows this pointerup has been ignored.
      window.setTimeout(() => (this.drag = null), 0)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    this.disposers.push(() => window.removeEventListener('pointermove', onMove), () => window.removeEventListener('pointerup', onUp))

    this.listen('click', (event) => {
      if (this.drag?.moved || !this.scene || this.transitioning) return
      const target = event.target as Element
      if (target.closest('.cm-port')) return
      if (target.closest('.cm-ball-layer')) return this.host.ball()
      const hit = target.closest<SVGElement>('.cm-amb, .cm-hit')
      if (hit?.dataset.key) return this.host.edge(hit.dataset.key)
      const hb = target.closest<SVGGElement>('.cm-hb')
      if (hb) {
        const track = this.tracks[Number(hb.dataset.i)]
        if (track) return this.host.heartbeat(track)
      }
      const node = target.closest<SVGGElement>('.cm-node')
      if (node?.dataset.id) {
        this.linkedPinned = node.dataset.id
        this.applyLinked()
        return this.host.node(node.dataset.id)
      }
      this.linkedPinned = null
      this.applyLinked()
      this.host.background()
    })
    this.listen('dblclick', (event) => {
      // Double-click an edge end: back to the automatic side.
      const port = (event.target as Element | null)?.closest<SVGGElement>('.cm-port')
      if (port && this.selectedEdge && this.editing) return this.host.ported(this.selectedEdge, Number(port.dataset.end) as 0 | 1, null)
      // Double-click a node that has its own map: go in (a single click only shows its details).
      const id = (event.target as Element | null)?.closest<SVGGElement>('.cm-node')?.dataset.id
      if (id && !this.editing && !this.transitioning && this.scene?.isMap(id)) this.host.open(id)
    })
    this.listen('pointerover', (event) => {
      const id = (event.target as Element | null)?.closest<SVGGElement>('.cm-node')?.dataset.id ?? null
      if (id === this.linkedHover) return
      this.linkedHover = id
      this.applyLinked()
    })
    this.listen('pointerleave', () => {
      if (!this.linkedHover) return
      this.linkedHover = null
      this.applyLinked()
    })
  }
}

// Balls loop only on edges that say what they carry (`via`): red on error branches, a green
// diamond on returns, and a blue ball out plus a green diamond back on calls.
function ambientBalls(e: ViewEdge, err: boolean): Ambient[] {
  if (!e.io.apis.length) return []
  if (err) return [{ key: e.key, kind: 'err', back: false }]
  if (e.kind === 'return') return [{ key: e.key, kind: 'ack', back: false }]
  const out: Ambient[] = [{ key: e.key, kind: 'data', back: false }]
  // A goroutine / thread is not awaited, so no reply comes back on this line.
  if (e.kind === 'call' && !e.data.mode) out.push({ key: e.key, kind: 'ack', back: true })
  return out
}

function periodMs(period: string | null): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(String(period ?? '').trim())
  if (!match) return 2600
  const value = Number(match[1]) * ({ ms: 1, s: 1000, m: 60000 } as Record<string, number>)[match[2] ?? 's']
  return Math.min(4000, Math.max(1500, value / 2))
}

// ---------- Loops ----------

interface LoopFrame {
  loop: ViewLoop
  x: number
  y: number
  w: number
  h: number
}

export function loopFrames(loops: ViewLoop[], pos: Map<string, Box>): LoopFrame[] {
  return loops.flatMap((loop) => {
    const r = loopFrameRect(loop, pos)
    return r ? [{ loop, ...r }] : []
  })
}

function frameMarkup(f: LoopFrame, label: string): string {
  const lines = f.loop.lines ? ` · ${f.loop.lines[0]}-${f.loop.lines[1]}` : ''
  return (
    `<g class="cm-loop-frame" data-loop="${esc(f.loop.id)}"><rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="12"/>` +
    `<text x="${f.x + 12}" y="${f.y + 16}">⟳ ${esc(label)}${esc(lines)}</text></g>`
  )
}

/** Back line: out of the node's left side, down (or up) the frame's left lane, into the loop head from the left. */
function backGeometry(a: Box, b: Box, frame: LoopFrame, lane: number): { d: string; mid: [number, number]; ends: [[number, number], [number, number]] } {
  const gx = frame.x + 10 + lane * BACK_LANE
  const p0: [number, number] = [a.x - a.w / 2, a.y]
  const p3: [number, number] = [b.x - b.w / 2, b.y]
  const r = Math.min(8, Math.abs(p0[1] - p3[1]) / 2)
  const dir = p3[1] < p0[1] ? -1 : 1
  const d =
    `M${p0[0]},${p0[1]} L${gx + r},${p0[1]} Q${gx},${p0[1]} ${gx},${p0[1] + dir * r} ` +
    `L${gx},${p3[1] - dir * r} Q${gx},${p3[1]} ${gx + r},${p3[1]} L${p3[0]},${p3[1]}`
  return { d, mid: [(p0[0] + gx) / 2, p0[1]], ends: [p0, p3] }
}

/** "5s" → 5; "500ms" → 0.5; "1m" → 60. */
function periodSeconds(period: unknown): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(String(period ?? '').trim())
  if (!m) return 0
  return Number(m[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600 } as Record<string, number>)[m[2] ?? 's']
}

