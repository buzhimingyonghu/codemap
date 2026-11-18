import { fnOf, roleOf } from '@shared/codemap/codemap.mjs'
import type { MapView, ViewEdge, ViewLoop } from './model'

// Automatic layout for one map. Execution maps (with functions) are laid out by execution
// order with lanes as code modules; structure maps put lanes in columns. Lanes only decide
// where nodes start; they are not drawn. A lane with `dock` sits in a band on that side of the
// map. Nodes outside the map sit on the left (upstream) or right (downstream). A map's saved
// `layout` overrides all of this.

export const NW = 140
export const NH = 46
export const OW = 118
export const OH = 40

export interface Box {
  x: number
  y: number
  w: number
  h: number
  outside?: boolean
  /** Docked to a band on that side of the map (storage, dependency services). */
  dock?: Side
}

export type Side = 'top' | 'bottom' | 'left' | 'right'

/** The area a lane takes; used for spacing and the map bounds only, never drawn. */
interface LaneBox {
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  pos: Map<string, Box>
  box: { x: number; y: number; w: number; h: number }
  /** Nodes placed by the map's saved `layout`; the rest were placed automatically. */
  pinned: Set<string>
  /** True when the map has a saved layout (positions are frozen). */
  manual: boolean
}

/** Saved positions of this map: node id → [x, y] (keys resolved like edge ends). */
export function savedLayout(v: MapView): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>()
  const raw = v.node(v.X)?.layout
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [ref, xy] of Object.entries(raw as Record<string, unknown>)) {
    const id = v.resolve(ref) ?? ref
    if (Array.isArray(xy) && xy.length === 2 && xy.every((n) => typeof n === 'number' && Number.isFinite(n))) out.set(id, [xy[0], xy[1]])
  }
  return out
}

export function rankNodes(ids: string[], edges: Pick<ViewEdge, 'from' | 'to'>[]): Map<string, number> {
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of edges) succ.get(e.from)?.push(e.to)
  const color = new Map<string, number>()
  const order: string[] = []
  const back = new Set<string>()
  const dfs = (id: string) => {
    color.set(id, 1)
    for (const t of succ.get(id) ?? []) {
      if (color.get(t) === 1) back.add(`${id}->${t}`)
      else if (!color.get(t)) dfs(t)
    }
    color.set(id, 2)
    order.push(id)
  }
  const hasPred = new Set(edges.map((e) => e.to))
  for (const id of ids) if (!hasPred.has(id) && !color.get(id)) dfs(id)
  for (const id of ids) if (!color.get(id)) dfs(id)
  const rank = new Map<string, number>(ids.map((id) => [id, 0]))
  for (const id of order.reverse()) {
    for (const t of succ.get(id) ?? []) if (!back.has(`${id}->${t}`)) rank.set(t, Math.max(rank.get(t)!, rank.get(id)! + 1))
  }
  return rank
}

function components(ids: string[], edges: Pick<ViewEdge, 'from' | 'to'>[]): Map<string, string> {
  const parent = new Map(ids.map((id) => [id, id]))
  const find = (x: string): string => {
    const p = parent.get(x)!
    if (p === x) return x
    const root = find(p)
    parent.set(x, root)
    return root
  }
  for (const e of edges) parent.set(find(e.from), find(e.to))
  return new Map(ids.map((id) => [id, find(id)]))
}

interface Group {
  id: string
  ids: string[]
}

