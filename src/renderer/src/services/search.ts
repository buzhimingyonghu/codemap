import { create } from 'zustand'
import { isInside, relativePath } from '@shared/paths'
import {
  buildSearchRegExp,
  computeReplacements,
  DEFAULT_MAX_RESULTS,
  findMatches,
  pathFilter,
  scopeGlob,
  type SearchFileResult,
  type SearchMatch,
  type SearchQuery
} from '@shared/search'
import { monaco } from '../editor/monaco'
import { t } from '../lib/i18n'
import { getState as getWorkbench, setState as setWorkbench } from '../state/store'
import { getActiveEditor, getModel, onDidSave, openFile } from './documents'
import { beginPreview, endPreview } from './navigation'
import { onDidCloseWorkspace, onDidOpenWorkspace } from './workspace'
import { confirm, notify, reportError } from './ui'

export interface SearchState {
  pattern: string
  replacement: string
  include: string
  exclude: string
  isRegex: boolean
  matchCase: boolean
  wholeWord: boolean
  showReplace: boolean
  showDetails: boolean
  running: boolean
  error: string | null
  files: SearchFileResult[]
  total: number
  truncated: boolean
  /** Bumped on every search so the view can reset collapse state. */
  version: number
  collapsed: Record<string, boolean>
  /** Bumped to ask the view to focus (and select) the search input. */
  focusToken: number
}

const initial: SearchState = {
  pattern: '',
  replacement: '',
  include: '',
  exclude: '',
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  showReplace: false,
  showDetails: false,
  running: false,
  error: null,
  files: [],
  total: 0,
  truncated: false,
  version: 0,
  collapsed: {},
  focusToken: 0
}

export const useSearch = create<SearchState>(() => initial)
const get = useSearch.getState
const set = useSearch.setState

type QueryField = 'pattern' | 'include' | 'exclude' | 'isRegex' | 'matchCase' | 'wholeWord'

export function currentQuery(): SearchQuery {
  const s = get()
  return { pattern: s.pattern, isRegex: s.isRegex, matchCase: s.matchCase, wholeWord: s.wholeWord, include: s.include, exclude: s.exclude, maxResults: DEFAULT_MAX_RESULTS }
}

let timer: number | undefined
let ticket = 0

// Typing searches after a short pause; Enter and option toggles search right away.
export function updateQuery(patch: Partial<Pick<SearchState, QueryField>>, immediate = false): void {
  set(patch)
  scheduleSearch(immediate ? 0 : 300)
}

export function setReplacement(replacement: string): void {
  set({ replacement })
}

export function toggleReplace(): void {
  set({ showReplace: !get().showReplace })
}

export function toggleDetails(): void {
  set({ showDetails: !get().showDetails })
}

function scheduleSearch(delay: number): void {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => void runSearch(), delay)
}

// Unsaved editors are searched here, from their live text; everything else on disk.
function dirtyPaths(root: string): string[] {
  return Object.keys(getWorkbench().dirty).filter((path) => getModel(path) && isInside(root, path))
}

export async function runSearch(): Promise<void> {
  window.clearTimeout(timer)
  const root = getWorkbench().workspace?.root
  const query = currentQuery()
  const id = ++ticket
  if (!root || !query.pattern) {
    void window.codemap.search.cancel()
    set({ running: false, error: null, files: [], total: 0, truncated: false, version: get().version + 1, collapsed: {} })
    return
  }
  let re: RegExp
  try {
    re = buildSearchRegExp(query)
  } catch (error) {
    void window.codemap.search.cancel()
    set({ running: false, error: error instanceof Error ? error.message : String(error), files: [], total: 0, truncated: false })
    return
  }
  set({ running: true, error: null })
  const dirty = dirtyPaths(root)
  const accept = pathFilter(query)
  const local: SearchFileResult[] = []
  for (const path of dirty) {
    const relative = relativePath(root, path)
    if (!accept(relative)) continue
    const matches = findMatches(getModel(path)?.getValue() ?? '', re, DEFAULT_MAX_RESULTS)
    if (matches.length) local.push({ path, relative, matches })
  }
  try {
    const result = await window.codemap.search.run(query, dirty)
    if (id !== ticket || !result) return
    const files = [...local, ...result.files].sort((a, b) => compareRelative(a.relative, b.relative))
    const total = files.reduce((sum, file) => sum + file.matches.length, 0)
    set({ running: false, files, total, truncated: result.truncated, version: get().version + 1, collapsed: {} })
  } catch (error) {
    if (id !== ticket) return
    set({ running: false, error: error instanceof Error ? error.message : String(error), files: [], total: 0, truncated: false })
  }
}

