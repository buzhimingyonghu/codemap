import { voronoiMapSimulation } from 'd3-voronoi-map'
import { bbox, clipAxis, ellipse, organic, pathLength, polyArea, polyCentroid, warp, type BBox, type Pt } from './geo'

// The project as a map: a file tree, a heat value per file, and one seeded Voronoi territory
// layout over the whole tree, so the same files always produce the same, memorable map.
// Items whose names share a prefix are gathered into districts, and large districts lay their
// files out in reading order. Pure data with no DOM access; the layout worker and unit tests
// import it directly.

export interface UsageRecord {
  score: number
  count: number
  at: number
}
export type UsageMap = Record<string, UsageRecord>

export interface Shape {
  poly: Pt[]
  bb: BBox
  anchor: Pt
  /** Where the top edge crosses the anchor's vertical: home of a district's name tag. */
  top: Pt
}

/**
 * Virtual nodes group the members of one real folder and never become a focus level:
 * `files` holds a folder's loose files next to its subfolders, `prefix` gathers members whose
 * names share a prefix, and `other` holds many leftover files that share none.
 */
export type GroupKind = 'files' | 'prefix' | 'other'

export interface MapNode {
  /** Stable key: workspace-relative path, '' for the root; virtual ids contain NUL. */
  id: string
  name: string
  /** Label inside its prefix district: the name without the shared prefix. */
  short: string
  /**
   * Folded folder chains (`billing/告警`) keep the full path in `name`; the map shows only the
   * folder's own segment (`billing`), and the trail shows every segment.
   */
  segments: string[]
  kind: 'dir' | 'file'
  /** Workspace-relative path. A virtual node shares its folder's path. */
  rel: string
  /** The real folder this node belongs to. */
  parent: MapNode | null
  /** The node whose territory contains this one (a real folder or a district). */
  holder: MapNode | null
  depth: number
  children: MapNode[]
  dirs: MapNode[]
  files: MapNode[]
  /** Layout children: districts, subfolders, and files, in name order. */
  kids: MapNode[]
  /** Real folders inside this folder's territory, through any districts. */
  regions: MapNode[]
  /** Districts inside this folder's territory, outer ones first. */
  districts: MapNode[]
  virtual: boolean
  group: GroupKind | null
  /** Nearest district holding this node, if any. */
  district: MapNode | null
  /** Shared name prefix of a prefix district. */
  prefix: string
  /** Members a district groups (folders or files). */
  members: number
  /** Kids are towns placed on a grid in reading order. */
  lattice: boolean
  /** Lattice geometry: slot width in world units and the screen width it is designed for. */
  slotW: number
  slotPx: number
  /** Lattice: where the district's name sits, above the first row. */
  tag: Pt | null
  /** Lattice: the page rectangle the rows fill, in world units. */
  grid: BBox | null
  /** File placed on a lattice; `room` is the label width it may use, in world units. */
  slotted: boolean
  room: number
  /** Palette slot of the top-level territory this node belongs to; -1 means neutral. */
  slot: number
  fileCount: number
  gen: number
  churn: number
  opens: number
  /** Folder entries recorded for this folder. */
  visits: number
  score: number
  heat: number
  rank: number
  hottest: MapNode | null
  cell: Pt[]
  x: number
  y: number
  shape: Shape | null
  coarse: Outline | null
  under: MapNode[] | null
}

export interface MapTree {
  root: MapNode
  /** Every folder and file by workspace-relative path, including folded chain segments. */
  byRel: Map<string, MapNode>
  files: MapNode[]
}

export const PALETTE_SIZE = 8
export const WORLD = { rx: 1000, ry: 640 }
const SEED = 20261028
// Above this many siblings the Voronoi solver gets slow; such folders are laid out in strips.
const MAX_VORONOI_SITES = 200
export const DEPTH_NAMES = ['WORLD', 'COUNTRY', 'PROVINCE', 'CITY', 'DISTRICT']
/** Up to this many loose files keep organic plots; more are laid out in reading order. */
export const PLOT_MAX = 12
/** A prefix district lists its files in reading order from this many files on. */
export const LIST_MIN = 2
/** Screen height of one lattice row at reading zoom. */
export const SLOT_H_PX = 34

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}
function byName(a: MapNode, b: MapNode): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  return compareNames(a.name, b.name)
}

let generation = 0

function makeNode(name: string, kind: 'dir' | 'file', rel: string, gen: number): MapNode {
  return {
    id: rel,
    name,
    short: name,
    segments: [name],
    kind,
    rel,
    parent: null,
    holder: null,
    depth: 0,
    children: [],
    dirs: [],
    files: [],
    kids: [],
    regions: [],
    districts: [],
    virtual: false,
    group: null,
    district: null,
    prefix: '',
    members: 0,
    lattice: false,
    slotW: 0,
    slotPx: 0,
    tag: null,
    grid: null,
    slotted: false,
    room: 0,
    slot: -1,
    fileCount: kind === 'file' ? 1 : 0,
    gen,
    churn: 0,
    opens: 0,
    visits: 0,
    score: 0,
    heat: 0,
    rank: 0,
    hottest: null,
    cell: [],
    x: 0,
    y: 0,
    shape: null,
    coarse: null,
    under: null
  }
}

export function walk(node: MapNode, fn: (node: MapNode) => void): void {
  fn(node)
  if (node.kind === 'dir') for (const child of node.children) walk(child, fn)
}