export function computeLayout(v: MapView, viewport: { width: number; height: number }): Layout {
  // Placement follows the lanes only: a lane with `dock` becomes a band on that side of the
  // business area; every other lane is a business column. A node's kind never moves it.
  const dockOf = new Map<string, Side>()
  for (const lane of v.lanes) if (lane.dock) for (const id of lane.nodes) if (v.memSet.has(id) && !dockOf.has(id)) dockOf.set(id, lane.dock)
  // Keep a docked node in the flow if docking would leave nothing in the middle.
  if (dockOf.size === v.members.length) dockOf.clear()
  const ids = v.members.filter((id) => !dockOf.has(id))
  const memSet = new Set(ids)
  const index = new Map(ids.map((id, i) => [id, i]))
  const exec = ids.some((id) => v.node(id)?.kind === 'function')
  const flowEdges = v.edges.filter((e) => memSet.has(e.from) && memSet.has(e.to) && e.from !== e.to && e.kind !== 'return' && !e.hb)
  const rank = rankNodes(ids, flowEdges)
  const pos = new Map<string, Box>()
  const lanes: LaneBox[] = []

  const groups: Group[] = []
  const laneOf = new Map<string, Group>()
  for (const l of v.lanes) {
    if (l.dock) continue
    const g: Group = { id: l.id, ids: [] }
    for (const id of l.nodes) {
      if (!memSet.has(id) || laneOf.has(id)) continue
      laneOf.set(id, g)
      g.ids.push(id)
    }
    groups.push(g)
  }
  const rest = ids.filter((id) => !laneOf.has(id))

  if (exec) {
    if (rest.length || !groups.length) {
      const g: Group = { id: '_', ids: rest }
      for (const id of rest) laneOf.set(id, g)
      groups.push(g)
    }
    const comp = components(ids, flowEdges)
    const compOrder = [...new Set(ids.map((id) => comp.get(id)!))]
    const isErr = (id: string) => (roleOf(v.node(id)) === 'end' && fnOf(v.node(id)).outcome === 'error' ? 1 : 0)
    const order = ids
      .slice()
      .sort(
        (a, b) =>
          compOrder.indexOf(comp.get(a)!) - compOrder.indexOf(comp.get(b)!) || isErr(a) - isErr(b) || rank.get(a)! - rank.get(b)! || index.get(a)! - index.get(b)!
      )
    // Unconnected flows (two entries, say) follow each other along the execution axis.
    let offset = 0
    for (const c of compOrder) {
      const mine = ids.filter((id) => comp.get(id) === c)
      const top = Math.max(...mine.map((id) => rank.get(id)!))
      for (const id of mine) rank.set(id, rank.get(id)! + offset)
      offset += top + 1
    }
    const used = new Set<string>()
    const sub = new Map<string, number>()
    for (const id of order) {
      const g = laneOf.get(id)!
      let s = 0
      while (used.has(`${g.id}|${s}|${rank.get(id)}`)) s++
      used.add(`${g.id}|${s}|${rank.get(id)}`)
      sub.set(id, s)
    }
    const maxRank = Math.max(0, ...ids.map((id) => rank.get(id)!))
    // Lay out both directions and keep whichever shows the text larger in this viewport.
    const candidates = (['TB', 'LR'] as const).map((dir) => {
      const p = new Map<string, Box>()
      const ls: LaneBox[] = []
      const along = dir === 'TB' ? NH + 32 : NW + 46
      const across = dir === 'TB' ? NW + 34 : NH + 28
      const span = 14 + (maxRank + 1) * along + 24
      let off = 0
      for (const g of groups) {
        if (!g.ids.length) continue
        const n = Math.max(1, ...g.ids.map((id) => sub.get(id)! + 1))
        const size = n * across
        ls.push(dir === 'TB' ? { x: off + 5, y: 0, w: size - 10, h: span } : { x: 0, y: off + 4, w: span, h: size - 8 })
        for (const id of g.ids) {
          const a = 14 + rank.get(id)! * along + along / 2
          const b = off + sub.get(id)! * across + across / 2
          p.set(id, dir === 'TB' ? { x: b, y: a, w: NW, h: NH } : { x: a, y: b, w: NW, h: NH })
        }
        off += size
      }
      return { p, ls, w: dir === 'TB' ? off : span, h: dir === 'TB' ? span : off }
    })
    const cw = viewport.width || 1000
    const ch = viewport.height || 560
    const docks = new Set(dockOf.values())
    const sideW = (v.outside.length ? 2 * (OW + 50) : 0) + (docks.has('left') ? NW + BAND_GAP : 0) + (docks.has('right') ? NW + BAND_GAP : 0)
    const bandH = (docks.has('top') ? NH + 60 : 0) + (docks.has('bottom') ? NH + 60 : 0)
    const scale = (c: { w: number; h: number }) => Math.min(cw / (c.w + sideW + 60), ch / (c.h + bandH + 60))
    const best = scale(candidates[0]) >= scale(candidates[1]) * 0.92 ? candidates[0] : candidates[1]
    for (const [id, q] of best.p) pos.set(id, q)
    lanes.push(...best.ls)
  } else {
    const cols: Group[] = groups.filter((g) => g.ids.length)
    if (rest.length) {
      if (groups.length) cols.push({ id: '_', ids: rest })
      else {
        const byRank = new Map<number, string[]>()
        for (const id of rest) {
          const r = rank.get(id)!
          if (!byRank.has(r)) byRank.set(r, [])
          byRank.get(r)!.push(id)
        }
        for (const r of [...byRank.keys()].sort((a, b) => a - b)) cols.push({ id: `r${r}`, ids: byRank.get(r)! })
      }
    }
    const COLW = NW + 90
    const ROWH = 104
    const H = Math.max(1, ...cols.map((c) => c.ids.length)) * ROWH
    cols.forEach((c, i) => {
      const x0 = i * COLW
      lanes.push({ x: x0 + 14, y: 0, w: COLW - 28, h: H + 30 })
      c.ids.forEach((id, j) => pos.set(id, { x: x0 + COLW / 2, y: ((j + 0.5) * H) / c.ids.length + 4, w: NW + 10, h: NH + 4 }))
    })
  }

  // Left and right bands come before the outside nodes, so those stay the outermost columns.
  for (const side of ['left', 'right'] as const) placeBand(v, dockOf, pos, lanes, side)

  if (v.outside.length && pos.size) {
    const boxes = [...pos.values()]
    const minX = Math.min(...boxes.map((p) => p.x - p.w / 2), ...lanes.map((l) => l.x))
    const maxX = Math.max(...boxes.map((p) => p.x + p.w / 2), ...lanes.map((l) => l.x + l.w))
    const midY = (Math.min(...boxes.map((p) => p.y)) + Math.max(...boxes.map((p) => p.y))) / 2
    const sides: Record<'L' | 'R', { o: string; y: number }[]> = { L: [], R: [] }
    for (const o of v.outside) {
      let score = 0
      const ys: number[] = []
      for (const e of v.edges) {
        if (e.from === o && memSet.has(e.to)) {
          score += e.kind === 'return' ? -1 : 1
          ys.push(pos.get(e.to)!.y)
        } else if (e.to === o && memSet.has(e.from)) {
          score += e.kind === 'return' ? 1 : -1
          ys.push(pos.get(e.from)!.y)
        }
      }
      sides[score > 0 ? 'L' : 'R'].push({ o, y: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : midY })
    }
    for (const side of ['L', 'R'] as const) {
      const list = sides[side]
      list.sort((a, b) => a.y - b.y)
      for (let i = 1; i < list.length; i++) list[i].y = Math.max(list[i].y, list[i - 1].y + OH + 20)
      const x = side === 'L' ? minX - 64 - OW / 2 : maxX + 64 + OW / 2
      for (const item of list) pos.set(item.o, { x, y: item.y, w: OW, h: OH, outside: true })
    }
  }

  for (const side of ['top', 'bottom'] as const) placeBand(v, dockOf, pos, lanes, side)

  // Loop frames need room: push nodes outside a loop off its frame (automatic layout only).
  makeRoomForLoops(v.loops, pos)

  // A saved layout wins: pinned nodes go where they were put. Nodes added later sit next to a
  // pinned neighbour until they are moved.
  const saved = savedLayout(v)
  const pinned = new Set<string>()
  const manual = saved.size > 0
  if (manual) {
    for (const [id, [x, y]] of saved) {
      const p = pos.get(id)
      if (!p) continue
      p.x = x
      p.y = y
      pinned.add(id)
    }
    const placed = [...pinned]
    let n = 0
    for (const [id, p] of pos) {
      if (pinned.has(id)) continue
      const near = v.edges.map((e) => (e.from === id ? e.to : e.to === id ? e.from : null)).find((o) => o && pinned.has(o))
      const anchor = near ? pos.get(near)! : placed.length ? pos.get(placed[placed.length - 1])! : null
      if (anchor) {
        p.x = anchor.x + anchor.w / 2 + 40 + p.w / 2
        p.y = anchor.y + (n++ % 3) * (p.h + 16)
      }
    }
    // Lane areas no longer match the nodes; the bounds follow the nodes alone.
    lanes.length = 0
  }

  const xs: number[] = []
  const ys: number[] = []
  for (const p of pos.values()) xs.push(p.x - p.w / 2, p.x + p.w / 2), ys.push(p.y - p.h / 2 - 18, p.y + p.h / 2)
  for (const l of lanes) xs.push(l.x, l.x + l.w), ys.push(l.y, l.y + l.h)
  for (const loop of v.loops) {
    const f = loopFrameRect(loop, pos)
    if (f) xs.push(f.x, f.x + f.w), ys.push(f.y, f.y + f.h)
  }
  const pad = 28
  const bx = Math.min(...xs, 0) - pad
  const by = Math.min(...ys, 0) - pad
  const bw = Math.max(...xs, 400) + pad - bx
  const bh = Math.max(...ys, 240) + pad - by
  return { pos, box: { x: bx, y: by, w: bw, h: bh }, pinned, manual }
}

