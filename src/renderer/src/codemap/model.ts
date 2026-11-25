import {
  asList,
  edgeData,
  fnOf,
  heartbeatOf,
  issueCode,
  ioOf,
  resolveField,
  roleOf,
  stepChoices,
  type ChangeMark,
  type CodemapData,
  type CodemapModel,
  type EdgeData,
  type Issue,
  type LibraryCheck,
  type NodeEntry,
  type RequirementCheck
} from '@shared/codemap/codemap.mjs'

// What one map shows: the base library merged with the selected requirement (so the layout
// stays put when the requirement layer is toggled), plus flow steps resolved onto edges.
// Ported from the frozen ~/dev/ai/codemap-site viewer; pure and DOM-free.

export interface MapContext {
  check: LibraryCheck
  reqIndex: number
  reqOn: boolean
}

export type BallKind = 'data' | 'ack' | 'err' | 'hb'

export interface ViewEdge {
  key: string
  from: string
  to: string
  /** The edge as written in the requirement model / the base model. */
  a?: CodemapData
  b?: CodemapData
  data: CodemapData
  io: EdgeData
  kind: string
  status: 'add' | 'del' | null
  /** Walked only by background flows: drawn thin and dotted. */
  hb: boolean
  /** Heartbeat links in its `via` (links with `heartbeat`): a heartbeat runs on this line. */
  beats: { api: string; name: string; period: string }[]
}

export interface ViewLane {
  id: string
  /** Only for reading the YAML; the map does not show it. */
  name?: string
  nodes: string[]
  /** Where the lane starts: a band above or below the map, or the first or last column. */
  dock?: 'top' | 'bottom' | 'left' | 'right'
}

export interface MapView {
  X: string
  B: CodemapModel
  A: CodemapModel | null
  R: RequirementCheck | null
  M: CodemapModel
  reqOn: boolean
  node(id: string | null | undefined): CodemapData | null
  entry(id: string): NodeEntry | null
  modelOf(id: string): CodemapModel
  resolve(name: unknown, table?: 'flows'): string | null
  members: string[]
  memSet: Set<string>
  status: Map<string, ChangeMark>
  edges: ViewEdge[]
  pair: Map<string, ViewEdge>
  lanes: ViewLane[]
  flows: CodemapData[]
  bgFlows: CodemapData[]
  outside: string[]
  /** Loops on this map: groups of nodes joined in a cycle by ordinary lines (a `for` loop). */
  loops: ViewLoop[]
}

/** A loop: nodes on a cycle of this map's lines, drawn inside one frame and moved together. */
export interface ViewLoop {
  id: string
  nodes: string[]
  /** Lines that go back to an earlier node of the loop (drawn round the frame's left side). */
  back: Set<string>
  /** Code lines the loop spans, from its nodes' code (for the frame label), or null. */
  lines: [number, number] | null
}

export interface FlowStep {
  s: CodemapData
  title: string
  at?: string | null
  from?: string | null
  to?: string | null
  edge?: ViewEdge | null
  back?: boolean
  kind: BallKind
  choices: string[]
  dataType: string | null
  label: string
}

export const currentRequirement = (c: MapContext): RequirementCheck | null => c.check.reqs[c.reqIndex] ?? null

/** Requirement additions are hidden while the requirement layer is off. */
export const shown = (status: ChangeMark | null | undefined, reqOn: boolean): boolean => !(status === 'add' && !reqOn)

export function isMap(c: MapContext, id: string): boolean {
  return c.check.model.members.has(id) || Boolean(currentRequirement(c)?.model.members.has(id))
}

export function containersOf(c: MapContext, id: string): string[] {
  const out = new Set(c.check.model.containedBy.get(id) ?? [])
  for (const parent of currentRequirement(c)?.model.containedBy.get(id) ?? []) out.add(parent)
  return [...out]
}

export function nodeName(c: MapContext, id: string): string {
  return c.check.model.nodes.get(id)?.node.name ?? currentRequirement(c)?.model.nodes.get(id)?.node.name ?? id
}

/** Maps nobody contains (start points), and every other map. */
export function mapGroups(check: LibraryCheck): { roots: string[]; others: string[] } {
  const { members, containedBy } = check.model
  const ids = [...members.keys()]
  return { roots: ids.filter((id) => !containedBy.get(id)?.size), others: ids.filter((id) => containedBy.get(id)?.size) }
}

