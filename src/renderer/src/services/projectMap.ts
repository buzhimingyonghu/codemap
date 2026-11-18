import { useSyncExternalStore } from 'react'
import { basename, isInside } from '@shared/paths'
import { Emitter } from '../lib/events'
import type { Pt } from '../map/geo'
import LayoutWorker from '../map/layout.worker?worker'
import type { LayoutRequest, LayoutResponse } from '../map/layout.worker'
import { applyChurn, attachCells, buildTree, computeCells, computeHeat, decayedScore, folderKey, frequentFolders, type MapNode, type MapTree, type UsageMap } from '../map/model'
import { getState, setState, useStore, type ExplorerMode } from '../state/store'
import { handleRenamed, onDidOpen, openFile } from './documents'
import { confirm, prompt, reportError } from './ui'
import { t } from '../lib/i18n'
import { createEntry, deleteEntry, loadChildren, onDidChangeFiles, revealInTree } from './workspace'

// The explorer's map mode: loads the project index, lays out territories in a worker, keeps
// per-folder usage history for heat, and coordinates the map with the editor.

export interface MapData {
  root: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  tree: MapTree | null
  fileCount: number
  truncated: boolean
  error?: string
  /** Bumped when heat changes on the same tree. */
  heatVersion: number
}

let data: MapData = { root: '', status: 'idle', tree: null, fileCount: 0, truncated: false, heatVersion: 0 }
const listeners = new Set<() => void>()

function update(next: Partial<MapData>): void {
  data = { ...data, ...next }
  for (const listener of [...listeners]) listener()
}

export function subscribeMap(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getMapData(): MapData {
  return data
}

export function useMapData(): MapData {
  return useSyncExternalStore(subscribeMap, getMapData)
}

export function toAbsolute(root: string, rel: string): string {
  return rel ? `${root}/${rel}` : root
}

export function toRelative(root: string, path: string): string | null {
  if (path === root) return ''
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null
}

// ---------- Usage history (heat) ----------
const USAGE_PREFIX = 'map.usage.v1:'
const USAGE_LIMIT = 4000
const REPEAT_WINDOW_MS = 2000
let usage: { root: string; map: UsageMap } | null = null
let lastRecorded = { path: '', at: 0 }

function usageFor(root: string): UsageMap {
  if (usage?.root !== root) {
    let map: UsageMap = {}
    try {
      const parsed = JSON.parse(localStorage.getItem(USAGE_PREFIX + root) ?? '{}') as unknown
      if (parsed && typeof parsed === 'object') map = parsed as UsageMap
    } catch {
      map = {}
    }
    usage = { root, map }
  }
  return usage.map
}

function saveUsage(root: string, map: UsageMap): void {
  const now = Date.now()
  const keys = Object.keys(map)
  if (keys.length > USAGE_LIMIT) {
    keys.sort((a, b) => decayedScore(map[a], now) - decayedScore(map[b], now))
    for (const key of keys.slice(0, keys.length - USAGE_LIMIT)) delete map[key]
  }
  try {
    localStorage.setItem(USAGE_PREFIX + root, JSON.stringify(map))
  } catch {
    // Storage full: heat simply stops learning; nothing else depends on it.
  }
}

function refreshHeat(): void {
  if (!data.tree) return
  computeHeat(data.tree, usageFor(data.root), Date.now())
  update({ heatVersion: data.heatVersion + 1 })
}

function bumpUsage(root: string, key: string): void {
  const now = Date.now()
  if (lastRecorded.path === key && now - lastRecorded.at < REPEAT_WINDOW_MS) return
  lastRecorded = { path: key, at: now }
  const map = usageFor(root)
  const previous = map[key]
  map[key] = previous ? { score: decayedScore(previous, now) + 1, count: previous.count + 1, at: now } : { score: 1, count: 1, at: now }
  saveUsage(root, map)
  if (data.root === root) refreshHeat()
}

/** Counts an open toward the file's heat. Repeated opens of one file within 2 s count once. */
export function recordOpen(path: string): void {
  const root = getState().workspace?.root
  if (!root) return
  const rel = toRelative(root, path)
  if (rel) bumpUsage(root, rel)
}

/** Counts entering a folder on the map (by click, trail, or jump; not by wheel dives). */
export function recordVisit(rel: string): void {
  const root = getState().workspace?.root
  if (root && rel) bumpUsage(root, folderKey(rel))
}

/** Folders entered most often, best first. */
export function frequentMapFolders(tree: MapTree, limit: number): MapNode[] {
  return frequentFolders(tree, usageFor(data.root), Date.now(), limit)
}

export function resetUsage(): void {
  const root = getState().workspace?.root
  if (!root) return
  localStorage.removeItem(USAGE_PREFIX + root)
  usage = { root, map: {} }
  if (data.root === root) refreshHeat()
}

/** Carries usage history along when a file or folder is renamed. */
function moveUsage(from: string, to: string): void {
  const root = getState().workspace?.root
  if (!root) return
  const fromRel = toRelative(root, from)
  const toRel = toRelative(root, to)
  if (!fromRel || !toRel) return
  const map = usageFor(root)
  let moved = false
  for (const key of Object.keys(map)) {
    if (key !== fromRel && !key.startsWith(`${fromRel}/`)) continue
    map[toRel + key.slice(fromRel.length)] = map[key]
    delete map[key]
    moved = true
  }
  if (moved) saveUsage(root, map)
}

// ---------- Layout ----------
let worker: Worker | null = null
let workerBroken = false
let workerSeq = 0
const pendingLayouts = new Map<number, { resolve: (cells: Map<string, Pt[]>) => void; reject: (error: Error) => void }>()

/** Where territories were last laid out; reported to end-to-end tests. */
export function layoutThread(): 'worker' | 'main' {
  return workerBroken ? 'main' : 'worker'
}

function unpack(cells: Array<[string, Float64Array]>): Map<string, Pt[]> {
  const out = new Map<string, Pt[]>()
  for (const [key, flat] of cells) {
    const poly: Pt[] = []
    for (let i = 0; i + 1 < flat.length; i += 2) poly.push([flat[i], flat[i + 1]])
    out.set(key, poly)
  }
  return out
}

function failWorker(error: Error): void {
  worker?.terminate()
  worker = null
  workerBroken = true
  for (const pending of pendingLayouts.values()) pending.reject(error)
  pendingLayouts.clear()
}

function layoutInWorker(name: string, files: string[]): Promise<Map<string, Pt[]>> {
  if (!worker) {
    worker = new LayoutWorker()
    worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
      const pending = pendingLayouts.get(event.data.id)
      if (!pending) return
      pendingLayouts.delete(event.data.id)
      if ('error' in event.data) pending.reject(new Error(event.data.error))
      else pending.resolve(unpack(event.data.cells))
    }
    worker.onerror = (event) => {
      event.preventDefault()
      failWorker(new Error(event.message || 'Map layout worker failed'))
    }
  }
  const id = ++workerSeq
  const request: LayoutRequest = { id, name, files }
  return new Promise((resolve, reject) => {
    pendingLayouts.set(id, { resolve, reject })
    worker?.postMessage(request)
  })
}