/** Builds the folder tree from workspace-relative file paths. */
export function buildTree(rootName: string, paths: readonly string[]): MapTree {
  const gen = ++generation
  const root = makeNode(rootName, 'dir', '', gen)
  const dirs = new Map<string, MapNode>([['', root]])
  const seen = new Set<string>()
  for (const raw of paths) {
    const parts = raw.split('/').filter(Boolean)
    const fileRel = parts.join('/')
    if (!parts.length || seen.has(fileRel) || dirs.has(fileRel)) continue
    seen.add(fileRel)
    let parent = root
    let rel = ''
    for (let i = 0; i < parts.length - 1; i++) {
      rel = rel ? `${rel}/${parts[i]}` : parts[i]
      let dir = dirs.get(rel)
      if (!dir) {
        dir = makeNode(parts[i], 'dir', rel, gen)
        parent.children.push(dir)
        dirs.set(rel, dir)
      }
      parent = dir
    }
    parent.children.push(makeNode(parts[parts.length - 1], 'file', fileRel, gen))
  }
  const byRel = new Map<string, MapNode>()
  for (const child of root.children) fold(child, byRel)
  const files: MapNode[] = []
  prepare(root, null, 0, byRel, files)
  assignSlots(root)
  return { root, byRel, files }
}

// A chain of folders that each hold only one folder (src/main/java/com/acme) becomes one region,
// the way editors show compact folders. Otherwise every link of the chain would be a level that
// looks exactly like its parent.
function fold(node: MapNode, byRel: Map<string, MapNode>): void {
  if (node.kind !== 'dir') return
  while (node.children.length === 1 && node.children[0].kind === 'dir') {
    const only = node.children[0]
    byRel.set(node.rel, node)
    node.name = `${node.name}/${only.name}`
    node.segments = [...node.segments, only.name]
    node.rel = only.rel
    node.id = only.id
    node.children = only.children
  }
  for (const child of node.children) fold(child, byRel)
}

function prepare(node: MapNode, parent: MapNode | null, depth: number, byRel: Map<string, MapNode>, files: MapNode[]): void {
  node.parent = parent
  node.depth = depth
  byRel.set(node.rel, node)
  if (node.kind === 'file') {
    files.push(node)
    return
  }
  node.children.sort(byName)
  node.dirs = node.children.filter((c) => c.kind === 'dir')
  node.files = node.children.filter((c) => c.kind === 'file')
  for (const child of node.children) prepare(child, node, depth + 1, byRel, files)
  node.fileCount = node.children.reduce((sum, c) => sum + c.fileCount, 0)
  const dirKids = groupByPrefix(node, node.dirs)
  if (node.dirs.length && node.files.length) {
    // Loose files of a folder that also has subfolders live in one neutral "free district".
    const free = makeVirtual(node, 'files', parent ? '· files' : '· root files', `${node.id}\0files`)
    free.kids = groupByPrefix(node, node.files, free.id)
    free.members = node.files.length
    node.kids = [...dirKids, free]
  } else {
    node.kids = node.dirs.length ? dirKids : groupByPrefix(node, node.files)
  }
  finishLayer(node)
}

function makeVirtual(folder: MapNode, group: GroupKind, name: string, id: string): MapNode {
  const node = makeNode(name, 'dir', folder.rel, folder.gen)
  node.id = id
  node.virtual = true
  node.group = group
  node.parent = folder
  node.depth = folder.depth + 1
  return node
}

// Files are listed in name order (one per row, label always readable) whenever they are many,
// or whenever they form a prefix district, so a district's names never collapse into dots.
const isLattice = (n: MapNode) => n.kids.every((k) => k.kind === 'file') && (n.kids.length > PLOT_MAX || (n.group === 'prefix' && n.kids.length >= LIST_MIN))

// Walks the folder's layer (everything up to the next real folders): records districts and
// regions, short labels, and which containers lay their files out in reading order.
function finishLayer(folder: MapNode): void {
  const visit = (holder: MapNode, kids: MapNode[], prefix: string) => {
    for (const k of kids) {
      k.holder = holder
      k.district = holder.virtual ? holder : null
      if (k.virtual) {
        folder.districts.push(k)
        visit(k, k.kids, k.group === 'prefix' ? k.prefix : prefix)
        k.fileCount = k.kids.reduce((sum, c) => sum + c.fileCount, 0)
        k.lattice = isLattice(k)
        continue
      }
      // On the map a folded chain shows only its first segment: the folder of this level.
      const own = k.kind === 'dir' ? k.segments[0] : k.name
      k.short = prefix && own.length > prefix.length && own.startsWith(prefix) ? own.slice(prefix.length) : own
      // Generic tails like ".1000.config" repeat across a whole district; drop them from the
      // label when every sibling shares them, so the distinctive part shows.
      if (k.kind === 'dir') folder.regions.push(k)
    }
    trimSharedTail(kids.filter((k) => !k.virtual))
  }
  visit(folder, folder.kids, '')
  folder.lattice = isLattice(folder)
}