/** The biggest top-level map: what to show when nothing was opened yet. */
export function defaultRoot(check: LibraryCheck): string | null {
  const { members } = check.model
  const { roots } = mapGroups(check)
  const size = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0
    seen.add(id)
    return 1 + (members.get(id) ?? []).reduce((sum, member) => sum + size(member, seen), 0)
  }
  roots.sort((a, b) => size(b) - size(a))
  return roots[0] ?? [...members.keys()][0] ?? null
}

export function buildView(c: MapContext, X: string): MapView | null {
  const B = c.check.model
  const R = currentRequirement(c)
  const A = R?.model ?? null
  if (!B.members.has(X) && !A?.members.has(X)) return null
  const M = c.reqOn && A ? A : B
  const entry = (id: string): NodeEntry | null => M.nodes.get(id) ?? B.nodes.get(id) ?? A?.nodes.get(id) ?? null
  const node = (id: string | null | undefined): CodemapData | null => (id ? (entry(id)?.node ?? null) : null)
  const modelOf = (id: string): CodemapModel => (M.nodes.has(id) ? M : B.nodes.has(id) ? B : (A ?? B))
  const resolve = (name: unknown, table?: 'flows'): string | null =>
    M.resolve(name, X, table ? M[table] : undefined) ?? B.resolve(name, X, table ? B[table] : undefined)

  const bm = B.members.get(X) ?? []
  const am = A?.members.get(X) ?? bm
  const members = [...bm]
  const status = new Map<string, ChangeMark>()
  for (const id of bm) if (A && !am.includes(id)) status.set(id, 'del')
  for (const id of am) {
    if (bm.includes(id)) continue
    members.push(id)
    status.set(id, 'add')
  }
  if (R) {
    for (const id of members) {
      const mark = R.marks.nodes.get(id)
      if (!status.has(id) && mark) status.set(id, mark)
    }
  }

  type EdgePair = { key: string; from: string; to: string; a?: CodemapData; b?: CodemapData }
  const edgeMap = new Map<string, EdgePair>()
  const collect = (m: CodemapModel | null, which: 'a' | 'b') => {
    for (const e of (m?.nodes.get(X)?.node.edges ?? []) as CodemapData[]) {
      const from = m!.resolve(e.from, X)
      const to = m!.resolve(e.to, X)
      if (!from || !to) continue
      const key: string = e.id ?? `${from}->${to}`
      const item: EdgePair = edgeMap.get(key) ?? { key, from, to }
      item[which] = e
      edgeMap.set(key, item)
    }
  }
  collect(B, 'b')
  if (A) collect(A, 'a')
  const edges: ViewEdge[] = [...edgeMap.values()].map((item) => {
    const data = (c.reqOn ? (item.a ?? item.b) : (item.b ?? item.a)) as CodemapData
    const dm = data === item.a ? A! : B
    return {
      ...item,
      data,
      io: edgeData(dm, X, data),
      kind: data.kind ?? 'next',
      status: A ? (!item.a ? 'del' : !item.b ? 'add' : null) : null,
      hb: false,
      beats: []
    }
  })
  const pair = new Map<string, ViewEdge>()
  for (const e of edges) if (!pair.has(`${e.from}->${e.to}`) || e.status !== 'del') pair.set(`${e.from}->${e.to}`, e)

  const laneMap = new Map<string, ViewLane>()
  for (const m of [B, A]) {
    for (const l of (m?.nodes.get(X)?.node.lanes ?? []) as CodemapData[]) {
      const dock = l.dock === 'top' || l.dock === 'bottom' || l.dock === 'left' || l.dock === 'right' ? l.dock : undefined
      const lane: ViewLane = laneMap.get(l.id) ?? { id: l.id, name: l.name, nodes: [], dock }
      for (const ref of asList(l.nodes)) {
        const id = m!.resolve(ref, X)
        if (id && !lane.nodes.includes(id)) lane.nodes.push(id)
      }
      laneMap.set(l.id, lane)
    }
  }

  const allFlows = (node(X)?.flows ?? []) as CodemapData[]
  const flows = allFlows.filter((f) => f.kind !== 'background')
  const bgFlows = allFlows.filter((f) => f.kind === 'background')
  // Edges walked only by background flows (heartbeats) are drawn dotted.
  const mainUse = new Set<string>()
  const bgUse = new Set<string>()
  for (const m of [B, A]) {
    for (const f of (m?.nodes.get(X)?.node.flows ?? []) as CodemapData[]) {
      for (const s of (f.steps ?? []) as CodemapData[]) {
        if (!s.from) continue
        const a = m!.resolve(s.from, X)
        const b = m!.resolve(s.to, X)
        for (const k of [`${a}->${b}`, `${b}->${a}`]) (f.kind === 'background' ? bgUse : mainUse).add(k)
      }
    }
  }
  for (const e of edges) {
    for (const a of e.io.apis) {
      const period = heartbeatOf(a.api)
      if (period !== null && a.apiId) e.beats.push({ api: a.apiId, name: a.api?.name ?? a.apiId, period })
    }
    // A line that carries a heartbeat link is a business line (with a heartbeat on it).
    e.hb = !e.beats.length && bgUse.has(`${e.from}->${e.to}`) && !mainUse.has(`${e.from}->${e.to}`)
  }

  const memSet = new Set(members)
  const outside = [...new Set(edges.flatMap((e) => [e.from, e.to]).filter((id) => !memSet.has(id) && id !== X))]

  const loops = findLoops(members, edges, node)
  return { X, B, A, R, M, reqOn: c.reqOn, node, entry, modelOf, resolve, members, memSet, status, edges, pair, lanes: [...laneMap.values()], flows, bgFlows, outside, loops }
}

