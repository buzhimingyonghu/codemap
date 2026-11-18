import { clamp01, contains } from './geo'
import type { MapColors } from './colors'
import { regionAt, shape, SLOT_H_PX, townsOf, type MapNode, type MapTree } from './model'
import { drawFrame, makeGrain } from './render'

// Camera, tweens, input, and the focus (semantic zoom) state machine for one map canvas.
// One folder is in focus at a time; its children are the live layer. Wheel zoom is anchored
// under the cursor and crossing a threshold dives into the hovered child or surfaces to the
// parent. Folders with many files are bigger than the screen at reading zoom; there the camera
// pans inside the folder and jumps between its prefix districts. Frames are only rendered while
// something moves, so an idle map costs nothing.

export type HitKind = 'town' | 'region' | 'district' | 'self'
export interface Hit {
  kind: HitKind
  node: MapNode
}

export interface Ripple {
  x: number
  y: number
  t0: number
  dur: number
  color: string
  size: number
}

/** Per-file state from the rest of the IDE, by workspace-relative path. */
export interface MapDecorations {
  modified: ReadonlySet<string>
  open: ReadonlySet<string>
  active: string | null
}

export interface MapHost {
  /** Opens a file in the editor; resolves false when it could not be opened. */
  open(file: MapNode): Promise<boolean>
  contextMenu(hit: Hit, clientX: number, clientY: number): void
  /** A folder became the focus by an explicit action (click, trail, jump), not a wheel dive. */
  entered(folder: MapNode): void
}

// Thresholds, as multiples of the fit scale.
export const DIVE_AT = 0.52 // of the hovered child's fit scale
export const SURFACE_AT = 0.7 // of the current focus' fit scale
const FOCUS_COOLDOWN_MS = 550
const GESTURE_GAP_MS = 220
const TOWN_HIT_PX = 11
const LANDING_MS = 520
/** A wheel dive only fires when the pointer is at least this far inside the folder's border. */
const DIVE_EDGE_PX = 24
/** Zoom at which a lattice row is SLOT_H_PX tall: every name in it is readable. */
const readK = (n: MapNode) => (n.slotW ? n.slotPx / n.slotW : 0)
/** Default for how many items (folders and files) a level shows when you enter it. */
export const DEFAULT_ITEMS_PER_SCREEN = 40
export const ITEMS_PER_SCREEN_RANGE: [number, number] = [10, 200]
/** A list row at entry may be this much smaller than SLOT_H_PX and still read (about 18px). */
const LIST_SHRINK = 0.55
/** A level with few items opens smaller than full-screen, but never below this share of it. */
const MIN_OPEN = 0.6

interface Camera {
  x: number
  y: number
  k: number
}

export class MapEngine {
  readonly view = { W: 1, H: 1, dpr: 1 }
  /**
   * Screen space covered by floating panels (right column, bottom dock), in CSS px. The camera
   * frames and centres in what is left, so nothing it shows hides under a panel.
   */
  readonly inset = { right: 0, bottom: 0 }
  readonly cam: Camera = { x: 0, y: 0, k: 1 }
  readonly target: Camera = { x: 0, y: 0, k: 1 }
  readonly ctx: CanvasRenderingContext2D
  tree: MapTree
  focus: MapNode
  focusT = 1
  hover: Hit | null = null
  dropTarget: MapNode | null = null
  readonly mouse = { x: -1, y: -1, inside: false }
  ripples: Ripple[] = []
  landing: { file: MapNode; t0: number } | null = null
  frozen = false
  /** How many items a level shows on entering it; the rest sit around it, a pan away. */
  itemsPerScreen = DEFAULT_ITEMS_PER_SCREEN
  decorations: MapDecorations = { modified: new Set(), open: new Set(), active: null }
  colors: MapColors
  grain: CanvasPattern | null
  /** The district nearest the screen centre in the focus, if any. */
  district: MapNode | null = null
  /** Files of the focus layer (through districts), cached per focus. */
  towns: MapNode[] = []
  /** Bumped whenever something the surrounding UI shows changes. */
  version = 0
  /** Set during a frame by anything that still animates; keeps the loop alive. */
  unsettled = false
  /** Frames drawn so far. */
  frames = 0