function trimSharedTail(items: MapNode[]): void {
  if (items.length < 3) return
  const tails = items.map((k) => k.short.split(/(?=[._])/))
  let common = 0
  for (;;) {
    const piece = tails[0][tails[0].length - 1 - common]
    if (piece === undefined || !tails.every((t) => t.length - common > 1 && t[t.length - 1 - common] === piece)) break
    common++
  }
  // Keep file extensions: a list of names without them reads worse, not better.
  if (items[0].kind === 'file') return
  if (common) items.forEach((k, i) => (k.short = tails[i].slice(0, tails[i].length - common).join('')))
}

// Provisional colors before the layout exists: siblings in name order, so a tree is usable
// even without cells. `colorSiblings` replaces them with neighbour-aware colors once laid out.
function assignSlots(root: MapNode): void {
  const visit = (n: MapNode) => {
    let next = hashString(n.id) % PALETTE_SIZE
    for (const k of n.kids) {
      if (k.kind === 'dir') {
        k.slot = k.group === 'files' || k.group === 'other' ? -1 : next++ % PALETTE_SIZE
        visit(k)
      } else {
        k.slot = n.slot
      }
    }
  }
  visit(root)
}

// Every territory on one level gets its own palette color, and territories that touch never
// share one: greedy colouring over the shared-border graph, in name order, starting from a
// per-folder offset so neighbouring folders do not all open with the same hue.
function colorSiblings(n: MapNode): void {
  const kids = n.kids.filter((k) => k.kind === 'dir' && k.group !== 'files' && k.group !== 'other' && k.cell.length >= 3)
  if (!kids.length) return
  const boxes = kids.map((k) => bbox(k.cell))
  const scale = Math.max(...boxes.map((b) => Math.max(b.w, b.h))) || 1
  const touch = (a: number, b: number): boolean => {
    const A = boxes[a]
    const B = boxes[b]
    const eps = scale * 1e-4
    if (A.x0 > B.x1 + eps || B.x0 > A.x1 + eps || A.y0 > B.y1 + eps || B.y0 > A.y1 + eps) return false
    // Two cells touch when one has a vertex on (or very near) the other's boundary.
    const near = (p: Pt, poly: Pt[]) => poly.some((q, i) => segDistance(p, q, poly[(i + 1) % poly.length]) < eps * 4)
    return kids[a].cell.some((p) => near(p, kids[b].cell)) || kids[b].cell.some((p) => near(p, kids[a].cell))
  }
  const start = hashString(n.id) % PALETTE_SIZE
  const used = kids.map(() => -1)
  kids.forEach((k, i) => {
    const taken = new Set<number>()
    for (let j = 0; j < i; j++) if (touch(i, j)) taken.add(used[j])
    // Prefer a color no earlier sibling used at all, then any color the neighbours do not use.
    const counts = new Array<number>(PALETTE_SIZE).fill(0)
    for (let j = 0; j < i; j++) counts[used[j]]++
    let pick = -1
    for (let s = 0; s < PALETTE_SIZE && pick < 0; s++) {
      const c = (start + i + s) % PALETTE_SIZE
      if (!taken.has(c) && counts[c] === Math.min(...counts.filter((_, ci) => !taken.has(ci)))) pick = c
    }
    if (pick < 0) pick = (start + i) % PALETTE_SIZE
    used[i] = pick
    k.slot = pick
  })
  // Files and the neutral districts take their holder's color.
  for (const k of n.kids) if (k.kind === 'file' || k.group === 'files' || k.group === 'other') k.slot = n.slot
}

function segDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t))
}

// ---------- Prefix districts ----------
// Names are split into words at . _ - and spaces; leading numbers (0001_) are skipped so
// numbered files group by what they do. Members sharing a word at the first position where
// they differ form a district, however few they are. A large district splits again the same
// way, but only when that really sorts it (most members land in groups of three or more).
const WORD_BREAK = /[._\-\s]+/
const MIN_MEMBERS = 2
const NEST_AT = 24
const MAX_NEST = 3
const SOLID_GROUP = 3
const SOLID_SHARE = 0.6

export function nameWords(name: string): string[] {
  const parts = name.split(WORD_BREAK).filter(Boolean)
  let i = 0
  while (i < parts.length - 1 && /^\d+$/.test(parts[i])) i++
  return parts.slice(i).map((p) => p.toLowerCase())
}

/** Longest common prefix of the names, cut back to the last word break. */
export function sharedPrefix(names: string[]): string {
  if (!names.length) return ''
  let p = names[0]
  for (const n of names) {
    let i = 0
    while (i < p.length && i < n.length && p[i] === n[i]) i++
    p = p.slice(0, i)
    if (!p) return ''
  }
  const cut = p.match(/^(.*[._\-\s])/)
  return cut ? cut[1] : ''
}

interface Split {
  depth: number
  groups: Array<{ key: string; items: MapNode[] }>
  rest: MapNode[]
}

function splitByWord(items: MapNode[], words: Map<MapNode, string[]>, depth: number, strict: boolean): Split | null {
  const wordAt = (item: MapNode, d: number) => words.get(item)?.[d]
  // Skip positions every member shares.
  for (;;) {
    const first = wordAt(items[0], depth)
    if (first === undefined || !items.every((it) => wordAt(it, depth) === first)) break
    depth++
  }
  const buckets = new Map<string, MapNode[]>()
  for (const it of items) {
    const key = wordAt(it, depth) ?? ''
    const list = buckets.get(key)
    if (list) list.push(it)
    else buckets.set(key, [it])
  }
  const groups: Split['groups'] = []
  const rest: MapNode[] = []
  for (const [key, list] of buckets) {
    if (key && list.length >= MIN_MEMBERS) groups.push({ key, items: list })
    else rest.push(...list)
  }
  if (!groups.length || (groups.length === 1 && !rest.length)) return null
  if (strict) {
    const solid = groups.filter((g) => g.items.length >= SOLID_GROUP).reduce((sum, g) => sum + g.items.length, 0)
    if (solid < items.length * SOLID_SHARE) return null
  }
  return { depth, groups, rest }
}