/** Requirement badges on openable nodes: each changed node counts toward everything that contains it. */
export function changedCounts(c: MapContext): Map<string, number> {
  const R = currentRequirement(c)
  const count = new Map<string, number>()
  if (!R) return count
  const changed = new Set(R.marks.nodes.keys())
  for (const k of R.marks.members.keys()) changed.add(k.slice(k.indexOf('|') + 1))
  for (const k of R.marks.fields.keys()) changed.add(k.slice(0, k.lastIndexOf('.')))
  const parents = (id: string) => {
    const out = new Set(containersOf(c, id))
    for (const m of [c.check.model, R.model]) {
      const entry = m.nodes.get(id)
      if ((entry?.how === 'data' || entry?.how === 'link') && entry.owner) out.add(entry.owner)
    }
    return out
  }
  for (const start of changed) {
    const seen = new Set([start])
    const queue = [start]
    while (queue.length) {
      for (const p of parents(queue.shift()!)) {
        if (seen.has(p)) continue
        seen.add(p)
        queue.push(p)
        count.set(p, (count.get(p) ?? 0) + 1)
      }
    }
  }
  return count
}

/** The flow inside `X` that continues the parent flow (its `refines`). */
export function refiningFlow(c: MapContext, X: string, parentFlowId: string | null): CodemapData | null {
  if (!parentFlowId) return null
  const A = currentRequirement(c)?.model
  const M = c.reqOn && A?.nodes.has(X) ? A : c.check.model
  const flows = (M.nodes.get(X)?.node.flows ?? []) as CodemapData[]
  return flows.find((f) => f.kind !== 'background' && M.resolve(f.refines, X, M.flows) === parentFlowId) ?? null
}

/** Going back up: the parent map's flow that the child's current flow refines. */
export function refinedFlowIn(c: MapContext, parent: string, child: string, childFlowId: string | null): string | null {
  const A = currentRequirement(c)?.model
  const M = c.reqOn && A?.nodes.has(child) ? A : c.check.model
  const flow = ((M.nodes.get(child)?.node.flows ?? []) as CodemapData[]).find((f) => f.id === childFlowId)
  const target = flow?.refines ? M.resolve(flow.refines, child, M.flows) : null
  return target && target.startsWith(`${parent}.`) ? target.slice(parent.length + 1) : null
}

