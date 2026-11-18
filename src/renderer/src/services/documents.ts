import { basename } from '@shared/paths'
import { monaco } from '../editor/monaco'
import { Emitter } from '../lib/events'
import { languageFor } from '../lib/language'
import { getState, setState, type Tab } from '../state/store'
import { confirm, notify, reportError } from './ui'
import { t } from '../lib/i18n'

interface DocumentRecord {
  model: monaco.editor.ITextModel
  savedVersion: number
  savedContent: string
  viewState: monaco.editor.ICodeEditorViewState | null
}

const documents = new Map<string, DocumentRecord>()
const diffModels = new Map<string, { original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel }>()
// Read-only models for navigation targets outside the folder (SDK headers, toolchain sources).
const externalModels = new Map<string, monaco.editor.ITextModel>()
export const onDidSave = new Emitter<string>()
export const onDidOpen = new Emitter<string>()
export const onDidChangeActive = new Emitter<string | null>()
export const onDidCreateModel = new Emitter<{ path: string; model: monaco.editor.ITextModel }>()
export const onDidClose = new Emitter<string>()
/** A file or folder moved; tabs, history, and anything keyed by path follow it. */
export const onDidRename = new Emitter<{ from: string; to: string }>()

// Navigation history registers here so any targeted jump (diagnostic, call stack,
// definition) remembers where the cursor was. Kept as a hook to avoid an import cycle.
let beforeJump: (() => void) | null = null
export function setBeforeJump(hook: () => void): void {
  beforeJump = hook
}

// Diagnostics, git decorations, and plugins all need to reach the live editor.
let activeEditor: monaco.editor.IStandaloneCodeEditor | null = null
export function setActiveEditor(editor: monaco.editor.IStandaloneCodeEditor | null): void {
  activeEditor = editor
}
export function getActiveEditor(): monaco.editor.IStandaloneCodeEditor | null {
  return activeEditor
}

function fileUri(path: string): monaco.Uri {
  return monaco.Uri.file(path)
}

function updateDirty(path: string): void {
  const record = documents.get(path)
  if (!record) return
  const isDirty = record.model.getAlternativeVersionId() !== record.savedVersion
  const dirty = getState().dirty
  if (Boolean(dirty[path]) === isDirty) return
  const next = { ...dirty }
  if (isDirty) next[path] = true
  else delete next[path]
  setState({ dirty: next })
  window.codemap.app.setDirtyCount(Object.keys(next).length)
}

export function getModel(path: string): monaco.editor.ITextModel | null {
  return documents.get(path)?.model ?? null
}

export function getAnyModel(path: string): monaco.editor.ITextModel | null {
  return documents.get(path)?.model ?? externalModels.get(path) ?? null
}

export function getDocumentText(path: string): string | null {
  return documents.get(path)?.model.getValue() ?? null
}

export async function ensureModel(path: string): Promise<monaco.editor.ITextModel> {
  const existing = documents.get(path)
  if (existing) return existing.model
  const content = await window.codemap.fs.read(path)
  const uri = fileUri(path)
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, languageFor(path), uri)
  model.setEOL(content.includes('\r\n') ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF)
  const record: DocumentRecord = { model, savedVersion: model.getAlternativeVersionId(), savedContent: content, viewState: null }
  documents.set(path, record)
  model.onDidChangeContent(() => updateDirty(path))
  onDidCreateModel.emit({ path, model })
  return model
}

export function isExternalPath(path: string): boolean {
  return externalModels.has(path)
}

export async function ensureExternalModel(path: string): Promise<monaco.editor.ITextModel> {
  const existing = externalModels.get(path)
  if (existing && !existing.isDisposed()) return existing
  const content = await window.codemap.fs.readExternal(path)
  const uri = fileUri(path)
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, languageFor(path), uri)
  externalModels.set(path, model)
  return model
}

function upsertTab(tab: Tab): void {
  const { tabs } = getState()
  const exists = tabs.some((entry) => entry.id === tab.id)
  if (exists) {
    setState({ activeTabId: tab.id })
    return
  }
  const activeIndex = tabs.findIndex((entry) => entry.id === getState().activeTabId)
  const next = [...tabs]
  next.splice(activeIndex >= 0 ? activeIndex + 1 : next.length, 0, tab)
  setState({ tabs: next, activeTabId: tab.id })
}

export interface RevealTarget {
  line: number
  column?: number
  endLine?: number
  /** With `endLine`, selects the range instead of only placing the cursor. */
  endColumn?: number
  /** Keeps keyboard focus where it is (search results browsed with the arrow keys). */
  preserveFocus?: boolean
}

let pendingReveal: { path: string; target: RevealTarget } | null = null
export function consumePendingReveal(path: string): RevealTarget | null {
  if (pendingReveal?.path !== path) return null
  const target = pendingReveal.target
  pendingReveal = null
  return target
}

let revealing = false
/** True while the editor moves to a requested target, so history does not count it as a jump. */
export function isRevealing(): boolean {
  return revealing
}

let scheduledReveal: number | null = null