function wordIn(name: string, key: string): string {
  return name.split(WORD_BREAK).find((p) => p.toLowerCase() === key) ?? key
}

function groupByPrefix(folder: MapNode, items: MapNode[], scope = folder.id): MapNode[] {
  if (items.length < 2) return items
  const words = new Map(items.map((it) => [it, nameWords(it.name)]))
  // What every member shares is not worth repeating on each district's label.
  return nest(folder, items, words, 0, 0, sharedPrefix(items.map((it) => it.name)), scope)
}

function nest(folder: MapNode, items: MapNode[], words: Map<MapNode, string[]>, level: number, depth: number, outer: string, scope: string): MapNode[] {
  const canSplit = level === 0 || (level < MAX_NEST && items.length >= NEST_AT)
  const split = canSplit ? splitByWord(items, words, depth, level > 0) : null
  if (!split) return items
  const out: MapNode[] = []
  for (const g of split.groups) {
    const prefix = sharedPrefix(g.items.map((it) => it.name))
    const own = prefix.startsWith(outer) ? prefix.slice(outer.length) : prefix
    const label = own.replace(/[._\-\s]+$/, '') || wordIn(g.items[0].name, g.key)
    const id = `${scope}\0${g.key}`
    const district = makeVirtual(folder, 'prefix', label, id)
    district.prefix = prefix.length > outer.length ? prefix : outer
    district.members = g.items.length
    district.kids = nest(folder, g.items, words, level + 1, split.depth + 1, district.prefix, id)
    out.push(district)
  }
  const rest = split.rest
  // Many leftover files would scatter between the districts; keep them together instead.
  if (rest.length > PLOT_MAX && rest[0].kind === 'file') {
    const other = makeVirtual(folder, 'other', '· other', `${scope}\0\0other`)
    other.members = rest.length
    other.kids = rest
    out.push(other)
  } else {
    out.push(...rest)
  }
  // Same order as the file tree: folders (and districts of folders) first, then files and file
  // districts, each by name; the leftover district always comes last.
  const rank = (n: MapNode) => (n.group === 'other' ? 3 : isFolderish(n) ? 0 : 1)
  return out.sort((a, b) => rank(a) - rank(b) || compareNames(a.name, b.name))
}

function isFolderish(n: MapNode): boolean {
  if (n.kind === 'file') return false
  if (!n.virtual) return true
  return n.kids.some(isFolderish)
}

// ---------- Heat ----------
// score = local opens (14-day half-life) x3 + git churn x0.5, then a rank curve so only the top
// tier becomes a real "peak" and the map always has contrast. Equal scores share a rank.
const HALF_LIFE_MS = 14 * 86400e3

export function decayedScore(record: UsageRecord, now: number): number {
  return record.score * Math.pow(0.5, (now - record.at) / HALF_LIFE_MS)
}

export function applyChurn(tree: MapTree, churn: Record<string, number>): void {
  for (const file of tree.files) file.churn = churn[file.rel] ?? 0
}

/** Usage keys for folder entries; file keys are plain relative paths. */
export const folderKey = (rel: string) => `${rel}/`

export function computeHeat(tree: MapTree, usage: UsageMap, now: number): MapNode[] {
  const files = [...tree.files]
  for (const f of files) {
    const u = usage[f.rel]
    f.opens = u ? u.count : 0
    f.score = (u ? decayedScore(u, now) : 0) * 3 + f.churn * 0.5
  }
  files.sort((a, b) => b.score - a.score || collator.compare(a.rel, b.rel))
  const max = files[0]?.score || 1
  let rankStart = 0
  files.forEach((f, i) => {
    if (i > 0 && f.score !== files[i - 1].score) rankStart = i
    const pct = 1 - rankStart / files.length
    f.heat = f.score > 0 ? Math.min(1, Math.pow(pct, 5) * 0.7 + (f.score / max) * 0.3) : 0
    f.rank = i
    f.hottest = f
  })
  const up = (n: MapNode): number => {
    if (n.kind === 'file') return n.heat
    n.visits = n.virtual ? 0 : (usage[folderKey(n.rel)]?.count ?? 0)
    const top = n.kids.map(up).sort((a, b) => b - a).slice(0, 3)
    n.heat = top.length ? top.reduce((s, v) => s + v, 0) / top.length : 0
    n.hottest = null
    for (const c of n.kids) if (c.hottest && (!n.hottest || c.hottest.heat > n.hottest.heat)) n.hottest = c.hottest
    return n.heat
  }
  up(tree.root)
  return files
}

