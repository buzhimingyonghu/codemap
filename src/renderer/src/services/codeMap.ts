import { useSyncExternalStore } from 'react'
import { basename, dirname, isInside, joinPath } from '@shared/paths'
import {
  checkLibrary,
  codeOf,
  kbPath,
  prefixOf,
  repoKey,
  resolveCode,
  type CodeAnchor,
  type CodemapModel,
  type Issue,
  type LibraryCheck
} from '@shared/codemap/codemap.mjs'
import type { CodemapLayoutPatch, CodemapLoad, CodemapRead, CodemapSide } from '@shared/types'
import { monaco } from '../editor/monaco'
import { t } from '../lib/i18n'
import { getState, setState, useStore } from '../state/store'
import { getActiveEditor, getActiveTab, onDidOpen, onDidSave, openExternalFile, openFile } from './documents'
import { notify, reportError } from './ui'
import { onDidChangeFiles } from './workspace'
import { collectTodos, containersOf, defaultRoot, isMap, type MapContext, type TodoItem, type Todos } from '../codemap/model'

export type { TodoItem, Todos }

// The code map mode: loads the node library for the open folder, validates it, keeps the
// navigation stack, and connects nodes with code (reading anchors, opening them in the
// editor, finding the nodes for the code under the cursor, marking nodes whose code changed).

export type CodeMapStatus = 'idle' | 'loading' | 'ready' | 'none' | 'choose' | 'error'

export interface CodeMapData {
  status: CodeMapStatus
  root: string
  library: string | null
  candidates: string[]
  check: LibraryCheck | null
  yamlErrors: Issue[]
  /** To-dos: `issues` on nodes and the files in each folder's todo/. */
  todos: Todos
  fileCount: number
  error?: string
  stack: string[]
  flowId: string | null
  reqIndex: number
  reqOn: boolean
  /** Node id → number of changed code files under it (saved or changed on disk this session). */
  touched: Map<string, number>
  /** A node to highlight after a reveal. */
  focus: string | null
  /** Bumped whenever the layout must be recomputed from the model (save, cancel, undo, reset). */
  layoutRev: number
  version: number
}

const EMPTY: CodeMapData = {
  status: 'idle',
  root: '',
  library: null,
  candidates: [],
  check: null,
  yamlErrors: [],
  todos: { items: [], byNode: new Map(), counts: new Map() },
  fileCount: 0,
  stack: [],
  flowId: null,
  reqIndex: 0,
  reqOn: false,
  touched: new Map(),
  focus: null,
  layoutRev: 0,
  version: 0
}

let data: CodeMapData = EMPTY
const listeners = new Set<() => void>()

function update(next: Partial<CodeMapData>): void {
  data = { ...data, ...next, version: data.version + 1 }
  for (const listener of [...listeners]) listener()
}

export function getCodeMap(): CodeMapData {
  return data
}

export function subscribeCodeMap(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCodeMap(): CodeMapData {
  return useSyncExternalStore(subscribeCodeMap, getCodeMap)
}

export function mapContext(d: CodeMapData = data): MapContext | null {
  return d.check ? { check: d.check, reqIndex: d.reqIndex, reqOn: d.reqOn } : null
}

/** Every problem: YAML errors, base library issues, and each requirement's new issues. */
export function allIssues(d: CodeMapData = data): Issue[] {
  if (!d.check) return d.yamlErrors
  const out = [...d.yamlErrors, ...d.check.base.issues]
  for (const r of d.check.reqs) {
    const name = r.req.requirement?.name ?? r.req.file
    for (const issue of r.issues) out.push({ ...issue, where: `${t('Requirement')} 「${name}」 ${issue.where}` })
  }
  return out
}

// ---------- To-dos ----------
// Collected in ../codemap/model (collectTodos) when the library loads.

export function useTodoCount(): number {
  return useCodeMap().todos.items.length
}

/** Opens a to-do: a note in the editor; an issue at its code (or its node's YAML). */
export async function openTodo(item: TodoItem): Promise<void> {
  if (!data.library) return
  if (item.kind === 'note') return openInEditor(joinPath(data.library, item.file), null, dirname(joinPath(data.library, item.file)))
  const anchor = item.code && item.node && data.check ? anchorOf(data.check.model, item.node, item.code) : null
  if (anchor?.path) return openInEditor(anchor.path, anchor.lines ?? null, anchor.repoRoot)
  await openInEditor(joinPath(data.library, item.file))
}

// ---------- Remembered view per library ----------

interface SavedView {
  stack: string[]
  flowId: string | null
  reqIndex: number
  reqOn: boolean
}

const VIEW_PREFIX = 'codemap.view.v1:'

function savedView(library: string): SavedView | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEW_PREFIX + library) ?? 'null') as SavedView | null
    return parsed && Array.isArray(parsed.stack) ? parsed : null
  } catch {
    return null
  }
}

