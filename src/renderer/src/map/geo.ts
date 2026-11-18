// Geometry for the project map: organic border warp and small polygon helpers.
// Pure functions with no DOM access, so the layout worker and unit tests can import them.

export type Pt = [number, number]

export interface BBox {
  x0: number
  y0: number
  x1: number
  y1: number
  w: number
  h: number
  cx: number
  cy: number
}

export const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
export const clamp01 = (t: number): number => Math.max(0, Math.min(1, t))

function hash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const a = hash(ix, iy, seed)
  const b = hash(ix + 1, iy, seed)
  const c = hash(ix, iy + 1, seed)
  const d = hash(ix + 1, iy + 1, seed)
  return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1
}

// The warp is a pure function of position, so a border shared by two regions (or a parent edge
// that a child edge lies on) bends identically everywhere. `minW` drops octaves shorter than a
// few screen pixels: every polygon drawn at one zoom uses the same band-limited curve, so shared
// borders always coincide.
const OCTAVES = [900, 520, 240, 110, 52, 24, 11, 5, 2.4, 1.1, 0.5]
export function warp(x: number, y: number, minW = 0): Pt {
  let dx = 0
  let dy = 0
  for (let i = 0; i < OCTAVES.length; i++) {
    const w = OCTAVES[i]
    if (w < minW) continue
    const amp = w * (w >= 100 ? 0.08 : 0.1)
    dx += noise(x / w + 17.3, y / w, i * 2 + 1) * amp
    dy += noise(x / w, y / w - 9.1, i * 2 + 2) * amp
  }
  return [x + dx, y + dy]
}

/** Resamples a polygon at a fixed world step, then warps every point. */
export function organic(poly: Pt[], step = 2.2, minW = 0): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % poly.length]
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step))
    for (let k = 0; k < n; k++) {
      const t = k / n
      out.push(warp(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, minW))
    }
  }
  return out
}

export function ellipse(rx: number, ry: number, n = 160): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return [Math.cos(a) * rx, Math.sin(a) * ry] as Pt
  })
}

export function polyArea(poly: Pt[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % poly.length]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

/** Area-weighted centroid: the visual middle, better than a vertex average for labels. */
export function polyCentroid(poly: Pt[]): Pt {
  let x = 0
  let y = 0
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % poly.length]
    const c = x1 * y2 - x2 * y1
    a += c
    x += (x1 + x2) * c
    y += (y1 + y2) * c
  }
  return a ? [x / (3 * a), y / (3 * a)] : (poly[0] ?? [0, 0])
}

export function bbox(poly: Pt[]): BBox {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of poly) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  if (!poly.length) x0 = y0 = x1 = y1 = 0
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
}

export function contains(poly: Pt[], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function pathLength(poly: Pt[]): number {
  let length = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % poly.length]
    length += Math.hypot(x2 - x1, y2 - y1)
  }
  return length
}

/** Keeps the part of a convex polygon on one side of an axis-aligned line (Sutherland-Hodgman). */
export function clipAxis(poly: Pt[], axis: 0 | 1, at: number, keepBelow: boolean): Pt[] {
  const inside = (p: Pt) => (keepBelow ? p[axis] <= at : p[axis] >= at)
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const ina = inside(a)
    const inb = inside(b)
    if (ina) out.push(a)
    if (ina !== inb) {
      const t = (at - a[axis]) / (b[axis] - a[axis])
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  return out
}