function cancelScheduledReveal(): void {
  if (scheduledReveal !== null) cancelAnimationFrame(scheduledReveal)
  scheduledReveal = null
}

/** Reveals on the next frame, once the editor has shown the file. A newer reveal replaces it. */
export function scheduleReveal(target: RevealTarget): void {
  cancelScheduledReveal()
  scheduledReveal = requestAnimationFrame(() => {
    scheduledReveal = null
    revealInActiveEditor(target)
  })
}

/** True until a requested target has been applied to the editor. */
export function hasPendingReveal(): boolean {
  return pendingReveal !== null || scheduledReveal !== null
}

export function revealInActiveEditor(target: RevealTarget): void {
  cancelScheduledReveal()
  const editor = activeEditor
  if (!editor) return
  const column = target.column ?? 1
  revealing = true
  try {
    if (target.endLine !== undefined && target.endColumn !== undefined) {
      editor.setSelection(new monaco.Selection(target.line, column, target.endLine, target.endColumn))
    } else editor.setPosition({ lineNumber: target.line, column })
  } finally {
    revealing = false
  }
  editor.revealLineInCenterIfOutsideViewport(target.line, monaco.editor.ScrollType.Smooth)
  if (!target.preserveFocus) editor.focus()
}

export async function openFile(path: string, target?: RevealTarget): Promise<void> {
  try {
    await ensureModel(path)
  } catch (error) {
    reportError(error, t('Cannot open {name}', { name: basename(path) }))
    return
  }
  if (target) beforeJump?.()
  const alreadyActive = getState().activeTabId === path
  if (target) pendingReveal = { path, target }
  upsertTab({ id: path, kind: 'file', title: basename(path), path })
  setState({ selectedPath: path })
  onDidOpen.emit(path)
  if (alreadyActive && target) {
    pendingReveal = null
    revealInActiveEditor(target)
  }
}

export async function openExternalFile(path: string, target?: RevealTarget): Promise<void> {
  try {
    await ensureExternalModel(path)
  } catch (error) {
    reportError(error, t('Cannot open {name}', { name: basename(path) }))
    return
  }
  if (target) beforeJump?.()
  const alreadyActive = getState().activeTabId === path
  if (target) pendingReveal = { path, target }
  upsertTab({ id: path, kind: 'file', title: basename(path), path, readOnly: true })
  if (alreadyActive && target) {
    pendingReveal = null
    revealInActiveEditor(target)
  }
}

export async function openDiff(path: string, staged: boolean): Promise<void> {
  const id = `diff:${staged ? 'staged' : 'work'}:${path}`
  try {
    const diff = await window.codemap.git.diff(path, staged)
    const language = languageFor(path)
    const existing = diffModels.get(id)
    if (existing) {
      existing.original.setValue(diff.original)
      existing.modified.setValue(diff.modified)
    } else {
      diffModels.set(id, {
        original: monaco.editor.createModel(diff.original, language),
        modified: monaco.editor.createModel(diff.modified, language)
      })
    }
    upsertTab({ id, kind: 'diff', title: t(staged ? '{name} (Staged)' : '{name} (Working Tree)', { name: basename(path) }), path, staged })
  } catch (error) {
    reportError(error, t('Cannot diff {name}', { name: basename(path) }))
  }
}

export function getDiffModels(id: string) {
  return diffModels.get(id) ?? null
}

export function openCommit(hash: string, subject: string): void {
  upsertTab({ id: `commit:${hash}`, kind: 'commit', title: `${hash.slice(0, 7)} ${subject}`, hash })
}

export function saveViewState(path: string, state: monaco.editor.ICodeEditorViewState | null): void {
  const record = documents.get(path)
  if (record) record.viewState = state
}

export function getViewState(path: string): monaco.editor.ICodeEditorViewState | null {
  return documents.get(path)?.viewState ?? null
}

export async function saveFile(path: string): Promise<boolean> {
  const record = documents.get(path)
  if (!record) return false
  const content = record.model.getValue()
  try {
    await window.codemap.fs.write(path, content)
    record.savedVersion = record.model.getAlternativeVersionId()
    record.savedContent = content
    updateDirty(path)
    onDidSave.emit(path)
    return true
  } catch (error) {
    reportError(error, t('Cannot save {name}', { name: basename(path) }))
    return false
  }
}

export async function saveActive(): Promise<void> {
  const tab = getActiveTab()
  if (tab?.kind === 'file' && tab.path) await saveFile(tab.path)
}

export async function saveAll(): Promise<number> {
  const dirty = Object.keys(getState().dirty)
  let saved = 0
  for (const path of dirty) if (await saveFile(path)) saved++
  return saved
}

export function getActiveTab(): Tab | null {
  const { tabs, activeTabId } = getState()
  return tabs.find((tab) => tab.id === activeTabId) ?? null
}