/** Folders entered most often, for quick jumps. */
export function frequentFolders(tree: MapTree, usage: UsageMap, now: number, limit: number): MapNode[] {
  const out: Array<{ node: MapNode; score: number }> = []
  for (const [key, record] of Object.entries(usage)) {
    if (!key.endsWith('/')) continue
    const node = tree.byRel.get(key.slice(0, -1))
    if (node && node.kind === 'dir' && node !== tree.root && node.rel === key.slice(0, -1)) out.push({ node, score: decayedScore(record, now) })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map((e) => e.node)
}

// ---------- Territories ----------
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0), (s & 0xffffff) / 0x1000000)
}

/** An irregular landmass instead of an ellipse: radius modulated by a few seeded lobes. */
export function landmass(): Pt[] {
  const rnd = seeded(7)
  const lobes = [2, 3, 5, 7].map((f) => {
    const a = rnd() * Math.PI * 2
    const m = 0.11 / Math.sqrt(f) + rnd() * 0.04
    return { f, a, m }
  })
  return ellipse(WORLD.rx, WORLD.ry, 140).map(([x, y]) => {
    const a = Math.atan2(y / WORLD.ry, x / WORLD.rx)
    const s = 1 + lobes.reduce((acc, l) => acc + Math.sin(a * l.f + l.a) * l.m, 0)
    return [x * s, y * s] as Pt
  })
}

interface Site {
  node: MapNode
  weight: number
}

function copy(poly: Pt[]): Pt[] {
  return poly.map((p) => [p[0], p[1]] as Pt)
}

/** The convex, counterclockwise clip the solver actually uses (it hulls anything else). */
function normalizeClip(poly: Pt[]): Pt[] {
  const probe = voronoiMapSimulation<Site>([]).stop()
  probe.clip(copy(poly))
  return copy(probe.clip())
}

function voronoiCells(clip: Pt[], kids: MapNode[], value: Map<MapNode, number>, prng: () => number): Array<[MapNode, Pt[]]> {
  // Sites start in reading order inside the clip: rows top to bottom, left to right, so the
  // first names end up at the top and the last at the bottom, like the file tree.
  const seeds = readingSeeds(clip, kids.length)
  const start = (_site: Site, i: number): Pt => seeds[i]
  const simulation = voronoiMapSimulation<Site>(kids.map((node) => ({ node, weight: value.get(node) ?? 1 })))
    .clip(copy(clip))
    .weight((site) => site.weight)
    .convergenceRatio(0.003)
    .maxIterationCount(90)
    .minWeightRatio(0.02)
    .prng(prng)
    .initialPosition(start)
    .stop()
  let state = simulation.state()
  while (!state.ended) {
    simulation.tick()
    state = simulation.state()
  }
  if (state.polygons.length !== kids.length) throw new Error('Voronoi map lost a site')
  return state.polygons.map((polygon) => [polygon.site.originalObject.data.originalData.node, copy(polygon)])
}

/**
 * `n` points inside the polygon in reading order. The polygon is cut into rows of equal area;
 * each row's inside span is split into equal slots. Every point lies strictly inside the clip,
 * so the solver never replaces one with a random position.
 */
export function readingSeeds(poly: Pt[], n: number): Pt[] {
  const b = bbox(poly)
  const rows = Math.max(1, Math.round(Math.sqrt((n * b.h) / Math.max(b.w, 1e-12))))
  // Inside width of each thin horizontal strip; rows take equal shares of the total.
  const strips = 64 * rows
  const widths: Array<{ y: number; span: [number, number] | null; w: number }> = []
  for (let i = 0; i < strips; i++) {
    const y = b.y0 + ((i + 0.5) / strips) * b.h
    let best: [number, number] | null = null
    for (const r of scanline(poly, y)) if (!best || r[1] - r[0] > best[1] - best[0]) best = r
    widths.push({ y, span: best, w: best ? best[1] - best[0] : 0 })
  }
  const total = widths.reduce((s, w) => s + w.w, 0) || 1
  // Members per row in proportion to that row's area, at least one, summing to n.
  const rowStrips: Array<typeof widths> = []
  let acc = 0
  let row: typeof widths = []
  for (const w of widths) {
    row.push(w)
    acc += w.w
    if (acc >= (total * (rowStrips.length + 1)) / rows && rowStrips.length < rows - 1) {
      rowStrips.push(row)
      row = []
    }
  }
  rowStrips.push(row)
  const areas = rowStrips.map((r) => r.reduce((s, w) => s + w.w, 0))
  const counts = areas.map((a) => Math.max(1, Math.round((a / total) * n)))
  let diff = n - counts.reduce((s, c) => s + c, 0)
  for (let i = 0; diff !== 0 && i < counts.length * 4; i++) {
    const j = i % counts.length
    if (diff > 0) {
      counts[j]++
      diff--
    } else if (counts[j] > 1) {
      counts[j]--
      diff++
    }
  }
  const out: Pt[] = []
  rowStrips.forEach((r, ri) => {
    // The row's middle strip with a span: points spread along it, inset from both ends.
    const mid = r.filter((w) => w.span)[Math.floor(r.filter((w) => w.span).length / 2)]
    const span = mid?.span ?? [b.x0, b.x1]
    const y = mid?.y ?? b.cy
    const c = counts[ri]
    for (let i = 0; i < c && out.length < n; i++) out.push([span[0] + ((i + 0.5) / c) * (span[1] - span[0]), y])
  })
  while (out.length < n) out.push(polyCentroid(poly))
  return out
}