  private readonly tweens = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private readonly timers = new Set<number>()
  private readonly disposers: Array<() => void> = []
  private raf = 0
  private last = 0
  private sized = false
  private destroyed = false
  private cooldownUntil = 0
  private lastWheel = 0
  private gestureLocked = false
  private drag: { x: number; y: number; moved: boolean } | null = null
  private readonly views = new Map<string, Camera>()

  constructor(
    readonly canvas: HTMLCanvasElement,
    tree: MapTree,
    colors: MapColors,
    private readonly host: MapHost
  ) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D is unavailable')
    this.ctx = ctx
    this.tree = tree
    this.focus = tree.root
    this.towns = townsOf(tree.root)
    this.colors = colors
    this.grain = makeGrain(ctx, colors.grainAlpha)
    this.attachInput()
    this.resize()
  }

  // ---------- Subscriptions ----------
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private bump(): void {
    this.version++
    for (const listener of [...this.listeners]) listener()
  }

  // ---------- Coordinates ----------
  /** Width and height of the visible area (canvas minus panels). */
  get areaW(): number {
    return Math.max(120, this.view.W - this.inset.right)
  }
  get areaH(): number {
    return Math.max(120, this.view.H - this.inset.bottom)
  }

  /** The camera point sits at the centre of the visible area. */
  toScreen(x: number, y: number): [number, number] {
    return [(x - this.cam.x) * this.cam.k + this.areaW / 2, (y - this.cam.y) * this.cam.k + this.areaH / 2]
  }

  toWorld(sx: number, sy: number, c: Camera = this.cam): [number, number] {
    return [(sx - this.areaW / 2) / c.k + c.x, (sy - this.areaH / 2) / c.k + c.y]
  }

  fitK(n: MapNode): number {
    const b = shape(n).bb
    return Math.min((this.areaW * 0.86) / Math.max(b.w, 1e-9), (this.areaH * 0.8) / Math.max(b.h, 1e-9))
  }

  /** Updates the panel insets; reframes when they change noticeably. */
  setInset(right: number, bottom: number): void {
    const r = Math.max(0, Math.round(right))
    const b = Math.max(0, Math.round(bottom))
    if (Math.abs(r - this.inset.right) < 4 && Math.abs(b - this.inset.bottom) < 4) return
    this.inset.right = r
    this.inset.bottom = b
    this.readCache.clear()
    if (this.sized) {
      this.frameFocus()
      this.snap()
    }
    this.invalidate()
  }

  /** Items a level holds: its subfolders and the files placed in it (through districts). */
  itemCount(n: MapNode = this.focus): number {
    return n.regions.length + townsOf(n).length
  }

  /**
   * The one rule for how big a level opens: about `itemsPerScreen` of its items on screen.
   * The count is measured, not estimated: the zoom is searched so that, framed the way the
   * level opens (its first territory at the top-left), that many items are actually in view.
   * A level with no more items than that opens whole. Listed names must stay readable, so a
   * list-heavy level never opens below the size most of its names need.
   */
  readZoom(n: MapNode = this.focus): number {
    const cached = this.readCache.get(n.id)
    if (cached !== undefined) return cached
    const fit = this.fitK(n)
    const items = this.itemCount(n)
    // Few items: the folder opens smaller, at the same item size as any other level, with its
    // neighbours in view around it.
    let k = items > 0 ? fit * Math.max(MIN_OPEN, Math.min(1, Math.sqrt(items / this.itemsPerScreen))) : fit
    if (items > this.itemsPerScreen) {
      // Visible items fall as zoom grows; bisect in log space for the target count.
      let lo = Math.log(fit)
      let hi = Math.log(fit * Math.max(2, Math.sqrt(items) * 2))
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2
        if (this.visibleAt(n, Math.exp(mid)) > this.itemsPerScreen) lo = mid
        else hi = mid
      }
      k = Math.exp(hi)
    }
    const lists = [n, ...n.districts].filter((d) => d.lattice)
    const listed = lists.reduce((sum, d) => sum + d.kids.length, 0)
    if (lists.length && listed > items * 0.5) {
      // Weighted median of the lists' reading zoom: the size most listed names need.
      const zooms = lists.map((d) => ({ k: readK(d), w: d.kids.length })).sort((a, b) => a.k - b.k)
      let acc = 0
      let median = zooms[zooms.length - 1].k
      for (const z of zooms) {
        acc += z.w
        if (acc >= listed / 2) {
          median = z.k
          break
        }
      }
      k = Math.max(k, median * LIST_SHRINK)
    }
    this.readCache.set(n.id, k)
    return k
  }

  /** Items of level `n` in view at zoom `k`, framed the way the level opens. */
  private visibleAt(n: MapNode, k: number): number {
    const lead = n.kids.find((c) => c.kind === 'dir' && c.cell.length >= 3) ?? n
    const [cx, cy] = this.startPoint(n, lead, k)
    const halfW = this.areaW / 2 / k
    const halfH = this.areaH / 2 / k
    const inside = (x: number, y: number) => Math.abs(x - cx) <= halfW && Math.abs(y - cy) <= halfH
    let count = 0
    for (const f of townsOf(n)) if (inside(f.x, f.y)) count++
    for (const r of n.regions) {
      const a = shape(r).anchor
      if (inside(a[0], a[1])) count++
    }
    return count
  }

  /** Camera centre that puts `lead`'s top-left at the screen's top-left, kept over `level`. */
  private startPoint(level: MapNode, lead: MapNode, k: number): [number, number] {
    const b = shape(lead).bb
    const halfW = this.areaW / 2 / k
    const halfH = this.areaH / 2 / k
    const x = b.w * k > this.areaW * 0.9 ? b.x0 + halfW - 40 / k : b.cx
    const y = b.h * k > this.areaH * 0.86 ? b.y0 + halfH - 30 / k : b.cy
    return this.clampPoint(level, k, x, y)
  }

  /**
   * Keeps the level reachable without letting it drift away: any point of the level can be
   * brought to the centre of the visible area, and no further (a quarter screen of margin).
   */
  private clampPoint(level: MapNode, k: number, x: number, y: number): [number, number] {
    const b = shape(level).bb
    const mx = (this.areaW * 0.25) / k
    const my = (this.areaH * 0.25) / k
    return [Math.max(b.x0 - mx, Math.min(b.x1 + mx, x)), Math.max(b.y0 - my, Math.min(b.y1 + my, y))]
  }

  /** Changes how many items a level shows on entering it, and reframes the current level. */
  setItemsPerScreen(count: number): void {
    const [lo, hi] = ITEMS_PER_SCREEN_RANGE
    const next = Math.max(lo, Math.min(hi, Math.round(count)))
    if (next === this.itemsPerScreen) return
    this.itemsPerScreen = next
    this.readCache.clear()
    this.views.clear()
    if (!this.frozen) this.frameFocus()
    this.bump()
  }
  private readonly readCache = new Map<string, number>()

  /** True when the focus is too big to read whole: the camera pans inside it. */
  get roaming(): boolean {
    return this.readZoom() > this.fitK(this.focus) * 1.15
  }

  flyTo(n: MapNode, kMul = 1): void {
    const b = shape(n).bb
    this.target.x = b.cx
    this.target.y = b.cy + b.h * 0.015
    this.target.k = this.fitK(n) * kMul
    this.clampTarget()
    this.invalidate()
  }

  /**
   * Frames the focus at its level zoom: the whole folder when its items fit on one screen,
   * otherwise the remembered view or the first territory in name order, the rest around it.
   */
  private frameFocus(): void {
    const F = this.focus
    const rk = this.readZoom()
    if (rk <= this.fitK(F) * 1.15) {
      // The whole folder fits: centre it at the level zoom (smaller than full-screen when it
      // holds only a few items).
      this.flyTo(F, rk / this.fitK(F))
      return
    }
    const saved = this.views.get(F.id)
    if (saved) {
      Object.assign(this.target, saved)
      this.clampTarget()
      this.invalidate()
      return
    }
    // Start where reading starts: the first territory in name order, like the top of a page,
    // always at the level zoom so every level opens at the same density.
    const lead = F.kids.find((c) => c.kind === 'dir' && c.cell.length >= 3)
    if (lead) this.showStart(lead, rk)
    else this.showStart(F, rk)
  }

  /** Puts the top-left of a node's reading area at the top-left of the screen. */
  private showStart(n: MapNode, k: number): void {
    const [x, y] = this.startPoint(this.focus, n, k)
    this.target.k = k
    this.target.x = x
    this.target.y = y
    this.invalidate()
  }

  /**
   * Jumps to a prefix district of the focus. The zoom stays the level zoom (so jumping never
   * changes the density), except that a district bigger than the screen is entered at its start
   * and one that holds a list is never shown smaller than its names need.
   */
  showDistrict(d: MapNode): void {
    if (d.parent && d.parent !== this.focus) this.setFocus(d.parent, false)
    const level = this.readZoom()
    const fit = this.fitK(d)
    const list = d.lattice ? readK(d) * LIST_SHRINK : 0
    // Small districts may be brought closer, but never past the size where the whole district
    // fills the screen, and never past the level zoom by more than the list needs.
    const k = Math.max(level, list, Math.min(fit, level * 1.6))
    if (k <= fit * 1.02) {
      const b = shape(d).bb
      this.target.k = k
      this.target.x = b.cx
      this.target.y = b.cy
      this.clampTarget()
      this.invalidate()
    } else {
      this.showStart(d, k)
    }
    this.ripples.push({ x: shape(d).top[0], y: shape(d).top[1], t0: performance.now() + 300, dur: 900, color: this.colorOf(d), size: 120 })
  }

  /** Keeps the view over the focus while roaming, so panning cannot drift off the folder. */
  private clampTarget(): void {
    if (!this.sized) return
    ;[this.target.x, this.target.y] = this.clampPoint(this.focus, this.target.k, this.target.x, this.target.y)
  }

  private snap(): void {
    Object.assign(this.cam, this.target)
  }

  colorOf(n: MapNode): string {
    return n.slot >= 0 ? this.colors.palette[n.slot] : this.colors.neutral
  }

  /** Color of a folder layer: its own territory color, or the world color at the root. */
  focusColor(n: MapNode = this.focus): string {
    return n.parent ? this.colorOf(n) : this.colors.accent
  }

  /**
   * Color of what is drawn inside the focus. Every territory on the level has its own color
   * (neighbours never share one); files and neutral districts take their holder's color, and
   * anything held directly by the focus takes the focus color.
   */
  layerColor(n: MapNode): string {
    for (let c: MapNode | null = n; c && c !== this.focus; c = c.holder) {
      if (c.kind === 'dir' && c.group !== 'files' && c.group !== 'other' && c.slot >= 0) return this.colors.palette[c.slot]
    }
    return this.focusColor()
  }

  // ---------- Tweens ----------
  tw(key: string, goal: number, dt: number, tau = 0.16): number {
    let v = this.tweens.get(key) ?? 0
    v += (goal - v) * (1 - Math.exp(-dt / tau))
    if (Math.abs(goal - v) < 0.002) v = goal
    else this.unsettled = true
    this.tweens.set(key, v)
    return v
  }

  // ---------- Frame loop ----------
  invalidate(): void {
    if (this.raf || this.destroyed || !this.sized) return
    this.last = performance.now() - 16
    this.raf = requestAnimationFrame(this.frame)
  }

  private frame = (now: number): void => {
    this.raf = 0
    if (this.destroyed) return
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000))
    this.last = now
    this.unsettled = false
    this.stepCamera(dt)
    drawFrame(this, dt, now)
    this.frames++
    if (this.unsettled && !this.destroyed) this.raf = requestAnimationFrame(this.frame)
  }

  /** True once the map has been drawn and nothing is animating any more. */
  get idle(): boolean {
    return this.frames > 0 && !this.raf
  }

  // Exponential smoothing in log-zoom space so zooming feels even at every depth.
  private stepCamera(dt: number): void {
    const { cam, target } = this
    const a = 1 - Math.exp(-dt / 0.14)
    cam.k = Math.exp(Math.log(cam.k) + (Math.log(target.k) - Math.log(cam.k)) * a)
    cam.x += (target.x - cam.x) * a
    cam.y += (target.y - cam.y) * a
    if (Math.abs(Math.log(target.k / cam.k)) < 1e-3 && Math.hypot(target.x - cam.x, target.y - cam.y) * cam.k < 0.2) this.snap()
    else this.unsettled = true
    this.focusT = Math.min(1, this.focusT + dt / 0.9)
    if (this.focusT < 1) this.unsettled = true
    this.trackDistrict()
  }

  // The district under the screen centre, for the index; remembered per folder while roaming.
  private trackDistrict(): void {
    const F = this.focus
    let best: MapNode | null = null
    if (F.districts.length) {
      const [wx, wy] = this.toWorld(this.areaW / 2, this.areaH / 2)
      for (const d of F.districts) if (contains(shape(d).poly, wx, wy)) best = d
    }
    if (best !== this.district) {
      this.district = best
      this.bump()
    }
    if (this.roaming) this.views.set(F.id, { ...this.target })
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const W = this.canvas.clientWidth
    const H = this.canvas.clientHeight
    if (W < 2 || H < 2) return
    if (this.sized && W === this.view.W && H === this.view.H && dpr === this.view.dpr) return
    Object.assign(this.view, { W, H, dpr })
    this.readCache.clear()
    this.canvas.width = Math.round(W * dpr)
    this.canvas.height = Math.round(H * dpr)
    const first = !this.sized
    this.sized = true
    this.flyTo(this.focus)
    if (first) this.snap()
    this.invalidate()
  }

  // ---------- Focus ----------
  setFocus(n: MapNode | null | undefined, fly = true): void {
    if (!n || n.virtual || n === this.focus) return
    this.focus = n
    this.towns = townsOf(n)
    this.district = null
    this.focusT = 0
    this.hover = null
    if (fly) this.frameFocus()
    this.cooldownUntil = performance.now() + FOCUS_COOLDOWN_MS
    this.bump()
    this.invalidate()
  }

  /** Focus change by an explicit action; counts as a visit for quick jumps. */
  enter(n: MapNode | null | undefined): void {
    if (!n || n.virtual) return
    const changed = n !== this.focus
    this.setFocus(n)
    if (changed) this.host.entered(n)
  }

  goUp(): void {
    if (this.focus.parent) this.setFocus(this.focus.parent)
    else this.frameFocus()
    this.cooldownUntil = performance.now() + FOCUS_COOLDOWN_MS
  }

  home(): void {
    if (this.focus !== this.tree.root) this.setFocus(this.tree.root)
    else this.frameFocus()
  }

  /** Shows the whole focus, even when that is too small to read the names. */
  overview(): void {
    this.flyTo(this.focus)
  }

  setTree(tree: MapTree): void {
    if (tree === this.tree) {
      // Same territories, new heat or usage.
      this.bump()
      this.invalidate()
      return
    }
    const rel = this.focus.rel
    this.tree = tree
    this.focus = regionAt(tree, rel)
    this.towns = townsOf(this.focus)
    this.district = null
    this.hover = null
    this.dropTarget = null
    this.tweens.clear()
    this.views.clear()
    this.readCache.clear()
    this.frameFocus()
    this.bump()
  }

  /** Starts at a folder without flying there, still playing the entrance sweep. */
  jumpTo(n: MapNode): void {
    if (n.virtual) return
    this.focus = n
    this.towns = townsOf(n)
    this.focusT = 0
    this.frameFocus()
    this.snap()
    this.bump()
  }

  setDecorations(decorations: MapDecorations): void {
    this.decorations = decorations
    this.invalidate()
  }

  setColors(colors: MapColors): void {
    if (colors === this.colors) return
    this.colors = colors
    this.grain = makeGrain(this.ctx, colors.grainAlpha)
    this.bump()
    this.invalidate()
  }

  /** While the editor covers the map, input is ignored and the last frame stays put. */
  setFrozen(frozen: boolean): void {
    if (frozen === this.frozen) return
    this.frozen = frozen
    this.hover = null
    this.drag = null
    // Lifting off: climb back out from the landing dive to where the folder was being read.
    if (!frozen) this.frameFocus()
    this.bump()
    this.invalidate()
  }

  setDropTarget(node: MapNode | null): void {
    if (node === this.dropTarget) return
    this.dropTarget = node
    this.invalidate()
  }

  /** The zoom a level is read at: its opening zoom, or the whole-folder view if larger. */
  private baseK(n: MapNode = this.focus): number {
    return Math.min(this.fitK(n), this.readZoom(n))
  }

  /** 0..1 progress toward auto-entering the hovered child, or null. */
  diveProgress(): number | null {
    const h = this.hover
    if (!h || h.kind !== 'region' || !this.diveTarget(h.node)) return null
    const k0 = Math.log(this.baseK())
    const k1 = Math.log(this.fitK(h.node) * DIVE_AT)
    return clamp01((Math.log(this.target.k) - k0) / (k1 - k0 || 1))
  }

  private checkThresholds(): void {
    if (this.frozen || this.landing) return
    const h = this.hover
    if (h && h.kind === 'region' && this.diveTarget(h.node) && this.target.k >= this.fitK(h.node) * DIVE_AT) {
      this.setFocus(h.node)
      return
    }
    const F = this.focus
    if (F.parent && this.target.k < this.baseK(F) * SURFACE_AT) {
      this.views.delete(F.id)
      this.setFocus(F.parent)
    }
  }

  /**
   * Whether zooming with the pointer here should dive into `region`: the pointer must be well
   * inside it (not on a border shared with a neighbour), and not over a file of this level.
   * Otherwise the wheel just zooms, so small areas next to a big folder stay reachable.
   */
  private diveTarget(region: MapNode): boolean {
    if (!this.mouse.inside) return false
    const [wx, wy] = this.toWorld(this.mouse.x, this.mouse.y)
    const poly = shape(region).poly
    if (!contains(poly, wx, wy)) return false
    const edge = DIVE_EDGE_PX / this.cam.k
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[j]
      const [bx, by] = poly[i]
      const dx = bx - ax
      const dy = by - ay
      const len = dx * dx + dy * dy
      const tt = len ? Math.max(0, Math.min(1, ((wx - ax) * dx + (wy - ay) * dy) / len)) : 0
      if (Math.hypot(wx - (ax + dx * tt), wy - (ay + dy * tt)) < edge) return false
    }
    return true
  }

  // ---------- Landing ----------
  /** Dive the camera onto a file and send a ripple; the host opens the editor. */
  land(file: MapNode): void {
    if (this.landing || this.frozen || file.kind !== 'file') return
    const color = this.fileColor(file)
    this.landing = { file, t0: performance.now() }
    this.ripples.push({ x: file.x, y: file.y, t0: performance.now(), dur: 900, color, size: 260 })
    this.target.x = file.x
    this.target.y = file.y
    this.target.k = Math.max(this.cam.k * 2.6, this.fitK(this.focus) * 3)
    if (this.roaming) this.views.set(this.focus.id, { ...this.cam })
    this.hover = null
    this.bump()
    this.invalidate()
    this.later(LANDING_MS, () => {
      void this.host
        .open(file)
        .catch(() => false)
        .then((ok) => this.endLanding(ok))
    })
  }

  /** Focus the file's folder first when needed, then land on it. */
  landOn(file: MapNode): void {
    const home = file.parent
    if (!home || this.frozen) return
    if (this.focus !== home) {
      this.setFocus(home)
      this.later(700, () => this.land(file))
    } else {
      this.land(file)
    }
  }

  endLanding(ok: boolean): void {
    if (!this.landing || this.destroyed) return
    this.landing = null
    if (!ok) this.frameFocus()
    this.bump()
    this.invalidate()
  }

  /** Brings a folder (or the folder holding a file) into focus and marks the spot. */
  reveal(node: MapNode): void {
    const region = node.kind === 'file' || node.virtual ? node.parent : node
    if (!region) return
    if (region !== this.focus) this.setFocus(region)
    if (node.kind === 'file') {
      // A large folder is read up close, so centre on the file itself.
      if (this.roaming) {
        this.target.k = Math.max(this.readZoom(), this.target.k)
        this.target.x = node.x + node.room * 0.3
        this.target.y = node.y
        this.clampTarget()
      } else if (region === this.focus) this.frameFocus()
      this.ripples.push({ x: node.x, y: node.y, t0: performance.now() + 250, dur: 1100, color: this.fileColor(node), size: 90 })
    } else if (region === this.focus) this.frameFocus()
    this.invalidate()
  }

  fileColor(file: MapNode): string {
    return this.decorations.modified.has(file.rel) ? this.colors.modified : this.layerColor(file)
  }

  private later(ms: number, fn: () => void): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id)
      if (!this.destroyed) fn()
    }, ms)
    this.timers.add(id)
  }

  // ---------- Picking ----------
  pick(sx: number, sy: number): Hit | null {
    const F = this.focus
    let best: MapNode | null = null
    let bestD = TOWN_HIT_PX
    for (const f of this.towns) {
      const [x, y] = this.toScreen(f.x, f.y)
      // On a lattice the whole row (dot and name) is the target, like a list item.
      const d = f.slotted ? this.rowDistance(f, sx, sy, x, y) : Math.hypot(x - sx, y - sy)
      if (d < bestD) {
        best = f
        bestD = d
      }
    }
    if (best) return { kind: 'town', node: best }
    const [wx, wy] = this.toWorld(sx, sy)
    for (const c of F.regions) if (contains(shape(c).poly, wx, wy)) return { kind: 'region', node: c }
    // Innermost district under the point (districts are listed outer first).
    for (let i = F.districts.length - 1; i >= 0; i--) {
      const d = F.districts[i]
      if (contains(shape(d).poly, wx, wy)) return { kind: 'district', node: d }
    }
    if (contains(shape(F).poly, wx, wy)) return { kind: 'self', node: F }
    return null
  }

  private rowDistance(f: MapNode, sx: number, sy: number, x: number, y: number): number {
    const k = this.cam.k
    const holder = f.holder
    const rowH = holder && holder.slotPx ? ((holder.slotW * SLOT_H_PX) / holder.slotPx) * k : 0
    if (Math.abs(sy - y) > Math.max(6, rowH * 0.48)) return Infinity
    if (sx < x - 8 || sx > x + Math.max(10, f.room * k)) return Infinity
    return Math.abs(sy - y) * 0.5
  }

  /** The folder a drop at this client point lands in: the region under it, else the focus. */
  folderAt(clientX: number, clientY: number): MapNode {
    const r = this.canvas.getBoundingClientRect()
    const hit = this.pick(clientX - r.left, clientY - r.top)
    if (hit?.kind === 'region') return hit.node
    if (hit?.kind === 'town') return hit.node.parent ?? this.focus
    return this.focus
  }

  /** Client coordinates of a town or a region label, for tests and popovers. */
  clientPoint(node: MapNode): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    const [x, y] = node.kind === 'file' ? this.toScreen(node.x, node.y) : this.toScreen(...shape(node).anchor)
    return { x: x + r.left, y: y + r.top }
  }

  private updateHover(): void {
    const before = this.hover
    if (!this.mouse.inside || this.drag?.moved || this.frozen || this.landing) {
      this.hover = null
    } else {
      const h = this.pick(this.mouse.x, this.mouse.y)
      this.hover = h && h.kind !== 'self' ? h : null
    }
    if (before?.node !== this.hover?.node) this.invalidate()
  }

  zoomLimits(): [number, number] {
    const F = this.focus
    const lo = this.fitK(this.tree.root) * 0.75
    const regions = F.regions.length ? Math.max(...F.regions.map((c) => this.fitK(c))) * 0.9 : this.fitK(F) * 1.8
    // Folders full of files can always be zoomed in far enough to read every name, and so can
    // the small district of loose files next to the folders (fit it to the screen, and more).
    const loose = F.districts.filter((d) => d.group === 'files').map((d) => this.fitK(d) * 1.4)
    const hi = Math.max(regions, this.readZoom() * 1.6, ...loose)
    return [lo, hi]
  }

  // ---------- Input ----------
  private listen<K extends keyof HTMLElementEventMap>(type: K, fn: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void {
    this.canvas.addEventListener(type, fn, options)
    this.disposers.push(() => this.canvas.removeEventListener(type, fn, options))
  }

  private local(event: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect()
    return [event.clientX - r.left, event.clientY - r.top]
  }

  private attachInput(): void {
    this.listen(
      'wheel',
      (e) => {
        e.preventDefault()
        if (this.frozen || this.landing) return
        const [sx, sy] = this.local(e)
        this.mouse.x = sx
        this.mouse.y = sy
        this.mouse.inside = true
        const dx0 = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX
        const dy0 = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
        // Inside a folder too big to read whole, scrolling slides the map like a page; pinch
        // or ⌘-scroll still zooms (and zooming out far enough still surfaces).
        if (this.roaming && !e.ctrlKey && !e.metaKey && this.target.k >= this.fitK(this.focus) * 1.15) {
          this.target.x += dx0 / this.target.k
          this.target.y += dy0 / this.target.k
          this.clampTarget()
          this.updateHover()
          this.invalidate()
          return
        }
        // One continuous scroll gesture (including trackpad inertia) can change level only once.
        const now = performance.now()
        const gap = now - this.lastWheel
        this.lastWheel = now
        if (this.gestureLocked && gap < GESTURE_GAP_MS) return
        this.gestureLocked = false
        const [wx, wy] = this.toWorld(sx, sy, this.target)
        const [lo, hi] = this.zoomLimits()
        // Pinch arrives as small ctrl+wheel deltas.
        const rate = e.ctrlKey ? 0.012 : 0.0022
        const k = Math.max(lo, Math.min(hi * 1.15, this.target.k * Math.exp(-dy0 * rate)))
        this.target.k = k
        this.target.x = wx - (sx - this.areaW / 2) / k
        this.target.y = wy - (sy - this.areaH / 2) / k
        this.clampTarget()
        this.updateHover()
        if (now > this.cooldownUntil) {
          const before = this.focus
          this.checkThresholds()
          if (this.focus !== before) this.gestureLocked = true
        }
        this.invalidate()
      },
      { passive: false }
    )

    this.listen('pointerdown', (e) => {
      if (this.frozen || e.button !== 0) return
      this.drag = { x: e.clientX, y: e.clientY, moved: false }
      this.canvas.setPointerCapture(e.pointerId)
    })
    this.listen('pointermove', (e) => {
      const [sx, sy] = this.local(e)
      this.mouse.x = sx
      this.mouse.y = sy
      this.mouse.inside = true
      const drag = this.drag
      if (drag) {
        const dx = e.clientX - drag.x
        const dy = e.clientY - drag.y
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
        if (drag.moved) {
          this.target.x -= dx / this.target.k
          this.target.y -= dy / this.target.k
          const bx = this.target.x
          const by = this.target.y
          this.clampTarget()
          // Follow the hand exactly, except where the edge of the folder stops it.
          this.cam.x -= dx / this.cam.k - (bx - this.target.x)
          this.cam.y -= dy / this.cam.k - (by - this.target.y)
          drag.x = e.clientX
          drag.y = e.clientY
          this.invalidate()
        }
      }
      this.updateHover()
      this.canvas.style.cursor = this.drag?.moved ? 'grabbing' : this.hover ? 'pointer' : 'default'
    })
    this.listen('pointerup', (e) => {
      const wasDrag = this.drag?.moved
      const started = Boolean(this.drag)
      this.drag = null
      this.canvas.style.cursor = this.hover ? 'pointer' : 'default'
      if (!started || wasDrag || this.frozen || this.landing) return
      const h = this.pick(...this.local(e))
      if (!h) {
        if (!this.roaming) this.goUp()
      } else if (h.kind === 'town') this.land(h.node)
      else if (h.kind === 'region') this.enter(h.node)
      else if (h.kind === 'district' && !this.roaming) this.showDistrict(h.node)
    })
    this.listen('dblclick', (e) => {
      if (this.frozen || this.landing) return
      // Double-click empty space: step back out of a large folder's close-up.
      const h = this.pick(...this.local(e))
      if (!h || h.kind === 'self' || h.kind === 'district') {
        if (this.roaming && this.target.k > this.fitK(this.focus) * 1.15) this.overview()
      }
    })
    this.listen('pointercancel', () => {
      this.drag = null
    })
    this.listen('pointerleave', () => {
      this.mouse.inside = false
      if (this.hover) {
        this.hover = null
        this.invalidate()
      }
    })
    this.listen('contextmenu', (e) => {
      e.preventDefault()
      if (this.frozen || this.landing) return
      const h = this.pick(...this.local(e))
      if (h && (h.kind === 'town' || h.kind === 'region')) this.host.contextMenu(h, e.clientX, e.clientY)
      else this.goUp()
    })
  }

  destroy(): void {
    this.destroyed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    for (const id of this.timers) window.clearTimeout(id)
    this.timers.clear()
    for (const dispose of this.disposers) dispose()
    this.listeners.clear()
  }
}