function disposeTabResources(tab: Tab): void {
  if (tab.kind === 'file' && tab.path && tab.readOnly) {
    externalModels.get(tab.path)?.dispose()
    externalModels.delete(tab.path)
  } else if (tab.kind === 'file' && tab.path) {
    const record = documents.get(tab.path)
    record?.model.dispose()
    documents.delete(tab.path)
    onDidClose.emit(tab.path)
    const dirty = { ...getState().dirty }
    if (dirty[tab.path]) {
      delete dirty[tab.path]
      setState({ dirty })
      window.codemap.app.setDirtyCount(Object.keys(dirty).length)
    }
  } else if (tab.kind === 'diff') {
    const models = diffModels.get(tab.id)
    models?.original.dispose()
    models?.modified.dispose()
    diffModels.delete(tab.id)
  }
}

export async function closeTab(id: string, force = false): Promise<boolean> {
  const { tabs, activeTabId, dirty } = getState()
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return true
  const tab = tabs[index]
  if (!force && tab.kind === 'file' && tab.path && dirty[tab.path]) {
    const response = await window.codemap.app.confirm({
      message: t('Do you want to save the changes you made to {name}?', { name: tab.title }),
      detail: t("Your changes will be lost if you don't save them."),
      buttons: [t('Save'), t("Don't Save"), t('Cancel')],
      cancelId: 2,
      defaultId: 0
    })
    if (response === 2) return false
    if (response === 0 && !(await saveFile(tab.path))) return false
  }
  disposeTabResources(tab)
  const next = tabs.filter((entry) => entry.id !== id)
  let nextActive = activeTabId
  if (activeTabId === id) nextActive = next[Math.min(index, next.length - 1)]?.id ?? null
  setState({ tabs: next, activeTabId: nextActive })
  return true
}

export async function closeAllTabs(): Promise<boolean> {
  const dirtyCount = Object.keys(getState().dirty).length
  if (dirtyCount) {
    const discard = await confirm(
      t(dirtyCount === 1 ? 'Close {n} unsaved file?' : 'Close {n} unsaved files?', { n: dirtyCount }),
      t('Unsaved changes will be lost.'),
      t('Discard Changes'),
      true
    )
    if (!discard) return false
  }
  for (const tab of getState().tabs) disposeTabResources(tab)
  setState({ tabs: [], activeTabId: null, dirty: {} })
  window.codemap.app.setDirtyCount(0)
  return true
}

// Called by the file watcher. Clean documents follow the disk; dirty ones are left alone
// so external tools never silently overwrite unsaved work.
export async function syncFromDisk(paths: string[]): Promise<void> {
  const touched = new Set(paths)
  for (const [path, record] of documents) {
    if (!touched.has(path)) continue
    if (getState().dirty[path]) continue
    try {
      const content = await window.codemap.fs.read(path)
      if (content === record.savedContent) continue
      const selections = activeEditor?.getModel() === record.model ? activeEditor.getSelections() : null
      record.model.pushEditOperations([], [{ range: record.model.getFullModelRange(), text: content }], () => null)
      record.savedVersion = record.model.getAlternativeVersionId()
      record.savedContent = content
      if (selections) activeEditor?.setSelections(selections)
    } catch {
      // File was deleted or became unreadable; keep the buffer and mark it dirty so it can be saved again.
      if (!getState().dirty[path]) {
        setState({ dirty: { ...getState().dirty, [path]: true } })
        notify(t('{name} was removed on disk', { name: basename(path) }), 'warning')
      }
    }
  }
}

export function handleRenamed(from: string, to: string): void {
  onDidRename.emit({ from, to })
  const { tabs, activeTabId } = getState()
  const affected = tabs.filter((tab) => tab.path && (tab.path === from || tab.path.startsWith(`${from}/`)))
  if (!affected.length) return
  const remap = (path: string) => (path === from ? to : `${to}${path.slice(from.length)}`)
  let nextActive = activeTabId
  const nextTabs = tabs.map((tab) => {
    if (!affected.includes(tab) || tab.kind !== 'file' || !tab.path) return tab
    const newPath = remap(tab.path)
    const record = documents.get(tab.path)
    if (record) {
      const content = record.model.getValue()
      const wasDirty = Boolean(getState().dirty[tab.path])
      record.model.dispose()
      documents.delete(tab.path)
      const model = monaco.editor.createModel(content, languageFor(newPath), fileUri(newPath))
      const newRecord: DocumentRecord = {
        model,
        savedVersion: wasDirty ? -1 : model.getAlternativeVersionId(),
        savedContent: record.savedContent,
        viewState: record.viewState
      }
      documents.set(newPath, newRecord)
      model.onDidChangeContent(() => updateDirty(newPath))
    }
    if (activeTabId === tab.id) nextActive = newPath
    return { ...tab, id: newPath, path: newPath, title: basename(newPath) }
  })
  const dirty: Record<string, boolean> = {}
  for (const [path, value] of Object.entries(getState().dirty)) dirty[affected.some((t) => t.path === path) ? remap(path) : path] = value
  setState({ tabs: nextTabs, activeTabId: nextActive, dirty })
}

export async function handleDeleted(path: string): Promise<void> {
  const tabs = getState().tabs.filter((tab) => tab.path && (tab.path === path || tab.path.startsWith(`${path}/`)))
  for (const tab of tabs) await closeTab(tab.id, true)
}

export function openPaths(): string[] {
  return [...documents.keys()]
}