/** Fallback partition: rows of roughly equal weight, each split into columns by weight. */
export function stripCells(clip: Pt[], kids: MapNode[], value: Map<MapNode, number>): Array<[MapNode, Pt[]]> {
  const out: Array<[MapNode, Pt[]]> = []
  const box = bbox(clip)
  const weights = kids.map((k) => value.get(k) ?? 1)
  const total = weights.reduce((s, w) => s + w, 0) || 1
  const rows = Math.max(1, Math.min(kids.length, Math.round(Math.sqrt((kids.length * box.h) / Math.max(box.w, 1e-12)))))
  const perRow = Math.ceil(kids.length / rows)
  let y = box.y0
  for (let start = 0; start < kids.length; start += perRow) {
    const end = Math.min(kids.length, start + perRow)
    const rowWeight = weights.slice(start, end).reduce((s, w) => s + w, 0)
    const y1 = end === kids.length ? box.y1 : y + (box.h * rowWeight) / total
    const row = clipAxis(clipAxis(clip, 1, y, false), 1, y1, true)
    const rowBox = bbox(row)
    let x = rowBox.x0
    for (let i = start; i < end; i++) {
      const x1 = i === end - 1 ? rowBox.x1 : x + (rowBox.w * weights[i]) / (rowWeight || 1)
      out.push([kids[i], clipAxis(clipAxis(row, 0, x, false), 0, x1, true)])
      x = x1
    }
    y = y1
  }
  return out
}

function partition(clip: Pt[], kids: MapNode[], value: Map<MapNode, number>, prng: () => number): Array<[MapNode, Pt[]]> {
  if (kids.length === 1) return [[kids[0], copy(clip)]]
  const area = Math.abs(polyArea(clip))
  const box = bbox(clip)
  // The solver seeds sites by rejection sampling inside the clip, so slivers would stall it.
  const usable = clip.length >= 3 && area > 1e-9 && area / Math.max(box.w * box.h, 1e-18) > 0.02
  if (kids.length > MAX_VORONOI_SITES || !usable) return stripCells(clip, kids, value)
  try {
    return voronoiCells(clip, kids, value, prng)
  } catch {
    return stripCells(clip, kids, value)
  }
}

function hashString(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * One Voronoi treemap over the whole tree (the d3-voronoi-treemap recursion). Each container
 * seeds its own generator from its id, so a given file list always yields the same map and
 * adding a file only reshapes the territories around it. Lattice containers keep their cell
 * whole; their files are placed later by `attachCells`. Returns raw cells by node id.
 */
export function computeCells(root: MapNode): Map<string, Pt[]> {
  // Area grows sub-linearly with file count, so one huge folder cannot swallow the world.
  const value = new Map<MapNode, number>()
  const weigh = (n: MapNode): number => {
    const v = n.kids.length ? Math.pow(n.kids.reduce((s, c) => s + weigh(c), 0), 0.72) : 1
    value.set(n, v)
    return v
  }
  weigh(root)
  const cells = new Map<string, Pt[]>()
  const recurse = (clip: Pt[], node: MapNode) => {
    cells.set(node.id, clip)
    if (!node.kids.length || node.lattice) return
    for (const [kid, cell] of partition(clip, node.kids, value, seeded(SEED ^ hashString(node.id)))) recurse(cell, kid)
  }
  recurse(normalizeClip(landmass()), root)
  return cells
}

export function attachCells(tree: MapTree, cells: Map<string, Pt[]>): void {
  const visit = (n: MapNode, fallback: Pt) => {
    n.shape = null
    n.coarse = null
    n.under = null
    if (n.kind === 'file' && n.slotted) return
    n.cell = cells.get(n.id) ?? []
    n.tag = null
    n.grid = null
    const center = n.cell.length ? polyCentroid(n.cell) : fallback
    if (n.kind === 'file') {
      // Where the warped cell's centroid lands, without warping the whole outline: wiggles
      // shorter than the cell average out along its border, so only longer ones move the town.
      const size = bbox(n.cell)
      ;[n.x, n.y] = warp(center[0], center[1], Math.hypot(size.w, size.h) * 0.35)
      return
    }
    for (const kid of n.kids) kid.slotted = false
    if (n.lattice) layoutLattice(n)
    for (const kid of n.kids) visit(kid, center)
    colorSiblings(n)
  }
  visit(tree.root, [0, 0])
  // The root's own color is the world accent; recolor top-down so files and neutral
  // districts inherit their holder's final color.
  const inherit = (n: MapNode) => {
    for (const k of n.kids) {
      if (k.kind === 'file' || k.group === 'files' || k.group === 'other') k.slot = n.slot
      if (k.kind === 'dir') inherit(k)
    }
  }
  inherit(tree.root)
}

// ---------- Reading-order lattice ----------
// A container with many files lays them out like a page of a directory: a rectangle inscribed
// in the territory, filled column by column, top to bottom, in name order. Every column starts
// on the same line, so the order reads like a list however the border wiggles. The rectangle is
// sized so that at the container's reading zoom every name gets one SLOT_H_PX row and the label
// width it needs.

/** Estimated screen width of a label at 11px monospace; wide (CJK) characters count double. */
export function labelPx(text: string): number {
  let w = 0
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 11 : 6.6
  return w
}

/** Slot width in screen pixels: dot, gap, the label of a long (90th percentile) name, gutter. */
export function slotPxFor(files: MapNode[]): number {
  const widths = files.map((f) => labelPx(f.short)).sort((a, b) => a - b)
  const typical = widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.9))] ?? 80
  return Math.max(150, Math.min(320, typical + 44))
}