function sidePoint(b: Box, side: Side, offset: number): [number, number] {
  if (side === 'top') return [b.x + offset, b.y - b.h / 2]
  if (side === 'bottom') return [b.x + offset, b.y + b.h / 2]
  if (side === 'left') return [b.x - b.w / 2, b.y + offset]
  return [b.x + b.w / 2, b.y + offset]
}

const NORMAL: Record<Side, [number, number]> = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

/** The side of `a` that faces `b`. */
export function facingSide(a: Box, b: Box): Side {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dy) > (a.h + b.h) / 2 + 8 && Math.abs(dx) < Math.abs(dy) * 1.6) return dy > 0 ? 'bottom' : 'top'
  return dx >= 0 ? 'right' : 'left'
}

/** A curve that leaves `a` from side `sa` and enters `b` from side `sb` (either may be automatic). */
export function portGeometry(a: Box, b: Box, sa: Side | null, sb: Side | null, offset = 0): { d: string; mid: [number, number]; ends: [[number, number], [number, number]] } {
  const fromSide = sa ?? facingSide(a, b)
  const toSide = sb ?? facingSide(b, a)
  const p0 = sidePoint(a, fromSide, offset * 0.8)
  const p3 = sidePoint(b, toSide, offset * 0.8)
  const dist = Math.hypot(p3[0] - p0[0], p3[1] - p0[1])
  const c = Math.max(28, dist / 2.5)
  const [nx0, ny0] = NORMAL[fromSide]
  const [nx3, ny3] = NORMAL[toSide]
  const p1 = [p0[0] + nx0 * c, p0[1] + ny0 * c]
  const p2 = [p3[0] + nx3 * c, p3[1] + ny3 * c]
  const mid = [0, 1].map((k) => (p0[k] + 3 * p1[k] + 3 * p2[k] + p3[k]) / 8) as [number, number]
  return { d: `M${p0[0]},${p0[1]} C${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`, mid, ends: [p0, p3] }
}