export function resolveStep(V: MapView, s: CodemapData, background = false): FlowStep {
  const out: FlowStep = { s, title: s.title, kind: 'data', choices: [], dataType: null, label: '' }
  if (s.at) {
    out.at = V.resolve(s.at)
    out.to = out.at
    out.title ??= V.node(out.at)?.name ?? s.at
    return out
  }
  const from = V.resolve(s.from)
  const to = V.resolve(s.to)
  out.from = from
  out.to = to
  let edge = V.pair.get(`${from}->${to}`) ?? null
  let back = false
  if (!edge) {
    const reverse = V.pair.get(`${to}->${from}`)
    if (reverse && reverse.kind === 'call') {
      edge = reverse
      back = true
    }
  }
  out.edge = edge
  out.back = back
  const target = V.node(to)
  const signal =
    s.signal ??
    (background
      ? 'heartbeat'
      : edge?.data.error || (roleOf(target) === 'end' && fnOf(target).outcome === 'error')
        ? 'error'
        : back || edge?.kind === 'return'
          ? 'ack'
          : 'data')
  out.kind = (({ data: 'data', ack: 'ack', error: 'err', heartbeat: 'hb' }) as Record<string, BallKind>)[signal] ?? 'data'
  out.choices = edge ? stepChoices(edge.io, back, edge.kind) : []
  out.dataType = s.data ? V.resolve(s.data) : out.choices.length === 1 ? out.choices[0] : null
  const viaName = edge?.io.apis
    .map((a) => a.api?.name)
    .filter(Boolean)
    .join(' / ')
  out.label = s.label ?? (out.dataType ? V.node(out.dataType)?.name : viaName) ?? ''
  out.title ??= `${V.node(from)?.name ?? from} → ${target?.name ?? to}`
  return out
}

export function stepsOf(V: MapView, flowId: string | null): FlowStep[] {
  const flow = V.flows.find((f) => f.id === flowId)
  return ((flow?.steps ?? []) as CodemapData[]).map((s) => resolveStep(V, s))
}

/** Lines previewed under a map node when zoomed in: the step names inside it. */
export function summaryOf(V: MapView, id: string): string[] {
  const M = V.modelOf(id)
  const inner = (M.members.get(id) ?? []).map((m) => M.nodes.get(m)?.node).filter(Boolean) as CodemapData[]
  const exec = inner.filter((m) => !['end', 'entry'].includes(roleOf(m) ?? ''))
  return (exec.length ? exec : inner).slice(0, 5).map((m) => m.name)
}

export function fieldRefs(V: MapView, id: string, key: 'writes' | 'reads' | 'guards'): string[] {
  const M = V.modelOf(id)
  return asList(fnOf(V.node(id))[key])
    .map((ref: string) => resolveField(M, ref, id))
    .filter(Boolean) as string[]
}

/** A `{ ref, path }` node whose folder was not found: drawn as a dashed placeholder. */
export function missingRef(V: MapView, id: string): { path: string; from: string | null } | null {
  const entry = V.entry(id)
  return entry?.how === 'missing' ? { path: entry.path ?? '', from: entry.from ?? null } : null
}

export interface StructRow {
  key: string
  name: string
  type: string
  desc: string
  status: ChangeMark | null
  value: unknown
}

/** The struct a function map returns, with scenario values; fields fill in as the flow plays. */
export function structCard(V: MapView, flowId: string | null): { name: string; rows: StructRow[] } | null {
  const out = ioOf(V.modelOf(V.X), V.X).out
  const typeIn = (m: CodemapModel | null) => (m && out ? (m.nodes.get(out)?.node ?? null) : null)
  const bt = typeIn(V.B)
  const at = typeIn(V.R?.model ?? null)
  if (!bt && !at) return null
  const fields: CodemapData[] = []
  for (const f of (bt?.fields ?? []) as CodemapData[]) fields.push({ ...f })
  for (const f of (at?.fields ?? []) as CodemapData[]) if (!fields.some((x) => x.name === f.name)) fields.push({ ...f })
  const values = (m: CodemapModel | null) => {
    const vals = new Map<string, unknown>()
    const flow = ((m?.nodes.get(V.X)?.node.flows ?? []) as CodemapData[]).find((f) => f.id === flowId)
    for (const [k, v] of Object.entries(flow?.scenario?.values ?? {})) {
      const full = m ? resolveField(m, k, V.X) : null
      if (full) vals.set(full, v)
    }
    return vals
  }
  const bv = values(V.B)
  const av = V.R ? values(V.R.model) : bv
  const vals = V.reqOn ? av : bv
  const rows: StructRow[] = []
  for (const f of fields) {
    const key = `${out}.${f.name}`
    let status: ChangeMark | null = V.R?.marks.fields.get(key) ?? null
    if (!status && V.R && bv.has(key) && av.has(key) && String(bv.get(key)) !== String(av.get(key))) status = 'mod'
    if (!shown(status, V.reqOn)) continue
    rows.push({ key, name: f.name, type: f.type ?? '', desc: f.desc ?? '', status: V.reqOn ? status : null, value: vals.get(key) })
  }
  return { name: (at ?? bt)!.name, rows }
}