/** x-ranges where the horizontal line at `y` is inside the polygon. */
function scanline(poly: Pt[], y: number): Array<[number, number]> {
  const xs: number[] = []
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi))
  }
  xs.sort((a, b) => a - b)
  const out: Array<[number, number]> = []
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]])
  return out
}

function intersectRanges(a: Array<[number, number]>, b: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const [a0, a1] of a)
    for (const [b0, b1] of b) {
      const lo = Math.max(a0, b0)
      const hi = Math.min(a1, b1)
      if (hi > lo) out.push([lo, hi])
    }
  return out
}

interface Page {
  /** Slot width and height. */
  w: number
  h: number
  cols: number
  rows: number
  /** Top-left of the first slot. */
  x: number
  y: number
}

// The widest x-range inside the polygon over the whole band [y0, y1], sampled every `step`.
function bandRange(poly: Pt[], y0: number, y1: number, step: number, cache: Map<number, Array<[number, number]>>): [number, number] | null {
  let ranges: Array<[number, number]> | null = null
  for (let y = y0; ; y += step) {
    const yy = Math.min(y, y1)
    const key = Math.round(yy / step)
    let line = cache.get(key)
    if (!line) {
      line = scanline(poly, key * step)
      cache.set(key, line)
    }
    ranges = ranges ? intersectRanges(ranges, line) : line
    if (!ranges.length) return null
    if (yy >= y1) break
  }
  let best: [number, number] | null = null
  for (const r of ranges ?? []) if (!best || r[1] - r[0] > best[1] - best[0]) best = r
  return best
}

/** Places `n` slots of width `w` on one inscribed page, or null when they do not fit. */
function fitPage(poly: Pt[], b: BBox, n: number, w: number, aspect: number): Page | null {
  const h = w / aspect
  const margin = h * 0.5
  const header = h * 1.2
  const step = h / 2
  const cache = new Map<number, Array<[number, number]>>()
  const maxRows = Math.floor((b.h - margin * 2 - header) / h)
  let best: Page | null = null
  // Try every page height; keep the one closest to square that fits.
  for (let rows = Math.min(n, maxRows); rows >= 1; rows--) {
    const cols = Math.ceil(n / rows)
    const needW = cols * w + margin * 2
    if (needW > b.w) break
    const needH = rows * h + header + margin * 2
    for (let top = b.y0; top + needH <= b.y1 + 1e-9; top += step) {
      const range = bandRange(poly, top, top + needH, step, cache)
      if (!range || range[1] - range[0] < needW) continue
      const page: Page = { w, h, cols, rows, x: (range[0] + range[1]) / 2 - (cols * w) / 2, y: top + margin + header }
      if (!best || Math.abs(Math.log((cols * w) / (rows * h))) < Math.abs(Math.log((best.cols * w) / (best.rows * h)))) best = page
      break
    }
  }
  return best
}

function layoutLattice(n: MapNode): void {
  const files = n.kids
  const s = shape(n)
  const px = slotPxFor(files)
  const aspect = px / SLOT_H_PX
  // Largest slot whose page still fits inside the territory: fewer files, roomier rows. Slots
  // never grow past a quarter of the territory's width, so a district of three files still reads
  // as a short list, not three giant rows.
  let lo = Math.min(s.bb.w, s.bb.h * aspect) / 4000
  let hi = Math.min(s.bb.w * 0.45, s.bb.h * aspect * 0.3)
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2
    if (fitPage(s.poly, s.bb, files.length, mid, aspect)) lo = mid
    else hi = mid
  }
  let page = fitPage(s.poly, s.bb, files.length, lo, aspect)
  for (let w = lo * 0.9, guard = 0; !page && guard < 40; w *= 0.9, guard++) page = fitPage(s.poly, s.bb, files.length, w, aspect)
  const fallback: Page = { w: lo, h: lo / aspect, cols: 1, rows: files.length, x: s.anchor[0], y: s.anchor[1] }
  const { w, h, rows, cols, x, y } = page ?? fallback
  n.slotW = w
  n.slotPx = px
  files.forEach((f, i) => {
    const col = Math.floor(i / rows)
    const row = i % rows
    f.slotted = true
    f.cell = []
    f.x = x + col * w + h * 0.45
    f.y = y + row * h + h * 0.5
    // Label room: the slot minus the dot and its gap, keeping a small gutter to the next column.
    f.room = w - h * 0.7
  })
  n.grid = bbox([
    [x, y - h * 1.2],
    [x + cols * w, y + rows * h]
  ])
  // The name tag heads the first column inside the territory, so the prefix reads as the title
  // of its list.
  n.tag = [x, y - h * 0.68]
}

// ---------- Shapes and outlines ----------
/** Where a vertical line at `x` first enters the polygon from above. */
function topAt(poly: Pt[], x: number): number | null {
  let best: number | null = null
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (xi > x !== xj > x) {
      const y = yi + ((x - xi) * (yj - yi)) / (xj - xi)
      if (best === null || y < best) best = y
    }
  }
  return best
}

