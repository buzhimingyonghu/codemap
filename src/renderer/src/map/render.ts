import { clamp01, ease } from './geo'
import { t as tr } from '../lib/i18n'
import type { MapEngine } from './engine'
import { chainOf, coarseOutline, filesUnder, outlineAt, peekOutline, shape, SLOT_H_PX, type MapNode, type Outline } from './model'

// Canvas renderer. One focus at a time: its children are the only labelled layer, everything
// else is a dim silhouette. Prefix districts inside the focus get a solid glowing border and a
// name tag on that border; files in large districts sit in reading order on a lattice and are
// labelled whenever their row is tall enough to read. Roles are tweened per node so diving and
// surfacing both animate.

const FONT = '"SF Mono", ui-monospace, Menlo, monospace'
// Exact outlines are expensive when the zoom crosses a level; past this per-frame budget the
// nearest cached outline stands in and the next frame refines it.
const OUTLINE_BUDGET_MS = 8
/** Lattice rows shorter than this on screen show dots only. */
const READABLE_ROW_PX = 15

let e: MapEngine
let ctx: CanvasRenderingContext2D
let budgetEnd = 0

export function makeGrain(context: CanvasRenderingContext2D, alpha: number): CanvasPattern | null {
  const g = document.createElement('canvas')
  g.width = g.height = 160
  const gx = g.getContext('2d')
  if (!gx) return null
  const img = gx.createImageData(160, 160)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = alpha
  }
  gx.putImageData(img, 0, 0)
  return context.createPattern(g, 'repeat')
}