async function layoutCells(name: string, files: string[]): Promise<Map<string, Pt[]>> {
  if (!workerBroken) {
    try {
      return await layoutInWorker(name, files)
    } catch (error) {
      if (!workerBroken) throw error
    }
  }
  // No worker available: same computation on this thread, after the loading state has painted.
  await new Promise((resolve) => window.setTimeout(resolve, 30))
  return computeCells(buildTree(name, files).root)
}

let requestId = 0
let signature = ''
let stale = false

/** Loads (or refreshes) the map for the open folder. Cheap when nothing changed. */
export async function ensureMap(force = false): Promise<void> {
  const workspace = getState().workspace
  if (!workspace) return
  const sameRoot = data.root === workspace.root
  if (!force && !stale && sameRoot && (data.status === 'ready' || data.status === 'loading')) return
  stale = false
  const id = ++requestId
  if (!sameRoot) {
    signature = ''
    update({ root: workspace.root, status: 'loading', tree: null, fileCount: 0, truncated: false, error: undefined })
  } else if (!data.tree) {
    update({ status: 'loading', error: undefined })
  }
  try {
    const index = await window.codemap.fs.mapIndex()
    if (id !== requestId) return
    const nextSignature = index.files.join('\n')
    if (data.tree && nextSignature === signature) {
      applyChurn(data.tree, index.churn)
      refreshHeat()
      return
    }
    if (!data.tree) update({ fileCount: index.files.length })
    const cells = await layoutCells(workspace.name, index.files)
    if (id !== requestId) return
    const tree = buildTree(workspace.name, index.files)
    attachCells(tree, cells)
    applyChurn(tree, index.churn)
    computeHeat(tree, usageFor(workspace.root), Date.now())
    signature = nextSignature
    update({ status: 'ready', tree, fileCount: index.files.length, truncated: index.truncated, error: undefined })
  } catch (error) {
    if (id !== requestId) return
    const message = error instanceof Error ? error.message : String(error)
    update({ status: data.tree ? 'ready' : 'error', error: message })
  }
}

// ---------- Mode and editor coordination ----------
let lastFocus = { root: '', rel: '' }

export function rememberFocus(root: string, rel: string): void {
  lastFocus = { root, rel }
}

/** The folder the map last showed for this workspace, or null on a fresh start. */
export function rememberedFocus(root: string): string | null {
  return lastFocus.root === root ? lastFocus.rel : null
}