// Files in a folder before files of its subfolders, then by name, like a flattened tree.
function compareRelative(a: string, b: string): number {
  const da = a.lastIndexOf('/')
  const db = b.lastIndexOf('/')
  const dirA = da < 0 ? '' : a.slice(0, da)
  const dirB = db < 0 ? '' : b.slice(0, db)
  if (dirA !== dirB) return dirA.localeCompare(dirB, undefined, { numeric: true, sensitivity: 'base' })
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

export function clearSearch(): void {
  window.clearTimeout(timer)
  ticket++
  void window.codemap.search.cancel()
  set({ pattern: '', replacement: '', running: false, error: null, files: [], total: 0, truncated: false, version: get().version + 1, collapsed: {}, focusToken: get().focusToken + 1 })
}

export function setCollapsed(path: string, collapsed: boolean): void {
  set({ collapsed: { ...get().collapsed, [path]: collapsed } })
}

export function collapseAll(): void {
  const all = get().collapsed
  const anyOpen = get().files.some((file) => !all[file.path])
  set({ collapsed: Object.fromEntries(get().files.map((file) => [file.path, anyOpen])) })
}

// Removes results from the list without touching the file (the × buttons).
export function dismiss(path: string, match?: SearchMatch): void {
  const files = get()
    .files.map((file) => (file.path !== path ? file : match ? { ...file, matches: file.matches.filter((m) => m !== match) } : { ...file, matches: [] }))
    .filter((file) => file.matches.length)
  set({ files, total: files.reduce((sum, file) => sum + file.matches.length, 0) })
}

// Arrow-key previews keep focus in the list and add one history entry for the whole browse;
// a click or Enter is a normal jump.
export function openMatch(path: string, match: SearchMatch, preview = false): void {
  if (preview) beginPreview()
  else endPreview()
  void openFile(path, { line: match.line, column: match.column, endLine: match.endLine, endColumn: match.endColumn, preserveFocus: preview })
}

// Opens the view and focuses the input, seeded from a single-line editor selection.
export function showSearch(): void {
  setWorkbench({ sidebarView: 'search', sidebarVisible: true })
  const editor = getActiveEditor()
  const selection = editor?.getSelection()
  const text = selection && !selection.isEmpty() ? editor?.getModel()?.getValueInRange(selection) : ''
  if (text && !text.includes('\n') && text.length <= 200) {
    set({ pattern: get().isRegex ? text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : text })
    scheduleSearch(0)
  }
  set({ focusToken: get().focusToken + 1 })
}

// "Find in Folder…" from the file tree or the map: limits the search to these paths
// (absolute or folder-relative) and shows the include field so the scope is visible.
export function searchIn(paths: string[]): void {
  const root = getWorkbench().workspace?.root
  if (!root) return
  const relatives = paths.map((path) => (isInside(root, path) ? relativePath(root, path) : path))
  const include = relatives.includes('') ? '' : relatives.map(scopeGlob).join(', ')
  setWorkbench({ sidebarView: 'search', sidebarVisible: true })
  set({ include, showDetails: get().showDetails || Boolean(include), focusToken: get().focusToken + 1 })
  if (get().pattern) scheduleSearch(0)
}

// ---------- Replace ----------

type Target = { path: string; matches: SearchMatch[] }

export async function replaceAll(): Promise<void> {
  const { files, total, replacement } = get()
  if (!total) return
  const ok = await confirm(
    t(files.length === 1 ? 'Replace {n} occurrences across 1 file?' : 'Replace {n} occurrences across {m} files?', { n: total, m: files.length }),
    replacement ? t('Each match will be replaced with “{text}”.', { text: replacement }) : t('Each match will be deleted.'),
    t('Replace All'),
    true
  )
  if (ok) await replaceTargets(files)
}

export async function replaceFile(path: string): Promise<void> {
  const file = get().files.find((entry) => entry.path === path)
  if (file) await replaceTargets([file])
}

export async function replaceMatch(path: string, match: SearchMatch): Promise<void> {
  await replaceTargets([{ path, matches: [match] }])
}

// Files open in an editor change in place (undoable, left unsaved); the rest are rewritten on disk.
async function replaceTargets(targets: Target[]): Promise<void> {
  const query = currentQuery()
  const { replacement } = get()
  let re: RegExp
  try {
    re = buildSearchRegExp(query)
  } catch (error) {
    reportError(error)
    return
  }
  let replaced = 0
  let fileCount = 0
  const onDisk: Array<{ path: string; positions: Array<[number, number]> }> = []
  for (const target of targets) {
    const positions = new Set(target.matches.map((m) => `${m.line}:${m.column}`))
    const model = getModel(target.path)
    if (model && getWorkbench().dirty[target.path]) {
      const edits = computeReplacements(model.getValue(), re, replacement, query.isRegex, (line, column) => positions.has(`${line}:${column}`))
      if (!edits.length) continue
      model.pushStackElement()
      model.pushEditOperations(
        [],
        edits.map((edit) => {
          const start = model.getPositionAt(edit.offset)
          const end = model.getPositionAt(edit.offset + edit.length)
          return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: edit.text }
        }),
        () => null
      )
      model.pushStackElement()
      replaced += edits.length
      fileCount++
    } else {
      onDisk.push({ path: target.path, positions: target.matches.map((m) => [m.line, m.column]) })
    }
  }
  if (onDisk.length) {
    try {
      const result = await window.codemap.search.replace(query, replacement, onDisk)
      replaced += result.replaced
      fileCount += result.files
      if (result.failed.length) notify(t('Could not replace in {n} files', { n: result.failed.length }), 'error', result.failed.map((f) => `${f.path}: ${f.error}`).join('\n'))
    } catch (error) {
      reportError(error, t('Replace failed'))
    }
  }
  if (targets.length > 1 || replaced > 1) {
    notify(t(fileCount === 1 ? 'Replaced {n} occurrences in 1 file' : 'Replaced {n} occurrences in {m} files', { n: replaced, m: fileCount }))
  }
  await runSearch()
}

// ---------- Lifecycle ----------

let initialized = false
export function initSearch(): void {
  if (initialized) return
  initialized = true
  // Saved or changed files refresh the results, quietly, while a search is showing.
  onDidSave.on(() => {
    if (get().pattern) scheduleSearch(500)
  })
  window.codemap.fs.onChange(() => {
    if (get().pattern) scheduleSearch(800)
  })
  onDidOpenWorkspace.on(() => {
    if (get().pattern) scheduleSearch(0)
  })
  onDidCloseWorkspace.on(() => {
    ticket++
    set({ running: false, error: null, files: [], total: 0, truncated: false, collapsed: {} })
  })
}