function saveView(): void {
  if (!data.library) return
  const view: SavedView = { stack: data.stack, flowId: data.flowId, reqIndex: data.reqIndex, reqOn: data.reqOn }
  localStorage.setItem(VIEW_PREFIX + data.library, JSON.stringify(view))
}

// ---------- Loading ----------

let requestId = 0
let lastLoad: CodemapLoad | null = null

// ---------- AI change set preview ----------
// A change set the assistant proposed shows on the map as one more requirement (named with a
// leading ✦), using the same added / changed / removed marks. New whole files are merged in as
// extra node and link documents. Nothing is written until the user applies it.

export interface PreviewSet {
  id: string
  title: string
  changes: Record<string, unknown>[]
  docs: { file: string; node: Record<string, any> }[]
  links: { file: string; data: Record<string, any> }[]
}

let preview: PreviewSet | null = null

export function previewId(): string | null {
  return preview?.id ?? null
}

/** Shows (or clears with null) an AI change set as a requirement layer on the map. */
export function setPreview(next: PreviewSet | null): void {
  preview = next
  if (!lastLoad) return
  applyLoad(lastLoad, false)
  if (next && data.check) {
    const index = data.check.reqs.findIndex((r) => r.req.file === PREVIEW_FILE)
    if (index >= 0) update({ reqIndex: index, reqOn: true })
  } else if (!next && data.reqOn && data.check && !data.check.reqs[data.reqIndex]) update({ reqOn: false, reqIndex: 0 })
}

const PREVIEW_FILE = '(AI proposal)'

function withPreview(load: CodemapLoad): Pick<CodemapLoad, 'docs' | 'links' | 'requirements'> {
  if (!preview) return load
  const docs = [...load.docs]
  for (const d of preview.docs) {
    const i = docs.findIndex((x) => x.file === d.file)
    if (i >= 0) docs.splice(i, 1, d)
    else docs.push(d)
  }
  const links = [...load.links]
  for (const l of preview.links) {
    const i = links.findIndex((x) => x.file === l.file)
    if (i >= 0) links.splice(i, 1, l)
    else links.push(l)
  }
  const req = { file: PREVIEW_FILE, requirement: { id: `ai-${preview.id}`, name: `✦ ${preview.title}`, status: 'designing' }, changes: preview.changes }
  return { docs, links, requirements: [...load.requirements, req] }
}

function applyLoad(load: CodemapLoad, quiet: boolean): void {
  lastLoad = load
  const root = getState().workspace?.root ?? ''
  if (load.status !== 'ready' || !load.library) {
    update({ ...EMPTY, status: load.status, root, candidates: load.candidates, version: data.version })
    rebuildIndex()
    return
  }
  const merged = withPreview(load)
  const check = checkLibrary(merged.docs, merged.requirements, merged.links)
  const sameLibrary = data.library === load.library
  // An open layout edit survives a reload: keep the draft on top of the new file contents.
  const keepDraft = editing && sameLibrary ? { map: editing.map, state: snapshotOf(editing.map) } : null
  if (editing && !sameLibrary) editing = null
  const remembered = sameLibrary ? { stack: data.stack, flowId: data.flowId, reqIndex: data.reqIndex, reqOn: data.reqOn } : savedView(load.library)
  const ctx: MapContext = { check, reqIndex: remembered?.reqIndex ?? 0, reqOn: remembered?.reqOn ?? false }
  if (ctx.reqIndex >= check.reqs.length) ctx.reqIndex = 0
  if (!check.reqs.length) ctx.reqOn = false
  let stack = (remembered?.stack ?? []).filter((id) => isMap(ctx, id))
  if (!stack.length) {
    const root0 = defaultRoot(check)
    stack = root0 ? [root0] : []
  }
  update({
    status: 'ready',
    root,
    library: load.library,
    candidates: load.candidates,
    check,
    yamlErrors: load.errors,
    todos: collectTodos(check, load.todos ?? []),
    fileCount: load.fileCount,
    error: undefined,
    stack,
    flowId: sameLibrary || stack.join('/') === (remembered?.stack ?? []).join('/') ? (remembered?.flowId ?? null) : null,
    reqIndex: ctx.reqIndex,
    reqOn: ctx.reqOn,
    touched: sameLibrary ? data.touched : new Map()
  })
  if (editing && keepDraft) {
    const session = editing
    const entry = mapEntry(keepDraft.map)
    if (!entry || !keepDraft.state) endSession(session)
    else {
      session.start = snapshot(entry.node)
      applyToModel(entry.node, keepDraft.state)
      update({ reqOn: false, layoutRev: data.layoutRev + 1 })
    }
  }
  rebuildIndex()
  if (quiet && sameLibrary) notify(t('Code map updated'), 'info')
}