/** `ports: [from, to]` of an edge (each side, or null for automatic). */
export function edgePorts(data: { ports?: unknown }): [Side | null, Side | null] | null {
  const raw = Array.isArray(data.ports) ? data.ports : data.ports ? [data.ports] : []
  if (!raw.length) return null
  const side = (s: unknown): Side | null => (s === 'top' || s === 'bottom' || s === 'left' || s === 'right' ? s : null)
  return [side(raw[0]), side(raw[1])]
}

/** A cubic curve between two boxes, leaving from the facing sides. */
export function edgeGeometry(a: Box, b: Box, offset = 0): { d: string; mid: [number, number] } {
  // Lines to a docked band leave the business node from the face toward the band.
  if ((a.dock || b.dock) && a.dock !== b.dock) {
    const band = a.dock ? a : b
    const node = a.dock ? b : a
    const toBand = band.dock!
    const toNode = OPPOSITE[toBand]
    const along = toBand === 'top' || toBand === 'bottom' ? 'v' : 'h'
    const nodePt = sidePoint(node, toBand, offset * 0.8)
    const bandPt = sidePoint(band, toNode, offset * 0.8)
    const [p0, p3] = a.dock ? [bandPt, nodePt] : [nodePt, bandPt]
    const k = along === 'v' ? 1 : 0
    const c = Math.max(24, Math.abs(p3[k] - p0[k]) / 2)
    const dir = p3[k] > p0[k] ? 1 : -1
    const p1 = along === 'v' ? [p0[0], p0[1] + dir * c] : [p0[0] + dir * c, p0[1]]
    const p2 = along === 'v' ? [p3[0], p3[1] - dir * c] : [p3[0] - dir * c, p3[1]]
    const mid = [0, 1].map((i) => (p0[i] + 3 * p1[i] + 3 * p2[i] + p3[i]) / 8) as [number, number]
    return { d: `M${p0[0]},${p0[1]} C${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`, mid }
  }
  const dx = b.x - a.x
  const dy = b.y - a.y
  let p0: number[], p1: number[], p2: number[], p3: number[]
  if (Math.abs(dy) > (a.h + b.h) / 2 + 8 && Math.abs(dx) < Math.abs(dy) * 1.6) {
    const s = dy > 0 ? 1 : -1
    p0 = [a.x, a.y + (s * a.h) / 2]
    p3 = [b.x, b.y - (s * b.h) / 2]
    const c = Math.max(22, Math.abs(p3[1] - p0[1]) / 2)
    p1 = [p0[0], p0[1] + s * c]
    p2 = [p3[0], p3[1] - s * c]
  } else {
    const s = dx >= 0 ? 1 : -1
    p0 = [a.x + (s * a.w) / 2, a.y]
    p3 = [b.x - (s * b.w) / 2, b.y]
    const c = Math.max(22, Math.abs(p3[0] - p0[0]) / 2)
    p1 = [p0[0] + s * c, p0[1]]
    p2 = [p3[0] - s * c, p3[1]]
  }
  if (offset) {
    const len = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) || 1
    const nx = (-(p3[1] - p0[1]) / len) * offset
    const ny = ((p3[0] - p0[0]) / len) * offset
    ;[p0, p1, p2, p3] = [p0, p1, p2, p3].map((p, i) => [p[0] + nx * (i % 3 ? 1.6 : 0.6), p[1] + ny * (i % 3 ? 1.6 : 0.6)])
  }
  const mid = [0, 1].map((k) => (p0[k] + 3 * p1[k] + 3 * p2[k] + p3[k]) / 8) as [number, number]
  return { d: `M${p0[0]},${p0[1]} C${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`, mid }
}