/** Fields assigned by the steps played so far (lights up the struct card). */
export function filledFields(V: MapView, steps: FlowStep[], upTo: number): Set<string> {
  const filled = new Set<string>()
  steps.forEach((s, i) => {
    if (i > upTo || !s.to) return
    for (const k of fieldRefs(V, s.to, 'writes')) filled.add(k)
  })
  return filled
}

// ---------- Requirement report ----------

export interface ReportChange {
  index: number
  op: 'add' | 'modify' | 'remove'
  what: string
  /** The node, edge, field … the change touches (global id), if it resolved. */
  target: string | null
  /** The map to open to see it. */
  map: string | null
  raw: CodemapData
  problems: string[]
}

export interface ReportNeighbor {
  id: string
  /** up: calls or sends to a changed node; down: a changed node calls or sends to it. */
  side: 'up' | 'down'
  /** The changed nodes it is connected to. */
  via: string[]
  map: string
}

export interface RequirementReport {
  /** Map id → changes made on it, in the order written. */
  byMap: Array<{ map: string; changes: ReportChange[] }>
  /** Changes that could not be placed on a map (problems, or library-wide). */
  other: ReportChange[]
  neighbors: ReportNeighbor[]
  /** Openable maps and how many changes sit at or below them (the badges). */
  impact: Array<{ id: string; count: number }>
}

/** The map a change shows up on: its `at`, else the map that contains its target. */
function mapOfTarget(c: MapContext, target: string | null, at: string | null): string | null {
  const models = [c.check.model, currentRequirement(c)?.model].filter(Boolean) as CodemapModel[]
  // Data and links belong to the node that owns the links.yaml (data → link → owner).
  const ownerOf = (id: string | null): string | null => {
    for (let cur = id, hops = 0; cur && hops < 3; hops++) {
      const entry = models.map((m) => m.nodes.get(cur!)).find(Boolean)
      if (!(entry?.how === 'data' || entry?.how === 'link')) return cur
      cur = entry.owner
    }
    return id
  }
  at = ownerOf(at)
  target = ownerOf(target)
  if (at && isMap(c, at)) return at
  if (!target) return at
  if (isMap(c, target) && target === at) return target
  for (let id: string | null = target; id; id = id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null) {
    if (id !== target && isMap(c, id)) return id
    for (const m of models) {
      const up = [...(m.containedBy.get(id) ?? [])]
      if (up.length) return up[0]
    }
  }
  return at
}