async function run(task: () => Promise<CodemapLoad | null>, quiet = false): Promise<void> {
  const id = ++requestId
  if (!quiet && data.status !== 'ready') update({ status: 'loading', error: undefined })
  try {
    const load = await task()
    if (id !== requestId || !load) {
      if (id === requestId && data.status === 'loading') update({ status: 'idle' })
      return
    }
    applyLoad(load, quiet)
  } catch (error) {
    if (id !== requestId) return
    const message = error instanceof Error ? error.message : String(error)
    if (data.status === 'ready') reportError(error, t('Cannot load the code map'))
    else update({ status: 'error', error: message })
  }
}

/** Loads the code map for the open folder; cheap when it is already loaded. */
export function ensureCodeMap(force = false): Promise<void> {
  const root = getState().workspace?.root
  if (!root) return Promise.resolve()
  if (!force && data.root === root && (data.status === 'ready' || data.status === 'loading')) return Promise.resolve()
  return run(() => window.codemap.codemap.load())
}

export function reloadCodeMap(): Promise<void> {
  return run(() => window.codemap.codemap.load())
}

export function chooseLibrary(): Promise<void> {
  return run(() => window.codemap.codemap.chooseLibrary())
}

export function createLibrary(): Promise<void> {
  return run(() => window.codemap.codemap.createLibrary())
}

export function useLibrary(path: string): Promise<void> {
  return run(() => window.codemap.codemap.useLibrary(path))
}

// ---------- Navigation ----------

export function setNavigation(stack: string[], flowId: string | null, focus: string | null = null): void {
  update({ stack, flowId, focus })
  saveView()
}

export function setFlow(flowId: string | null): void {
  update({ flowId })
  saveView()
}

/** Turns the requirement layer on for requirement `index`, or off when it is already on. */
export function toggleRequirement(index: number): void {
  // Layout is arranged on the base map; the requirement layer stays off while editing.
  if (editing) {
    if (!(data.reqOn && data.reqIndex === index)) notify(t('Finish editing the layout to show a requirement'), 'info')
    return
  }
  if (data.reqOn && data.reqIndex === index) update({ reqOn: false })
  else update({ reqIndex: index, reqOn: true })
  saveView()
}

export function clearFocus(): void {
  if (data.focus) update({ focus: null })
}

// ---------- Hand-arranged layout ----------
// Positions live in the map's own YAML: `layout: { node: [x, y] }` on the map node and
// `ports: [from, to]` on edges. Arranging happens in an explicit edit session: drags change a
// draft in the loaded model (the view does not reload or jump), ⌘Z undoes within the draft,
// Save writes the difference once, and Cancel puts back what the file says.

interface LayoutState {
  layout: Record<string, [number, number]> | null
  ports: Record<string, [CodemapSide | null, CodemapSide | null] | null>
}

interface EditSession {
  map: string
  /** What the file says (the state Cancel returns to and Save compares against). */
  start: LayoutState
  undo: LayoutState[]
  saving: boolean
  /** Whether the requirement layer was on before editing; it is turned back on afterwards. */
  reqOn: boolean
}