const BAND_GAP = 70
const BAND_PAD = 18

/**
 * Places the nodes docked to `side` in a band on that side of everything placed so far. Each
 * node sits across from the business nodes that use it, so its lines run almost straight.
 */
function placeBand(v: MapView, dockOf: Map<string, Side>, pos: Map<string, Box>, lanes: LaneBox[], side: Side): void {
  const ids = [...dockOf].filter(([, s]) => s === side).map(([id]) => id)
  if (!ids.length || !pos.size) return
  const boxes = [...pos.values()]
  const top = Math.min(...boxes.map((p) => p.y - p.h / 2), ...lanes.map((l) => l.y))
  const bottom = Math.max(...boxes.map((p) => p.y + p.h / 2), ...lanes.map((l) => l.y + l.h))
  const left = Math.min(...boxes.map((p) => p.x - p.w / 2), ...lanes.map((l) => l.x))
  const right = Math.max(...boxes.map((p) => p.x + p.w / 2), ...lanes.map((l) => l.x + l.w))
  const order = new Map(v.members.map((id, i) => [id, i]))
  // Top / bottom bands spread along x; left / right bands stack along y.
  const horizontal = side === 'top' || side === 'bottom'
  const size = horizontal ? NW : NH
  const gap = 20
  const [lo, hi] = horizontal ? [left, right] : [top, bottom]
  // Desired place: the mean of the business nodes it connects to; unconnected ones keep their order.
  const want = ids.map((id) => {
    const at: number[] = []
    for (const e of v.edges) {
      const other = e.from === id ? e.to : e.to === id ? e.from : null
      const p = other ? pos.get(other) : null
      if (p && !p.dock && !p.outside) at.push(horizontal ? p.x : p.y)
    }
    return { id, at: at.length ? at.reduce((a, b) => a + b, 0) / at.length : Number.POSITIVE_INFINITY }
  })
  want.sort((a, b) => a.at - b.at || order.get(a.id)! - order.get(b.id)!)
  // Unconnected nodes go after the connected ones.
  let cursor = lo + size / 2
  for (const item of want) {
    if (!Number.isFinite(item.at)) item.at = cursor
    cursor = item.at + size + gap
  }
  // Push apart, then pull back from the far end if the band overflowed.
  for (let i = 1; i < want.length; i++) want[i].at = Math.max(want[i].at, want[i - 1].at + size + gap)
  const overflow = want[want.length - 1].at + size / 2 - Math.max(hi, lo + want.length * (size + gap))
  if (overflow > 0) for (const item of want) item.at -= overflow
  for (let i = want.length - 2; i >= 0; i--) want[i].at = Math.min(want[i].at, want[i + 1].at - size - gap)
  const fixed = side === 'bottom' ? bottom + BAND_GAP + NH / 2 : side === 'top' ? top - BAND_GAP - NH / 2 : side === 'left' ? left - BAND_GAP - NW / 2 : right + BAND_GAP + NW / 2
  for (const item of want) pos.set(item.id, horizontal ? { x: item.at, y: fixed, w: NW, h: NH, dock: side } : { x: fixed, y: item.at, w: NW, h: NH, dock: side })
  const a0 = Math.min(lo, want[0].at - size / 2) - BAND_PAD
  const a1 = Math.max(hi, want[want.length - 1].at + size / 2) + BAND_PAD
  lanes.push(
    horizontal
      ? { x: a0, y: fixed - NH / 2 - BAND_PAD, w: a1 - a0, h: NH + 2 * BAND_PAD }
      : { x: fixed - NW / 2 - BAND_PAD, y: a0, w: NW + 2 * BAND_PAD, h: a1 - a0 }
  )
}