/** Warped outline, bounding box, and label anchors; computed on first use. */
export function shape(n: MapNode): Shape {
  if (!n.shape) {
    if (!n.cell.length) {
      const p: Pt = [n.x, n.y]
      n.shape = { poly: [p], bb: bbox([p]), anchor: p, top: p }
      return n.shape
    }
    const size = bbox(n.cell)
    // Coarse on purpose: this outline is for hit testing, framing, and labels. Wiggles finer
    // than the sampling step are dropped so it stays a faithful low-pass of the drawn border.
    const step = Math.max(1e-6, Math.hypot(size.w, size.h) / 60)
    const poly = organic(n.cell, step, step)
    const anchor = polyCentroid(poly)
    const b = bbox(poly)
    n.shape = { poly, bb: b, anchor, top: [anchor[0], topAt(poly, anchor[0]) ?? b.y0] }
  }
  return n.shape
}

export interface Outline {
  pts: Float64Array
  len: number
}

function toOutline(pts: Pt[]): Outline {
  const flat = new Float64Array(pts.length * 2)
  pts.forEach(([x, y], i) => {
    flat[i * 2] = x
    flat[i * 2 + 1] = y
  })
  return { pts: flat, len: pathLength(pts) }
}

// Zoom-dependent outline: sampled about every 1.4 screen px, wiggles shorter than ~7 px dropped.
// Cached per half-octave of zoom; the oldest entries are evicted first.
const LOD_CACHE = new Map<string, Outline>()
const LOD_CACHE_LIMIT = 4000
const EMPTY: Outline = { pts: new Float64Array(0), len: 0 }
const lodOf = (k: number) => Math.round(Math.log2(k) * 2) / 2
const lodKey = (n: MapNode, lod: number) => `${n.gen}:${n.id}@${lod}`

export function outlineAt(n: MapNode, k: number): Outline {
  if (n.cell.length < 3) return EMPTY
  const lod = lodOf(k)
  const key = lodKey(n, lod)
  const hit = LOD_CACHE.get(key)
  if (hit) return hit
  const kl = Math.pow(2, lod)
  const outline = toOutline(organic(n.cell, Math.max(1.4 / kl, pathLength(n.cell) / 5000), 7 / kl))
  if (LOD_CACHE.size >= LOD_CACHE_LIMIT) {
    const oldest = LOD_CACHE.keys().next().value
    if (oldest !== undefined) LOD_CACHE.delete(oldest)
  }
  LOD_CACHE.set(key, outline)
  return outline
}

/** The cached outline for this zoom, or the closest cached zoom level, without computing. */
export function peekOutline(n: MapNode, k: number): { outline: Outline; exact: boolean } | null {
  if (n.cell.length < 3) return { outline: EMPTY, exact: true }
  const lod = lodOf(k)
  const hit = LOD_CACHE.get(lodKey(n, lod))
  if (hit) return { outline: hit, exact: true }
  for (let d = 0.5; d <= 3; d += 0.5) {
    const near = LOD_CACHE.get(lodKey(n, lod - d)) ?? LOD_CACHE.get(lodKey(n, lod + d))
    if (near) return { outline: near, exact: false }
  }
  return null
}

/** A cheap stand-in used while exact outlines are still being computed. */
export function coarseOutline(n: MapNode): Outline {
  if (n.cell.length < 3) return EMPTY
  n.coarse ??= toOutline(shape(n).poly)
  return n.coarse
}

// ---------- Queries ----------
/** Every file inside a node's territory, districts and subfolders included. */
export function filesUnder(n: MapNode): MapNode[] {
  if (!n.under) {
    const out: MapNode[] = []
    const visit = (m: MapNode) => {
      for (const k of m.kids) {
        if (k.kind === 'file') out.push(k)
        else visit(k)
      }
    }
    if (n.kind === 'file') out.push(n)
    else visit(n)
    n.under = out
  }
  return n.under
}

/** Files placed directly in this folder's layer (through its districts, not subfolders). */
export function townsOf(n: MapNode): MapNode[] {
  const out: MapNode[] = []
  const visit = (m: MapNode) => {
    for (const k of m.kids) {
      if (k.kind === 'file') out.push(k)
      else if (k.virtual) visit(k)
    }
  }
  visit(n)
  return out
}

export function chainOf(n: MapNode): MapNode[] {
  const out: MapNode[] = []
  for (let c: MapNode | null = n; c; c = c.parent) out.unshift(c)
  return out
}

/** The node for a workspace-relative path, or its nearest mapped ancestor. */
export function nodeAt(tree: MapTree, rel: string): MapNode {
  let path = rel
  while (path) {
    const hit = tree.byRel.get(path)
    if (hit) return hit
    const slash = path.lastIndexOf('/')
    path = slash > 0 ? path.slice(0, slash) : ''
  }
  return tree.root
}

/** The folder a path should focus: the folder itself, or the folder holding a file. */
export function regionAt(tree: MapTree, rel: string): MapNode {
  const node = nodeAt(tree, rel)
  return node.kind === 'file' ? (node.parent ?? tree.root) : node
}

/**
 * Where a fresh map opens: the first level that actually branches. A project whose files almost
 * all sit in one folder would otherwise open on a single featureless region.
 */
export function startFocus(tree: MapTree): MapNode {
  let n = tree.root
  while (n.regions.length === 1 && !n.districts.length && n.regions[0].fileCount >= n.fileCount * 0.9) n = n.regions[0]
  return n
}