export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`
}

function outline(n: MapNode): Outline {
  // Shapes only a few dozen pixels across look the same with the cheap outline; never wait for
  // an exact one, so a map with thousands of small territories still settles.
  const b = shape(n).bb
  if (Math.max(b.w, b.h) * e.cam.k < 48) return coarseOutline(n)
  const peek = peekOutline(n, e.cam.k)
  if (peek?.exact) return peek.outline
  if (performance.now() < budgetEnd) return outlineAt(n, e.cam.k)
  e.unsettled = true
  return peek ? peek.outline : coarseOutline(n)
}

function tracePoly(pts: Float64Array): boolean {
  if (pts.length < 6) return false
  const k = e.cam.k
  const ox = e.areaW / 2 - e.cam.x * k
  const oy = e.areaH / 2 - e.cam.y * k
  ctx.beginPath()
  ctx.moveTo(pts[0] * k + ox, pts[1] * k + oy)
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * k + ox, pts[i + 1] * k + oy)
  ctx.closePath()
  return true
}

// ---------- Background: survey grid that rescales by powers of ten, grain, vignette ----------
function drawBackground(): void {
  const { W, H } = e.view
  const C = e.colors
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, W, H)
  const bg = ctx.createRadialGradient(W * 0.5, H * 0.46, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.75)
  bg.addColorStop(0, C.bgCenter)
  bg.addColorStop(1, C.bgEdge)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)

  // Two grid scales cross-fade as you zoom, like a survey grid that never gets too dense.
  const lg = Math.log10(64 / e.cam.k)
  const base = Math.floor(lg)
  const f = lg - base
  for (const [step, a] of [
    [Math.pow(10, base), 1 - f],
    [Math.pow(10, base + 1), 1]
  ]) {
    const px = step * e.cam.k
    if (px < 14) continue
    const [ox, oy] = e.toScreen(0, 0)
    ctx.strokeStyle = `rgba(${C.grid},${(C.gridAlpha * a).toFixed(3)})`
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = ((ox % px) + px) % px; x < W; x += px) {
      ctx.moveTo(Math.round(x) + 0.5, 0)
      ctx.lineTo(Math.round(x) + 0.5, H)
    }
    for (let y = ((oy % px) + px) % px; y < H; y += px) {
      ctx.moveTo(0, Math.round(y) + 0.5)
      ctx.lineTo(W, Math.round(y) + 0.5)
    }
    ctx.stroke()
    // Tick crosses on the major grid only.
    if (a === 1 && px > 60) {
      ctx.fillStyle = C.tick
      for (let x = ((ox % px) + px) % px; x < W; x += px)
        for (let y = ((oy % px) + px) % px; y < H; y += px) {
          ctx.fillRect(x - 3, y, 7, 1)
          ctx.fillRect(x, y - 3, 1, 7)
        }
    }
  }
}

function drawGrainAndVignette(): void {
  const { W, H } = e.view
  if (e.grain) {
    ctx.fillStyle = e.grain
    ctx.fillRect(0, 0, W, H)
  }
  const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72)
  v.addColorStop(0, 'rgba(0,0,0,0)')
  v.addColorStop(1, e.colors.vignette)
  ctx.fillStyle = v
  ctx.fillRect(0, 0, W, H)
}

// ---------- Regions ----------
function strokeOutline(n: MapNode, color: string, alpha: number, width: number, progress = 1): void {
  if (alpha <= 0.002) return
  const o = outline(n)
  if (!tracePoly(o.pts)) return
  ctx.strokeStyle = rgba(color, alpha)
  ctx.lineWidth = width
  if (progress < 1) {
    const L = o.len * e.cam.k
    ctx.setLineDash([L * progress, L])
  }
  ctx.stroke()
  if (progress < 1) ctx.setLineDash([])
}

function fillOutline(n: MapNode, style: string): void {
  if (!tracePoly(outline(n).pts)) return
  ctx.fillStyle = style
  ctx.fill()
}

function onScreen(n: MapNode, pad = 40): boolean {
  const b = shape(n).bb
  const [x0, y0] = e.toScreen(b.x0, b.y0)
  const [x1, y1] = e.toScreen(b.x1, b.y1)
  return x1 > -pad && y1 > -pad && x0 < e.view.W + pad && y0 < e.view.H + pad
}

function screenSize(n: MapNode): [number, number] {
  const b = shape(n).bb
  return [b.w * e.cam.k, b.h * e.cam.k]
}

function drawWorld(): void {
  const root = e.tree.root
  const C = e.colors
  // Coastline of the whole project: a soft outer glow, then a crisp hairline. The glow is
  // skipped once the coast is far off-screen, where it would only blur a full-screen fill.
  ctx.save()
  if (e.cam.k < e.fitK(root) * 2.5) {
    ctx.shadowColor = C.coastGlow
    ctx.shadowBlur = 24
  }
  fillOutline(root, C.coastFill)
  ctx.restore()
  strokeOutline(root, C.accent, C.coastAlpha, 1)

  const chain = chainOf(e.focus)
  // Context rings: each ancestor's other territories, dimmer the further up the chain.
  for (let d = 0; d < chain.length - 1; d++) {
    const A = chain[d]
    const near = d === chain.length - 2
    const next = chain[d + 1]
    const visit = (kids: MapNode[]) => {
      for (const c of kids) {
        if (c === next || c.kind === 'file' || !onScreen(c)) continue
        // Districts that hold the next link are opened up rather than drawn as one block.
        if (c.virtual && next.holder && holds(c, next)) {
          visit(c.kids)
          continue
        }
        const col = e.colorOf(c.slot >= 0 ? c : A)
        fillOutline(c, rgba(col, near ? 0.035 : 0.02))
        strokeOutline(c, col, near ? 0.2 : 0.1, 1)
      }
    }
    visit(A.kids)
  }
}

function holds(district: MapNode, node: MapNode): boolean {
  for (let h = node.holder; h; h = h.holder) if (h === district) return true
  return false
}

function drawFocus(dt: number): void {
  const F = e.focus
  const col = e.focusColor()
  const t = ease(clamp01(e.focusT))
  if (F.parent) {
    ctx.save()
    ctx.shadowColor = rgba(col, e.colors.focusGlow)
    ctx.shadowBlur = 30
    fillOutline(F, rgba(col, 0.05))
    ctx.restore()
  }
  // District fills first, then the folders inside them, then district borders on top, so a
  // prefix boundary is always the clearest line around its members.
  const progress = (i: number) => clamp01(t * 1.6 - (i / Math.max(1, F.districts.length)) * 0.6)
  F.districts.forEach((d) => {
    if (d.group !== 'prefix' || !onScreen(d)) return
    const hv = e.tw(`hov:${d.id}`, e.hover?.node === d || e.district === d ? 1 : 0, dt, 0.14)
    fillOutline(d, rgba(e.layerColor(d), (d.holder !== F ? 0.02 : 0.035) + hv * 0.03))
  })
  F.regions.forEach((c, i) => {
    if (!onScreen(c)) return
    const cc = e.layerColor(c)
    const hov = e.hover?.kind === 'region' && e.hover.node === c
    const hv = e.tw(`hov:${c.id}`, hov ? 1 : 0, dt, 0.12)
    const dv = e.tw(`drop:${c.id}`, e.dropTarget === c ? 1 : 0, dt, 0.1)
    const p = clamp01(t * 1.6 - (i / Math.max(1, F.regions.length)) * 0.6)
    // Inside a district, member folders step back so the district boundary leads.
    const inner = c.district ? 0.55 : 1
    fillOutline(c, rgba(cc, (F.parent ? 0.025 + (i % 3) * 0.018 : 0.06) * inner + hv * 0.08 + dv * 0.16))
    strokeOutline(c, cc, (0.45 * inner + hv * 0.45 + dv * 0.5) * p, (c.district ? 0.8 : 1) + hv * 0.6 + dv, ease(p))
  })
  F.districts.forEach((d, i) => {
    if (!onScreen(d)) return
    const cc = e.layerColor(d)
    const p = progress(i)
    const hv = e.tw(`edge:${d.id}`, e.hover?.node === d || e.district === d ? 1 : 0, dt, 0.14)
    const nested = d.holder !== F
    if (d.group !== 'prefix') {
      // Loose-file and leftover districts keep the dotted border that reads as "this folder".
      ctx.setLineDash([2, 5])
      strokeOutline(d, cc, (0.24 + hv * 0.2) * p, 1)
      ctx.setLineDash([])
      return
    }
    ctx.save()
    ctx.shadowColor = rgba(cc, 0.5 + hv * 0.3)
    ctx.shadowBlur = nested ? 6 : 14
    strokeOutline(d, cc, ((nested ? 0.62 : 0.85) + hv * 0.15) * p, (nested ? 1.1 : 1.8) + hv * 0.5, ease(p))
    ctx.restore()
  })
  if (F.parent) strokeOutline(F, col, 0.9, 1.6)
  if (e.dropTarget === F) {
    ctx.setLineDash([6, 6])
    strokeOutline(F, col, 0.95, 2)
    ctx.setLineDash([])
  }
  drawScan(F, col)
}

// One hologram sweep across the focus right after entering it.
function drawScan(F: MapNode, col: string): void {
  const t = e.focusT
  if (t >= 1) return
  const b = shape(F).bb
  const y = b.y0 + (b.h + b.h * 0.2) * ease(t) - b.h * 0.1
  const [, sy] = e.toScreen(0, y)
  ctx.save()
  if (tracePoly(outline(F).pts)) ctx.clip()
  const g = ctx.createLinearGradient(0, sy - 90, 0, sy + 2)
  g.addColorStop(0, rgba(col, 0))
  g.addColorStop(1, rgba(col, 0.22 * (1 - t)))
  ctx.fillStyle = g
  ctx.fillRect(0, sy - 90, e.view.W, 92)
  ctx.fillStyle = rgba(col, 0.7 * (1 - t))
  ctx.fillRect(0, sy, e.view.W, 1)
  ctx.restore()
}

// ---------- Labels ----------
interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface Label {
  x: number
  y: number
  text: string
  prio: number
  always: boolean
  kind: 'town' | 'region' | 'tag'
  alpha: number
  color: string
  heat?: number
  hv?: number
  capital?: boolean
  size?: number
  sub?: string
  hot?: MapNode | null
  /** Maximum label width in px; longer names are shortened in the middle. */
  room?: number
  node?: MapNode
}

// Placed label boxes, bucketed on a coarse screen grid so collision checks stay cheap with
// hundreds of labels on screen.
const BUCKET = 96
const placedGrid = new Map<number, Box[]>()
const bucketsOf = (b: Box): number[] => {
  const out: number[] = []
  for (let gx = Math.floor(b.x0 / BUCKET); gx <= Math.floor(b.x1 / BUCKET); gx++)
    for (let gy = Math.floor(b.y0 / BUCKET); gy <= Math.floor(b.y1 / BUCKET); gy++) out.push(gx * 100003 + gy)
  return out
}
function overlaps(b: Box): boolean {
  for (const key of bucketsOf(b)) for (const p of placedGrid.get(key) ?? []) if (b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0) return true
  return false
}
function place(b: Box): void {
  for (const key of bucketsOf(b)) {
    const list = placedGrid.get(key)
    if (list) list.push(b)
    else placedGrid.set(key, [b])
  }
}

// Middle ellipsis keeps both the start and the distinctive tail of long names. Widths are
// quantized to 8px steps so a moving camera keeps hitting the cache; the cut length starts
// from an estimate and is refined in a few measurements.
const fitCache = new Map<string, string>()
const widthCache = new Map<string, number>()
function textWidth(text: string): number {
  const key = `${ctx.font}|${text}`
  let w = widthCache.get(key)
  if (w === undefined) {
    w = ctx.measureText(text).width
    if (widthCache.size > 20000) widthCache.clear()
    widthCache.set(key, w)
  }
  return w
}
function fitText(text: string, maxPx: number): string {
  const room = Math.floor(maxPx / 8) * 8
  const key = `${ctx.font}|${room}|${text}`
  const hit = fitCache.get(key)
  if (hit !== undefined) return hit
  let out = text
  const full = textWidth(text)
  if (full > room) {
    out = ''
    const cut = (keep: number) => {
      const head = Math.ceil(keep * 0.5)
      return `${text.slice(0, head)}\u2026${text.slice(text.length - (keep - head))}`
    }
    let keep = Math.min(text.length - 1, Math.floor((room / full) * text.length))
    while (keep >= 3 && ctx.measureText(cut(keep)).width > room) keep--
    if (keep >= 3) {
      while (keep + 1 < text.length && ctx.measureText(cut(keep + 1)).width <= room) keep++
      out = cut(keep)
    }
  }
  if (fitCache.size > 8000) fitCache.clear()
  fitCache.set(key, out)
  return out
}

// ---------- Towns (files) ----------
function drawTowns(dt: number, labels: Label[]): void {
  const F = e.focus
  const C = e.colors
  const t = ease(clamp01(e.focusT * 1.4 - 0.2))
  const towns = e.towns
  let capitalTown: MapNode | null = null
  for (const f of towns) if (!capitalTown || f.heat > capitalTown.heat) capitalTown = f
  const { modified, open, active } = e.decorations
  const k = e.cam.k
  for (const f of towns) {
    const [sx, sy] = e.toScreen(f.x, f.y)
    const roomPx = f.slotted ? f.room * k : 260
    if (sx < -30 - roomPx || sy < -30 || sx > e.view.W + 30 || sy > e.view.H + 30) continue
    const hov = e.hover?.node === f
    const hv = e.tw(`town:${f.id}`, hov ? 1 : 0, dt, 0.1)
    const holder = f.holder
    const rowPx = f.slotted && holder ? ((holder.slotW * SLOT_H_PX) / holder.slotPx) * k : Infinity
    // Dots shrink with dense lattices so a far-out view stays a texture, not a blur.
    const scale = f.slotted ? Math.min(1, rowPx / 26) : 1
    const r = Math.max(0.8, (1.6 + f.heat * 4.2) * scale + hv * 1.6) * t
    const lane = e.layerColor(f.district ?? f)
    const c = modified.has(f.rel) ? C.modified : lane
    const capital = capitalTown === f && f.heat > 0.15
    if (f.heat > 0.2 || hv > 0) {
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(0.01, r * 6))
      g.addColorStop(0, rgba(c, 0.35 * Math.max(f.heat, hv) * t))
      g.addColorStop(1, rgba(c, 0))
      ctx.fillStyle = g
      ctx.fillRect(sx - r * 6, sy - r * 6, r * 12, r * 12)
    }
    ctx.fillStyle = f.heat > 0.12 || hv ? rgba(C.bright, 0.95 * t) : rgba(c, 0.75 * t)
    ctx.beginPath()
    ctx.arc(sx, sy, Math.max(0, r), 0, Math.PI * 2)
    ctx.fill()
    if (capital && rowPx > READABLE_ROW_PX) {
      // Summit marker: a thin ring and a tick, like a triangulation point.
      ctx.strokeStyle = rgba(C.bright, 0.8 * t)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(sx, sy, r + 5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillRect(sx - 0.5, sy - r - 13, 1, 7)
    }
    if (open.has(f.rel)) {
      ctx.strokeStyle = rgba(lane, 0.9 * t)
      ctx.lineWidth = active === f.rel ? 1.8 : 1
      ctx.beginPath()
      ctx.arc(sx, sy, r + 2.5, 0, Math.PI * 2)
      ctx.stroke()
    }
    const prio = (capital ? 3 : 0) + f.heat * 2 + hv * 10 + (active === f.rel ? 2 : 0)
    if (f.slotted) {
      // Reading order: every name shows once its row is tall enough, each in its own slot.
      if (rowPx < READABLE_ROW_PX && hv < 0.5) continue
      labels.push({ x: sx + r + 6, y: sy, text: f.short, prio: prio + 1, always: true, kind: 'town', heat: f.heat, hv, alpha: t, color: c, capital, room: Math.max(24, roomPx - r - 6) })
      continue
    }
    // Every file in the current folder is labelled; where labels collide the hotter one wins.
    const always = true
    // Names stay inside their district, shortened in the middle when it is narrow.
    const room = hv < 0.5 ? Math.max(28, screenSize(f.district ?? F)[0] * (f.district ? 0.62 : 0.4)) : undefined
    labels.push({ x: sx + r + 6, y: sy, text: f.short, prio, always, kind: 'town', heat: f.heat, hv, alpha: t, color: c, capital, room })
  }
}

// Children-of-children previews: faint pinpricks of the next layer, so a region looks
// "inhabited" and brightens as you zoom toward the dive threshold.
function drawPreview(): void {
  const F = e.focus
  const C = e.colors
  const dp = e.diveProgress()
  // A lone region is all there is to see at this level, so its inner borders always show.
  const lone = F.regions.length === 1 && !F.districts.length
  for (const c of F.regions) {
    if (!onScreen(c)) continue
    const hov = e.hover?.node === c
    const a = 0.12 + (hov ? 0.25 + (dp ?? 0) * 0.5 : 0)
    const col = e.layerColor(c)
    for (const f of filesUnder(c)) {
      if (f.heat < 0.05 && !hov) continue
      const [sx, sy] = e.toScreen(f.x, f.y)
      if (sx < -2 || sy < -2 || sx > e.view.W + 2 || sy > e.view.H + 2) continue
      ctx.fillStyle = rgba(f.heat > 0.3 ? C.bright : col, a * (0.5 + f.heat))
      ctx.fillRect(sx - 0.75, sy - 0.75, 1.5, 1.5)
    }
    // Inner borders sketch in as the dive approaches, previewing the next layer.
    const sketch = Math.max(hov && dp !== null ? dp : 0, lone ? 0.55 : 0)
    if (sketch > 0) {
      for (const g of c.kids) if (g.kind === 'dir' && onScreen(g)) strokeOutline(g, col, 0.35 * sketch, 0.8, ease(sketch))
    }
  }
}

function regionLabels(labels: Label[]): void {
  const F = e.focus
  const t = ease(clamp01(e.focusT * 1.5 - 0.15))
  for (const c of F.regions) {
    if (!onScreen(c, 0)) continue
    const s = shape(c)
    const [sx, sy] = e.toScreen(s.anchor[0], s.anchor[1])
    const [wPx, hPx] = screenSize(c)
    const hov = e.hover?.node === c
    // Too small to hold even a stub label; skip before measuring any text.
    if (!hov && (wPx < 44 || hPx < 18)) continue
    const size = Math.max(10, Math.min(F.parent ? 20 : 26, wPx / Math.max(6, c.short.length * 0.75)))
    const files = tr(c.fileCount === 1 ? '{n} file' : '{n} files', { n: c.fileCount })
    const visits = c.visits ? `  ${c.visits}\u00d7` : ''
    labels.push({
      x: sx,
      y: sy,
      text: c.short,
      sub: files + visits,
      prio: 20 + c.fileCount / 50 + (hov ? 100 : 0) + Math.min(5, c.visits),
      always: true,
      kind: 'region',
      size,
      alpha: t,
      color: e.layerColor(c),
      hot: c.hottest && c.hottest.heat > 0.2 ? c.hottest : null,
      hv: hov ? 1 : 0,
      room: wPx * 0.88
    })
  }
}

// District name tags sit inside their district: a list heads its first column, a district of
// folders shows its name in the middle (big while its members are small, then a small plate
// in the top-left corner once the members carry their own labels).
function districtTags(labels: Label[]): void {
  const F = e.focus
  const t = ease(clamp01(e.focusT * 1.5 - 0.1))
  for (const d of F.districts) {
    if (d.group !== 'prefix' || !onScreen(d, 0)) continue
    const [wPx, hPx] = screenSize(d)
    const hov = e.hover?.node === d || e.district === d
    if (!hov && (wPx < 34 || hPx < 18)) continue
    const s = shape(d)
    const nested = d.holder !== F
    const color = e.layerColor(d)
    if (d.tag) {
      const [sx, sy] = e.toScreen(d.tag[0], d.tag[1])
      labels.push({ x: sx, y: sy, text: d.name, sub: String(d.members), prio: (nested ? 40 : 60) + (hov ? 100 : 0), always: true, kind: 'tag', size: nested ? 10.5 : 11.5, alpha: t, color, room: Math.max(96, wPx * 0.9), hv: hov ? 1 : 0, node: d })
      continue
    }
    // A district of folders: while its folders are too small to label, its own name is the
    // label in the middle; once they are readable it steps aside into its top-left corner.
    const members = d.kids.filter((k) => k.kind === 'dir')
    const memberPx = members.length ? Math.min(...members.slice(0, 8).map((m) => screenSize(m)[0])) : 0
    const inner = d.kids.some((k) => k.virtual)
    if (!inner && memberPx < 90) {
      const [cx, cy] = e.toScreen(...s.anchor)
      const size = Math.max(10, Math.min(nested ? 16 : 20, wPx / Math.max(5, d.name.length * 0.8)))
      labels.push({
        x: cx,
        y: cy,
        text: d.name,
        sub: tr(d.kids.every((k) => k.kind === 'file') ? '{n} files' : '{n} folders', { n: d.members }),
        prio: (nested ? 45 : 65) + Math.min(10, d.members / 20) + (hov ? 100 : 0),
        always: true,
        kind: 'region',
        size,
        alpha: t,
        color,
        hv: hov ? 1 : 0,
        room: wPx * 0.88
      })
      continue
    }
    const corner = cornerInside(s.poly, s.bb, nested ? 10.5 : 11.5)
    const [sx, sy] = e.toScreen(corner[0], corner[1])
    labels.push({
      x: sx,
      y: sy,
      text: d.name,
      sub: String(d.members),
      prio: (nested ? 40 : 60) + Math.min(10, d.members / 20) + (hov ? 100 : 0),
      always: true,
      kind: 'tag',
      size: nested ? 10.5 : 11.5,
      alpha: t,
      color,
      room: Math.max(60, wPx * 0.85),
      hv: hov ? 1 : 0,
      node: d
    })
  }
}

/**
 * A point just inside the top-left of a territory, for a corner tag: scans down from the top
 * for the first row with room, then steps in from its left edge. World units in, world out.
 */
function cornerInside(poly: Array<[number, number]>, b: { x0: number; y0: number; x1: number; y1: number; h: number }, sizePx: number): [number, number] {
  const k = e.cam.k
  const inset = 10 / k
  const rowH = (sizePx + 10) / k
  for (let y = b.y0 + inset + rowH / 2; y < b.y1 - rowH; y += rowH / 2) {
    const xs: number[] = []
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]
      const [xj, yj] = poly[j]
      for (const yy of [y - rowH / 2, y + rowH / 2]) if (yi > yy !== yj > yy) xs.push(xi + ((yy - yi) * (xj - xi)) / (yj - yi))
    }
    if (xs.length < 4) continue
    xs.sort((a, c) => a - c)
    // Left edge of the band is the larger of the two lines' left crossings.
    const left = Math.max(xs[0], xs[1])
    const right = Math.min(xs[xs.length - 1], xs[xs.length - 2])
    if (right - left > 90 / k) return [left + inset, y]
  }
  return [b.x0 + inset, b.y0 + inset + rowH / 2]
}

function measure(L: Label): Box {
  if (L.kind === 'region') {
    const size = L.size ?? 12
    ctx.font = `600 ${size}px ${FONT}`
    const text = fitText(L.text, L.room ?? Infinity)
    const w = textWidth(text)
    L.text = text
    return { x0: L.x - w / 2, y0: L.y - size, x1: L.x + w / 2, y1: L.y + (L.sub ? 16 : 4) }
  }
  if (L.kind === 'tag') {
    const size = L.size ?? 11
    ctx.font = `600 ${size}px ${FONT}`
    const countW = L.sub ? textWidth(L.sub) * 0.9 + 8 : 0
    const text = fitText(L.text, (L.room ?? Infinity) - countW - 16)
    L.text = text
    const w = textWidth(text) + countW + 14
    // Tags are anchored at their left edge, inside the district.
    const x0 = L.node?.tag ? L.x - 6 : L.x
    return { x0, y0: L.y - size * 0.8 - 3, x1: x0 + w, y1: L.y + size * 0.8 + 3 }
  }
  ctx.font = `${L.capital ? 600 : 400} ${L.capital ? 12 : 11}px ${FONT}`
  if (L.room !== undefined) L.text = fitText(L.text, L.room)
  const w = textWidth(L.text)
  return { x0: L.x - 2, y0: L.y - 7, x1: L.x + w + 2, y1: L.y + 7 }
}

function drawLabels(labels: Label[]): void {
  labels.sort((a, b) => b.prio - a.prio)
  placedGrid.clear()
  const { W, H } = e.view
  for (const L of labels) {
    if (L.kind === 'town' && !L.always && !(L.hv && L.hv > 0)) continue
    // Labels whose anchor is off screen cannot be read; skip them before measuring.
    if (L.y < -20 || L.y > H + 20 || L.x > W + 20 || L.x < -(L.room ?? 400) - 20) continue
    const b = measure(L)
    if (!L.text) continue
    if (overlaps(b) && !((L.hv ?? 0) > 0.5)) continue
    place(b)
    if (L.kind === 'region') drawRegionLabel(L)
    else if (L.kind === 'tag') drawTag(L, b)
    else drawTownLabel(L)
  }
}

function drawRegionLabel(L: Label): void {
  const C = e.colors
  const size = L.size ?? 12
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'center'
  ctx.font = `600 ${size}px ${FONT}`
  ctx.fillStyle = rgba(C.shade, 0.7 * L.alpha)
  ctx.fillText(L.text, L.x + 1, L.y + 1)
  ctx.fillStyle = rgba(C.ink, 0.92 * L.alpha)
  ctx.fillText(L.text, L.x, L.y)
  if (L.sub) {
    ctx.font = `400 10px ${FONT}`
    const full = L.hot ? `${L.sub}  \u25B2 ${L.hot.name}` : L.sub
    const sub = (L.room ?? Infinity) >= ctx.measureText(full).width ? full : L.sub
    ctx.fillStyle = rgba(L.color, 0.75 * L.alpha)
    ctx.fillText(sub, L.x, L.y + 15)
  }
  ctx.textAlign = 'left'
}

// A small plate on the border: the prefix and how many members it holds.
function drawTag(L: Label, b: Box): void {
  const C = e.colors
  const size = L.size ?? 11
  const hv = L.hv ?? 0
  const h = b.y1 - b.y0
  const r = h / 2
  ctx.beginPath()
  ctx.moveTo(b.x0 + r, b.y0)
  ctx.arcTo(b.x1, b.y0, b.x1, b.y1, r)
  ctx.arcTo(b.x1, b.y1, b.x0, b.y1, r)
  ctx.arcTo(b.x0, b.y1, b.x0, b.y0, r)
  ctx.arcTo(b.x0, b.y0, b.x1, b.y0, r)
  ctx.closePath()
  ctx.fillStyle = rgba(C.bg, 0.86 * L.alpha)
  ctx.fill()
  ctx.strokeStyle = rgba(L.color, (0.55 + hv * 0.4) * L.alpha)
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = `600 ${size}px ${FONT}`
  ctx.fillStyle = rgba(hv ? C.bright : C.ink, 0.95 * L.alpha)
  const cy = (b.y0 + b.y1) / 2 + 0.5
  ctx.fillText(L.text, b.x0 + 7, cy)
  if (L.sub) {
    const w = textWidth(L.text)
    ctx.font = `400 ${size * 0.9}px ${FONT}`
    ctx.fillStyle = rgba(L.color, 0.9 * L.alpha)
    ctx.fillText(L.sub, b.x0 + 7 + w + 7, cy)
  }
}

function drawTownLabel(L: Label): void {
  const C = e.colors
  const heat = L.heat ?? 0
  const hv = L.hv ?? 0
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = `${L.capital ? 600 : 400} ${L.capital ? 12 : 11}px ${FONT}`
  const a = (L.always ? 0.62 + heat * 0.38 : 0) + hv * 0.45
  ctx.fillStyle = rgba(C.shade, 0.8 * a * L.alpha)
  ctx.fillText(L.text, L.x + 1, L.y + 1)
  ctx.fillStyle = rgba(heat > 0.12 || hv ? C.bright : C.ink, Math.min(1, a) * L.alpha)
  ctx.fillText(L.text, L.x, L.y)
}

// ---------- Hover reticle & dive gauge ----------
function drawReticle(now: number): void {
  const h = e.hover
  if (!h) return
  const C = e.colors
  const n = h.node
  if (h.kind === 'town') {
    const [sx, sy] = e.toScreen(n.x, n.y)
    ctx.strokeStyle = rgba(C.bright, 0.8)
    ctx.lineWidth = 1
    for (let q = 0; q < 4; q++) {
      const a = (q * Math.PI) / 2 + now / 900
      ctx.beginPath()
      ctx.arc(sx, sy, 12, a, a + 0.7)
      ctx.stroke()
    }
    e.unsettled = true
    return
  }
  if (h.kind !== 'region') return
  const dp = e.diveProgress()
  if (dp === null || dp <= 0.02) return
  const [sx, sy] = e.toScreen(...shape(n).anchor)
  const col = e.layerColor(n)
  const cy = sy - 52
  ctx.strokeStyle = rgba(col, 0.25)
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(sx, cy, 15, 0, Math.PI * 2)
  ctx.stroke()
  ctx.strokeStyle = rgba(col, 0.95)
  ctx.beginPath()
  ctx.arc(sx, cy, 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * dp)
  ctx.stroke()
  ctx.font = `600 9px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = rgba(C.ink, 0.9)
  ctx.fillText(`${Math.round(dp * 100)}`, sx, cy)
  ctx.textAlign = 'left'
}