export function requirementReport(c: MapContext, index: number): RequirementReport | null {
  const R = c.check.reqs[index]
  if (!R) return null
  const ctx: MapContext = { ...c, reqIndex: index }
  const raws = (R.req.changes ?? []) as CodemapData[]
  const problemsAt = new Map<number, string[]>()
  for (const issue of R.problems) {
    const m = /第 (\d+) 条变更/.exec(issue.where)
    if (!m) continue
    const i = Number(m[1]) - 1
    problemsAt.set(i, [...(problemsAt.get(i) ?? []), issue.msg])
  }
  const applied = new Map(R.changes.map((ch) => [ch.index, ch]))
  const all: ReportChange[] = raws.map((raw, i) => {
    const ch = applied.get(i)
    const op = (['add', 'modify', 'remove'] as const).find((k) => raw?.[k]) ?? 'modify'
    const target = ch?.target ?? raw?.id ?? null
    return { index: i, op, what: String(raw?.[op] ?? ''), target, map: mapOfTarget(ctx, target, ch?.at ?? raw?.at ?? null), raw, problems: problemsAt.get(i) ?? [] }
  })
  const groups = new Map<string, ReportChange[]>()
  const other: ReportChange[] = []
  for (const ch of all) {
    if (!ch.map) other.push(ch)
    else groups.set(ch.map, [...(groups.get(ch.map) ?? []), ch])
  }

  // Up / downstream: nodes on the same maps connected to a changed node by an edge.
  const changedNodes = new Set(all.filter((ch) => ch.what === 'node' || ch.what === 'member').map((ch) => ch.target).filter(Boolean) as string[])
  const neighbors = new Map<string, ReportNeighbor>()
  for (const map of groups.keys()) {
    for (const model of [c.check.model, R.model]) {
      for (const e of (model.nodes.get(map)?.node.edges ?? []) as CodemapData[]) {
        const from = model.resolve(e.from, map)
        const to = model.resolve(e.to, map)
        if (!from || !to || from === to || e.kind === 'return') continue
        const pairs: Array<[string, string, 'up' | 'down']> = []
        if (changedNodes.has(to) && !changedNodes.has(from)) pairs.push([from, to, 'up'])
        if (changedNodes.has(from) && !changedNodes.has(to)) pairs.push([to, from, 'down'])
        for (const [id, changed, side] of pairs) {
          const key = `${side}|${id}`
          const item = neighbors.get(key) ?? { id, side, via: [], map }
          if (!item.via.includes(changed)) item.via.push(changed)
          neighbors.set(key, item)
        }
      }
    }
  }

  const impact = [...R.impact]
    .filter(([id]) => isMap(ctx, id))
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, count }))
  return { byMap: [...groups].map(([map, changes]) => ({ map, changes })), other, neighbors: [...neighbors.values()], impact }
}

// ---------- Loops ----------
// A `for` loop needs no marker: its steps are function nodes of this map joined in a cycle by
// ordinary lines (next / call; a `send` through a broker or a return is not a loop). Each strongly
// connected group of two or more such nodes is one loop. Lines back to the node the loop is
// entered at are its back lines.

export function findLoops(members: string[], edges: ViewEdge[], node: (id: string) => CodemapData | null): ViewLoop[] {
  const memSet = new Set(members.filter((id) => node(id)?.kind === 'function'))
  const flow = edges.filter((e) => memSet.has(e.from) && memSet.has(e.to) && e.from !== e.to && e.kind !== 'return' && e.kind !== 'send' && !e.hb)
  const succ = new Map<string, string[]>(members.map((id) => [id, []]))
  for (const e of flow) succ.get(e.from)!.push(e.to)
  // Tarjan's strongly connected components.
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const groups: string[][] = []
  let counter = 0
  const visit = (v: string) => {
    index.set(v, counter)
    low.set(v, counter++)
    stack.push(v)
    onStack.add(v)
    for (const w of succ.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        group.push(w)
      } while (w !== v)
      if (group.length > 1) groups.push(group)
    }
  }
  for (const id of members) if (!index.has(id)) visit(id)
  const order = new Map(members.map((id, i) => [id, i]))
  return groups.map((group) => {
    const nodes = group.sort((a, b) => order.get(a)! - order.get(b)!)
    const inLoop = new Set(nodes)
    // The loop's head: where it is entered from outside, else its first node.
    const head = nodes.find((id) => flow.some((e) => e.to === id && !inLoop.has(e.from))) ?? nodes[0]
    const back = new Set(flow.filter((e) => e.to === head && inLoop.has(e.from)).map((e) => e.key))
    const spans = nodes
      .map((id) => /:(\d+)(?:-(\d+))?$|^(\d+)(?:-(\d+))?$/.exec(String(node(id)?.fn?.code ?? '')))
      .filter(Boolean)
      .map((m) => {
        const a = Number(m![1] ?? m![3])
        return [a, Number(m![2] ?? m![4] ?? a)] as [number, number]
      })
    const lines: [number, number] | null = spans.length ? [Math.min(...spans.map((x) => x[0])), Math.max(...spans.map((x) => x[1]))] : null
    return { id: head, nodes, back, lines }
  })
}