export function setExplorerMode(mode: ExplorerMode): void {
  if (getState().explorerMode === mode) return
  setState({ explorerMode: mode, mapEditorOpen: false })
  if (mode === 'map') void ensureMap()
}

/** Hides the editor and shows the map again. */
export function liftOff(): void {
  if (!getState().mapEditorOpen) return
  const active = document.activeElement
  if (active instanceof HTMLElement && active.closest('.map-editor')) active.blur()
  setState({ mapEditorOpen: false })
}

/** ⇧⌘M: enter map mode, or flip between the map and the editor. */
export function toggleProjectMap(): void {
  const state = getState()
  if (state.explorerMode !== 'map') setExplorerMode('map')
  else if (!state.workspace) return
  else if (state.mapEditorOpen) liftOff()
  else if (state.tabs.length) setState({ mapEditorOpen: true })
}

/** ⇧⌘E and the Explorer activity item: in map mode the map is the explorer. */
export function showExplorer(): void {
  setState({ sidebarView: 'explorer', sidebarVisible: true })
  if (getState().explorerMode !== 'classic') liftOff()
}

export const onDidRequestReveal = new Emitter<string>()
let pendingReveal: string | null = null

export function takePendingReveal(): string | null {
  const path = pendingReveal
  pendingReveal = null
  return path
}

/** Shows a file or folder in whichever explorer is active: the map or the file tree. */
export function revealInExplorer(path: string): void {
  const state = getState()
  if (state.explorerMode === 'map' && state.workspace) {
    liftOff()
    pendingReveal = path
    onDidRequestReveal.emit(path)
    return
  }
  // The code map has no file tree; reveal in the tree instead.
  if (state.explorerMode === 'codemap') setState({ explorerMode: 'classic', mapEditorOpen: false })
  setState({ sidebarView: 'explorer', sidebarVisible: true })
  void revealInTree(path)
}

// ---------- File operations started from the map ----------
/** The folder the map is showing, as an absolute path. */
export function mapFolder(): string | null {
  const root = getState().workspace?.root
  return root ? toAbsolute(root, rememberedFocus(root) ?? '') : null
}

export async function createInMap(kind: 'file' | 'directory', parent = mapFolder()): Promise<void> {
  if (!parent) return
  const name = await prompt(kind === 'file' ? t('New file name') : t('New folder name'), {
    placeholder: kind === 'file' ? 'name.ext' : 'folder',
    confirmLabel: t('Create')
  })
  if (!name) return
  const created = await createEntry(parent, name.trim(), kind)
  if (created && kind === 'file') await openFile(created)
}

export async function renameFromMap(path: string): Promise<void> {
  const current = basename(path)
  const name = (await prompt(t('Rename {name}', { name: current }), { value: current, confirmLabel: t('Rename') }))?.trim()
  if (!name || name === current) return
  try {
    const target = await window.codemap.fs.rename(path, name)
    handleRenamed(path, target)
    moveUsage(path, target)
    const root = getState().workspace?.root
    if (root && isInside(root, path)) await loadChildren(path.slice(0, path.lastIndexOf('/')) || root)
  } catch (error) {
    reportError(error, t('Cannot rename {name}', { name: current }))
  }
}

export async function trashFromMap(path: string): Promise<void> {
  const name = basename(path)
  const ok = await confirm(t('Move "{name}" to Trash?', { name }), t('You can restore it from the Trash in Finder.'), t('Move to Trash'), true)
  if (!ok) return
  try {
    await deleteEntry(path)
  } catch (error) {
    reportError(error, t('Cannot delete {name}', { name }))
  }
}

let initialized = false

export function initProjectMap(): void {
  if (initialized) return
  initialized = true
  onDidOpen.on((path) => {
    recordOpen(path)
    if (getState().explorerMode === 'map' && !getState().mapEditorOpen) setState({ mapEditorOpen: true })
  })

  useStore.subscribe((state, previous) => {
    if (state.workspace?.root !== previous.workspace?.root) {
      requestId++
      signature = ''
      update({ root: '', status: 'idle', tree: null, fileCount: 0, truncated: false, error: undefined })
      if (state.workspace && state.explorerMode === 'map') void ensureMap()
    }
    if (state.explorerMode !== 'map') return
    // Any newly shown tab (diffs and commits included) raises the editor over the map;
    // closing the last one returns to the map.
    if (state.activeTabId && state.activeTabId !== previous.activeTabId && !state.mapEditorOpen) setState({ mapEditorOpen: true })
    else if (!state.tabs.length && state.mapEditorOpen) setState({ mapEditorOpen: false })
  })

  // Files appearing or disappearing reshape the map; batch watcher bursts into one re-index.
  let timer: number | null = null
  onDidChangeFiles.on(() => {
    if (!data.root) return
    if (getState().explorerMode !== 'map') {
      stale = true
      return
    }
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      void ensureMap(true)
    }, 1200)
  })
}