let editing: EditSession | null = null

/** The map being arranged, or null when no edit session is open. */
export function editingMap(): string | null {
  return editing?.map ?? null
}

export function isSavingLayout(): boolean {
  return Boolean(editing?.saving)
}

export function canUndoLayout(map: string): boolean {
  return editing?.map === map && editing.undo.length > 0
}

/** The map node object in the loaded model (the one parsed from its file), and that file. */
function mapEntry(map: string): { node: Record<string, any>; file: string } | null {
  const entry = data.check?.model.nodes.get(map)
  if (!entry || (entry.how !== 'file' && entry.how !== 'contains')) return null
  return { node: entry.node, file: entry.file }
}

/** How an edge is keyed in the file: its `id`, else `from->to` exactly as written. */
export function edgeFileKey(edge: Record<string, any>): string {
  return typeof edge.id === 'string' ? edge.id : `${edge.from}->${edge.to}`
}

function snapshot(node: Record<string, any>): LayoutState {
  const ports: LayoutState['ports'] = {}
  // `auto` (or anything that is not a side) is the same as no side.
  const side = (s: unknown): CodemapSide | null => (s === 'top' || s === 'bottom' || s === 'left' || s === 'right' ? s : null)
  for (const e of (node.edges ?? []) as Record<string, any>[]) {
    const p: [CodemapSide | null, CodemapSide | null] | null = Array.isArray(e.ports) ? [side(e.ports[0]), side(e.ports[1])] : null
    ports[edgeFileKey(e)] = p && (p[0] || p[1]) ? p : null
  }
  return { layout: node.layout ? structuredClone(node.layout) : null, ports }
}

function snapshotOf(map: string): LayoutState | null {
  const entry = mapEntry(map)
  return entry ? snapshot(entry.node) : null
}