/** Approximate text width (CJK characters count as one em). */
export function textWidth(text: string, size: number): number {
  let width = 0
  for (const ch of text) width += ch.charCodeAt(0) > 255 ? size : size * 0.58
  return width
}

export function fitText(text: unknown, width: number, size: number): string {
  const s = String(text ?? '')
  if (textWidth(s, size) <= width) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(`${out}${ch}…`, size) > width) break
    out += ch
  }
  return `${out}…`
}

// ---------- Loop frames ----------

export const FRAME_PAD = 22
/** The label row on top of a frame. */
export const FRAME_TOP = 22
/** Room on the frame's left for back lines: one lane per back line. */
export const BACK_LANE = 10

/** The box drawn around a loop's nodes, or null when none of them is placed. */
export function loopFrameRect(loop: ViewLoop, pos: Map<string, Box>): { x: number; y: number; w: number; h: number } | null {
  const boxes = loop.nodes.map((id) => pos.get(id)).filter(Boolean) as Box[]
  if (!boxes.length) return null
  const x0 = Math.min(...boxes.map((b) => b.x - b.w / 2)) - FRAME_PAD - loop.back.size * BACK_LANE
  const x1 = Math.max(...boxes.map((b) => b.x + b.w / 2)) + FRAME_PAD
  const y0 = Math.min(...boxes.map((b) => b.y - b.h / 2)) - FRAME_PAD - FRAME_TOP
  const y1 = Math.max(...boxes.map((b) => b.y + b.h / 2)) + FRAME_PAD
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Moves each node that is not in a loop but overlaps its frame just past the nearest frame edge. */
function makeRoomForLoops(loops: ViewLoop[], pos: Map<string, Box>): void {
  const gap = 10
  for (const loop of loops) {
    const f = loopFrameRect(loop, pos)
    if (!f) continue
    const inLoop = new Set(loop.nodes)
    for (const [id, b] of pos) {
      if (inLoop.has(id)) continue
      const [l, r, t, btm] = [b.x - b.w / 2, b.x + b.w / 2, b.y - b.h / 2, b.y + b.h / 2]
      if (r <= f.x || l >= f.x + f.w || btm <= f.y || t >= f.y + f.h) continue
      const moves: Array<[number, number]> = [
        [0, f.y - gap - btm],
        [0, f.y + f.h + gap - t],
        [f.x - gap - r, 0],
        [f.x + f.w + gap - l, 0]
      ]
      const [dx, dy] = moves.sort((a, c) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(c[0]) + Math.abs(c[1])))[0]
      b.x += dx
      b.y += dy
    }
  }
}