// ---------- To-dos ----------
// Two sources, shown together as "to-dos": `issues` written on a node (a code point to check
// later), and the notes in a folder's todo/ (one .md per thing to do). A todo/ note belongs to
// the node defined at the top of that folder; folders with no node yet keep theirs in the summary.

const dirOf = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '')

export interface TodoItem {
  kind: 'issue' | 'note'
  /** The node it belongs to, or null (a todo/ folder with no node yet). */
  node: string | null
  /** The folder of the note (relative to the library), for grouping unattached notes. */
  dir: string
  title: string
  /** Note: the .md file (relative to the library). Issue: the node's YAML file. */
  file: string
  /** Issue only: where in the code, as written (`file:lines` or lines of the node's own file). */
  code?: string
}

export interface Todos {
  items: TodoItem[]
  /** Node id → its own to-dos. */
  byNode: Map<string, TodoItem[]>
  /** Node id → its own to-dos plus all of those inside it (what the badge shows). */
  counts: Map<string, number>
}

export function collectTodos(check: LibraryCheck, notes: { file: string; dir: string; title: string }[]): Todos {
  const { model } = check
  const items: TodoItem[] = []
  // Node defined at the top of a folder's YAML (not inline): folder → node id.
  const folderNode = new Map<string, string>()
  for (const [id, entry] of model.nodes) {
    if (entry.how === 'file') folderNode.set(dirOf(entry.file), id)
    const issues = Array.isArray(entry.node?.issues) ? (entry.node.issues as Array<Record<string, any>>) : []
    if (entry.how !== 'file' && entry.how !== 'contains') continue
    for (const it of issues) {
      if (!it || typeof it.desc !== 'string') continue
      items.push({ kind: 'issue', node: id, dir: dirOf(entry.file), title: it.desc, file: entry.file, code: issueCode(model, id, it.code) ?? undefined })
    }
  }
  for (const n of notes) items.push({ kind: 'note', node: folderNode.get(n.dir) ?? null, dir: n.dir, title: n.title, file: n.file })
  const byNode = new Map<string, TodoItem[]>()
  for (const it of items) if (it.node) byNode.set(it.node, [...(byNode.get(it.node) ?? []), it])
  // Roll counts up through the containers (each container counted once per to-do).
  const counts = new Map<string, number>()
  for (const [id, own] of byNode) {
    const seen = new Set<string>([id])
    const queue = [id]
    counts.set(id, (counts.get(id) ?? 0) + own.length)
    while (queue.length) {
      for (const p of model.containedBy.get(queue.shift()!) ?? []) {
        if (seen.has(p)) continue
        seen.add(p)
        queue.push(p)
        counts.set(p, (counts.get(p) ?? 0) + own.length)
      }
    }
  }
  return { items, byNode, counts }
}

/** A map and everything inside it: node ids, and the YAML files (and their folders) they live in. */
export function subtreeOf(c: MapContext, X: string): { ids: Set<string>; files: Set<string>; dirs: Set<string> } {
  const models = [c.check.model, currentRequirement(c)?.model].filter(Boolean) as CodemapModel[]
  const ids = new Set<string>([X])
  const queue = [X]
  while (queue.length) {
    const id = queue.shift()!
    for (const m of models)
      for (const member of m.members.get(id) ?? []) {
        if (ids.has(member)) continue
        ids.add(member)
        queue.push(member)
      }
  }
  const files = new Set<string>()
  for (const id of ids)
    for (const m of models) {
      const file = m.nodes.get(id)?.file
      if (file) files.add(file)
    }
  return { ids, files, dirs: new Set([...files].map(dirOf)) }
}

/** The issues that point into the map: their location names one of its files or nodes. */
export function issuesIn(issues: Issue[], scope: ReturnType<typeof subtreeOf>): Issue[] {
  return issues.filter((issue) => issue.where.split(' ').some((word) => scope.files.has(word) || scope.ids.has(word)))
}

/** The to-dos of the map: on its nodes, or notes (with no node yet) in or below its folders. */
export function todosIn(todos: Todos, scope: ReturnType<typeof subtreeOf>): TodoItem[] {
  const dirs = [...scope.dirs].filter(Boolean)
  return todos.items.filter((it) => (it.node ? scope.ids.has(it.node) : dirs.some((d) => it.dir === d || it.dir.startsWith(`${d}/`))))
}