function applyToModel(node: Record<string, any>, state: LayoutState): void {
  if (state.layout && Object.keys(state.layout).length) node.layout = structuredClone(state.layout)
  else delete node.layout
  for (const e of (node.edges ?? []) as Record<string, any>[]) {
    const p = state.ports[edgeFileKey(e)]
    if (p === undefined) continue
    if (p) e.ports = p[1] ? [p[0] ?? 'auto', p[1]] : [p[0] ?? 'auto']
    else delete e.ports
  }
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** The file patch that turns `from` into `to`; null when nothing changed. */
function diffPatch(map: string, from: LayoutState, to: LayoutState): CodemapLayoutPatch | null {
  const patch: CodemapLayoutPatch = { map }
  if (!sameJson(from.layout, to.layout)) patch.layout = to.layout && Object.keys(to.layout).length ? to.layout : null
  const ports: NonNullable<CodemapLayoutPatch['ports']> = {}
  for (const key of new Set([...Object.keys(from.ports), ...Object.keys(to.ports)])) {
    if (!sameJson(from.ports[key], to.ports[key])) ports[key] = to.ports[key] ?? null
  }
  if (Object.keys(ports).length) patch.ports = ports
  return patch.layout !== undefined || patch.ports ? patch : null
}

/** Closes the edit session, turns the requirement layer back on if it was, and re-lays out. */
function endSession(session: EditSession): void {
  if (editing === session) editing = null
  update({ reqOn: session.reqOn && Boolean(data.check?.reqs.length), layoutRev: data.layoutRev + 1 })
  saveView()
}

/** Changes the draft of the open edit session (nothing is written until Save). */
function draft(map: string, next: (before: LayoutState) => LayoutState): void {
  const entry = mapEntry(map)
  if (!entry || editing?.map !== map || editing.saving) return
  const before = snapshot(entry.node)
  const after = next(before)
  if (sameJson(before, after)) return
  editing.undo = [...editing.undo.slice(-49), before]
  applyToModel(entry.node, after)
  update({ layoutRev: data.layoutRev + 1 })
}

/** Starts arranging `map`; ends any session open on another map without saving. */
export function startLayoutEdit(map: string): void {
  const entry = mapEntry(map)
  if (!entry || !canEditLayout(map)) return
  if (editing && editing.map !== map) cancelLayoutEdit()
  if (editing?.map === map) return
  // Positions belong to the base map: arrange it with the requirement layer off.
  editing = { map, start: snapshot(entry.node), undo: [], saving: false, reqOn: data.reqOn }
  update({ reqOn: false, layoutRev: data.layoutRev + 1 })
}

export function isLayoutDirty(): boolean {
  if (!editing) return false
  const entry = mapEntry(editing.map)
  return Boolean(entry && diffPatch(editing.map, editing.start, snapshot(entry.node)))
}

/** Writes the draft into the map YAML in one go and closes the session. False when it failed. */
export async function saveLayoutEdit(): Promise<boolean> {
  const session = editing
  if (!session || session.saving) return false
  const entry = mapEntry(session.map)
  if (!entry) {
    endSession(session)
    return true
  }
  const current = snapshot(entry.node)
  const patch = diffPatch(session.map, session.start, current)
  if (patch) {
    session.saving = true
    update({})
    try {
      await window.codemap.codemap.writeLayout(entry.file, patch)
    } catch (error) {
      // Keep editing so the arrangement is not lost; the user can retry or cancel.
      session.saving = false
      update({})
      reportError(error, t('Cannot save the layout'))
      return false
    }
  }
  endSession(session)
  return true
}

/** Drops the draft: the map goes back to what its file says. */
export function cancelLayoutEdit(): void {
  const session = editing
  if (!session) return
  const entry = mapEntry(session.map)
  if (entry) applyToModel(entry.node, session.start)
  endSession(session)
}

/**
 * Before leaving the map being arranged: unsaved changes ask Save / Don't Save / Cancel.
 * Resolves true when it is fine to leave (the session is closed then).
 */
export async function confirmLeaveLayoutEdit(): Promise<boolean> {
  if (!editing) return true
  if (!isLayoutDirty()) {
    cancelLayoutEdit()
    return true
  }
  const choice = await window.codemap.app.confirm({
    message: t('Save the layout of this map?'),
    detail: t('You moved nodes or edge ends that are not saved yet.'),
    buttons: [t('Save'), t("Don't Save"), t('Cancel')],
    cancelId: 2,
    // Return keeps editing; saving takes a deliberate click.
    defaultId: 2
  })
  if (choice === 0) return saveLayoutEdit()
  if (choice === 1) {
    cancelLayoutEdit()
    return true
  }
  return false
}

/**
 * Records node positions after a drag. The first drag on a map freezes every node where it is,
 * so the rest of the map no longer moves when the window size changes.
 */
export function saveNodePositions(map: string, positions: Record<string, [number, number]>): void {
  draft(map, (before) => {
    const layout = { ...(before.layout ?? {}) }
    for (const [key, [x, y]] of Object.entries(positions)) layout[key] = [Math.round(x), Math.round(y)]
    return { ...before, layout }
  })
}

export function saveEdgePorts(map: string, edgeKey: string, ports: [CodemapSide | null, CodemapSide | null] | null): void {
  const value = ports && (ports[0] || ports[1]) ? ports : null
  draft(map, (before) => ({ ...before, ports: { ...before.ports, [edgeKey]: value } }))
}

/** Back to the automatic layout in the draft: no `layout`, no `ports`. */
export function resetLayout(map: string): void {
  draft(map, (before) => ({ layout: null, ports: Object.fromEntries(Object.keys(before.ports).map((k) => [k, null])) }))
}

export function undoLayout(map: string): void {
  const entry = mapEntry(map)
  if (!entry || editing?.map !== map || editing.saving) return
  const prev = editing.undo.pop()
  if (!prev) return
  applyToModel(entry.node, prev)
  update({ layoutRev: data.layoutRev + 1 })
}

/** Whether the map's file can be written (it is inside the open folder). */
export function canEditLayout(map: string): boolean {
  const entry = mapEntry(map)
  const root = getState().workspace?.root
  return Boolean(entry && root && data.library && isInside(root, joinPath(data.library, entry.file)))
}

// ---------- Editing a node's text ----------
// The detail panel edits name, brief, desc, fn.trigger and fn.outcome of a node defined in this
// library. The write goes to the node's own YAML; the library reloads and re-checks after it.

export type NodeField = 'name' | 'brief' | 'desc' | 'fn.trigger' | 'fn.outcome'

/** Why a node's text cannot be edited, or null when it can. */
export function nodeEditBlock(id: string): 'outside' | 'not-here' | 'layout' | null {
  const entry = data.check?.model.nodes.get(id)
  if (!entry || (entry.how !== 'file' && entry.how !== 'contains')) return 'not-here'
  const root = getState().workspace?.root
  if (!root || !data.library || !isInside(root, joinPath(data.library, entry.file))) return 'outside'
  if (editing) return 'layout'
  return null
}

/** The file a node is defined in (relative to the library). */
export function nodeFile(id: string): string | null {
  return data.check?.model.nodes.get(id)?.file ?? null
}

/** Writes the changed fields of `id`. Resolves true when saved. */
export async function saveNodeFields(id: string, fields: Partial<Record<NodeField, string | null>>): Promise<boolean> {
  const entry = data.check?.model.nodes.get(id)
  if (!entry || nodeEditBlock(id)) return false
  if (!Object.keys(fields).length) return true
  try {
    await window.codemap.codemap.writeNode(entry.file, { node: id, fields })
  } catch (error) {
    reportError(error, t('Cannot save the node'))
    return false
  }
  // Reload at once so the checks and the map show the new text.
  await reloadCodeMap()
  return true
}

// ---------- Mode ----------

export function showCodeMap(): void {
  if (getState().explorerMode !== 'codemap') setState({ explorerMode: 'codemap', mapEditorOpen: false })
  else if (getState().mapEditorOpen) setState({ mapEditorOpen: false })
  void ensureCodeMap()
}

/** ⇧⌘Y: open the code map, or flip between it and the editor. */
export function toggleCodeMap(): void {
  const state = getState()
  if (!state.workspace) return
  if (state.explorerMode !== 'codemap') showCodeMap()
  else if (state.mapEditorOpen) setState({ mapEditorOpen: false })
  else if (state.tabs.length) setState({ mapEditorOpen: true })
}

// ---------- Code anchors ----------

export interface Anchor extends CodeAnchor {
  /** Absolute file path, or null when the repository has no local folder. */
  path: string | null
  /** Absolute repository folder (what gets granted). */
  repoRoot: string | null
  /** File as written: the full path from the repository root. */
  display: string
  /** Short repository name for labels (last part of the remote). */
  repoName: string
}

const REPO_PREFIX = 'codemap.repos.v1:'

// Folders picked for repositories without `local`, keyed by repository identity (remote).
function linkedRepos(): Record<string, string> {
  if (!data.library) return {}
  try {
    return JSON.parse(localStorage.getItem(REPO_PREFIX + data.library) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

/** Remembers a local folder for a repository that has no `repo.local` (this Mac only). */
export async function linkRepository(remote: string): Promise<void> {
  if (!data.library) return
  const key = repoKey({ remote })
  if (!key) return
  const picked = await window.codemap.codemap.pickRepository()
  if (!picked) return
  const repos = linkedRepos()
  repos[key] = picked
  localStorage.setItem(REPO_PREFIX + data.library, JSON.stringify(repos))
  rebuildIndex()
  update({})
}

/**
 * Where a node's code is on disk. The repository is the one written next to the code
 * (`fn.repo`, or `repo` on a data entry); code is a full path from the repository root.
 */
export function anchorOf(model: CodemapModel, id: string, code?: unknown): Anchor | null {
  const a = code === undefined ? resolveCode(model, id) : resolveCode(model, id, code)
  if (!a || !data.library) return null
  const display = a.file ?? ''
  const key = repoKey({ remote: a.remote ?? undefined })
  const linked = key ? linkedRepos()[key] : undefined
  const repoRoot = a.local ? joinPath(data.library, a.local) : (linked ?? null)
  const repoName = (a.remote ?? '').replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() ?? ''
  return { ...a, display, repoName, repoRoot, path: repoRoot && a.file ? joinPath(repoRoot, a.file) : null }
}

export function libraryPath(rel: string): string | null {
  return data.library ? joinPath(data.library, rel) : null
}

// Folders the user declined this session: ask again only from an explicit button.
const declined = new Set<string>()
// Several code blocks can need one folder at once; they share a single dialog.
const pendingAccess = new Map<string, Promise<boolean>>()

export async function requestAccess(folder: string): Promise<boolean> {
  const pending = pendingAccess.get(folder)
  if (pending) return pending
  const request = window.codemap.codemap
    .requestAccess(folder, 'code')
    .then((granted) => {
      if (granted) declined.delete(folder)
      else declined.add(folder)
      return granted
    })
    .finally(() => pendingAccess.delete(folder))
  pendingAccess.set(folder, request)
  return request
}

const readCache = new Map<string, Promise<CodemapRead>>()

/**
 * Reads a file for the code map. Outside the open folder this asks once (native dialog) to
 * allow the repository folder. A folder declined this session is only asked about again
 * when the read comes from an explicit action (`ask`).
 */
export async function readForMap(path: string, grantFolder: string | null, ask = false): Promise<CodemapRead> {
  const cached = readCache.get(path)
  if (cached) return cached
  const attempt = (async () => {
    let result = await window.codemap.codemap.read(path)
    if (!result.ok && result.reason === 'access') {
      const folder = grantFolder ?? result.folder
      if ((ask || !declined.has(folder)) && (await requestAccess(folder))) result = await window.codemap.codemap.read(path)
      else result = { ok: false, reason: 'access', folder }
    }
    return result
  })()
  readCache.set(path, attempt)
  const result = await attempt
  // Only successful reads are cached; a declined grant can be retried.
  if (!result.ok) readCache.delete(path)
  return result
}

function forgetReads(paths: string[]): void {
  for (const path of paths) readCache.delete(path)
}

/** Opens a file in the editor (read-only outside the open folder) and raises the editor over the map. */
export async function openInEditor(path: string, lines?: [number, number] | null, grantFolder?: string | null): Promise<void> {
  const root = getState().workspace?.root
  const target = lines ? { line: lines[0], endLine: lines[1] } : undefined
  if (root && isInside(root, path)) await openFile(path, target)
  else {
    const read = await readForMap(path, grantFolder ?? dirname(path), true)
    if (!read.ok) {
      if (read.reason !== 'access') notify(t('Cannot open {name}', { name: basename(path) }), 'error', read.message)
      return
    }
    await openExternalFile(path, target)
  }
  if (getState().activeTabId === path && getState().explorerMode === 'codemap') setState({ mapEditorOpen: true })
}

/** A knowledge-base entry: web links open in the browser, paths in the editor. */
export async function openKnowledge(url: string, nodeFile: string | null): Promise<void> {
  if (/^https?:\/\//i.test(url)) {
    window.open(url, '_blank', 'noopener')
    return
  }
  const rel = url.startsWith('/') ? url : kbPath(url, nodeFile ?? '')
  const path = rel.startsWith('/') ? rel : libraryPath(rel)
  if (path) await openInEditor(path, null, dirname(path))
}

/** Opens the YAML file behind a validation issue, near the id it mentions. */
export async function openIssue(issue: Issue): Promise<void> {
  const file = issue.where.split(' ')[0]
  const path = /\.ya?ml$/.test(file) ? libraryPath(file) : null
  if (!path) return
  const read = await window.codemap.codemap.read(path)
  let line: number | undefined
  if (read.ok) {
    const words = issue.where.split(' ').slice(1).reverse()
    const lines = read.text.split('\n')
    for (const word of words) {
      const needles = word
        .split('->')
        .map((part) => part.split('.').pop() ?? part)
        .filter((needle) => needle.length > 1)
      const index = needles.length ? lines.findIndex((text) => needles.every((needle) => text.includes(needle))) : -1
      if (index >= 0) {
        line = index + 1
        break
      }
    }
  }
  await openInEditor(path, line ? [line, line] : null)
}

// ---------- Code → nodes ----------

interface IndexedAnchor {
  id: string
  lines: [number, number] | null
}

let codeIndex = new Map<string, IndexedAnchor[]>()

function rebuildIndex(): void {
  const next = new Map<string, IndexedAnchor[]>()
  const check = data.check
  if (check) {
    for (const [id, entry] of check.model.nodes) {
      if (codeOf(entry.node) === undefined || entry.how === 'missing') continue
      const anchor = anchorOf(check.model, id)
      if (!anchor?.path) continue
      const list = next.get(anchor.path) ?? []
      list.push({ id, lines: anchor.lines })
      next.set(anchor.path, list)
    }
  }
  codeIndex = next
  readCache.clear()
}

/** Nodes whose code is in `path`; those covering `line` first, smallest range first. */
export function nodesForCode(path: string, line?: number): string[] {
  const list = codeIndex.get(path) ?? []
  const covers = (a: IndexedAnchor) => Boolean(line && a.lines && a.lines[0] <= line && line <= a.lines[1])
  const span = (a: IndexedAnchor) => (a.lines ? a.lines[1] - a.lines[0] : Number.MAX_SAFE_INTEGER)
  return list
    .slice()
    .sort((a, b) => Number(covers(b)) - Number(covers(a)) || span(a) - span(b))
    .filter((a, _i, all) => !line || !all.some(covers) || covers(a))
    .map((a) => a.id)
}

/** The map to open for `id`: the node itself when it is a map, else a map that contains it. */
function mapFor(ctx: MapContext, id: string): string | null {
  for (let current: string | null = id; current; current = prefixOf(current)) {
    const ups = containersOf(ctx, current)
    if (current !== id && isMap(ctx, current)) return current
    if (ups.length) return ups[0]
  }
  return isMap(ctx, id) ? id : null
}

/** Editor action: show the node for the code under the cursor. */
export async function revealCodeInMap(): Promise<void> {
  const tab = getActiveTab()
  const position = getActiveEditor()?.getPosition()
  if (tab?.kind !== 'file' || !tab.path) return
  showCodeMap()
  await ensureCodeMap()
  const ctx = mapContext()
  if (!ctx) return
  const ids = nodesForCode(tab.path, position?.lineNumber)
  if (!ids.length) {
    notify(t('No code map node points at this code'), 'info')
    return
  }
  const target = ids[0]
  const map = mapFor(ctx, target)
  if (!map) return
  setState({ mapEditorOpen: false })
  setNavigation([map], null, target)
}

function markTouched(paths: string[]): void {
  const ctx = mapContext()
  if (!ctx) return
  forgetReads(paths)
  const touched = new Map(data.touched)
  let changed = false
  for (const path of paths) {
    for (const { id } of codeIndex.get(path) ?? []) {
      // Count the node and, once each, every map above it.
      const seen = new Set<string>([id])
      const queue = [id]
      while (queue.length) {
        const current = queue.shift()!
        const ups = [...containersOf(ctx, current)]
        const owner = prefixOf(current)
        if (owner && !ups.length) ups.push(owner)
        for (const up of ups) if (!seen.has(up)) seen.add(up), queue.push(up)
      }
      for (const node of seen) touched.set(node, (touched.get(node) ?? 0) + 1)
      changed = true
    }
  }
  if (changed) update({ touched })
}

export function clearTouched(): void {
  update({ touched: new Map() })
}

// ---------- Wiring ----------

let initialized = false

export function initCodeMap(): void {
  if (initialized) return
  initialized = true

  window.codemap.codemap.onChange(() => {
    if (data.library) void run(() => window.codemap.codemap.load(), true)
  })

  onDidSave.on((path) => markTouched([path]))
  onDidChangeFiles.on((paths) => markTouched(paths))

  onDidOpen.on(() => {
    if (getState().explorerMode === 'codemap' && !getState().mapEditorOpen) setState({ mapEditorOpen: true })
  })

  useStore.subscribe((state, previous) => {
    if (state.workspace?.root !== previous.workspace?.root) {
      requestId++
      data = { ...EMPTY, version: data.version + 1 }
      codeIndex = new Map()
      readCache.clear()
      for (const listener of [...listeners]) listener()
      if (state.workspace && state.explorerMode === 'codemap') void ensureCodeMap()
    }
    if (state.explorerMode !== 'codemap') return
    if (state.activeTabId && state.activeTabId !== previous.activeTabId && !state.mapEditorOpen) setState({ mapEditorOpen: true })
    else if (!state.tabs.length && state.mapEditorOpen) setState({ mapEditorOpen: false })
  })

  monaco.editor.addEditorAction({
    id: 'codemap.reveal',
    label: t('Show in Code Map'),
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 9,
    run: () => revealCodeInMap()
  })
}