// ---------- Ripples (landing / reveal / district jump) ----------
function drawRipples(now: number): void {
  e.ripples = e.ripples.filter((r) => now - r.t0 < r.dur)
  for (const r of e.ripples) {
    e.unsettled = true
    const p = (now - r.t0) / r.dur
    if (p < 0) continue
    const [sx, sy] = e.toScreen(r.x, r.y)
    for (let i = 0; i < 4; i++) {
      const q = clamp01(p * 1.4 - i * 0.12)
      if (q <= 0 || q >= 1) continue
      const radius = 8 + ease(q) * r.size
      ctx.strokeStyle = rgba(r.color, (1 - q) * 0.7)
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.ellipse(sx, sy, radius, radius * 0.92, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}

// ---------- Frame ----------
export function drawFrame(engine: MapEngine, dt: number, now: number): void {
  e = engine
  ctx = engine.ctx
  budgetEnd = performance.now() + OUTLINE_BUDGET_MS
  ctx.setTransform(e.view.dpr, 0, 0, e.view.dpr, 0, 0)
  drawBackground()
  drawWorld()
  drawFocus(dt)
  drawPreview()
  const labels: Label[] = []
  drawTowns(dt, labels)
  districtTags(labels)
  regionLabels(labels)
  drawLabels(labels)
  drawReticle(now)
  drawRipples(now)
  drawGrainAndVignette()
}
