import { useSyncExternalStore } from 'react'
import { isNear, NavHistory, NEAR_LINES, shiftLine, type LineEdit, type NavLocation } from '@shared/navHistory'
import { isInside } from '@shared/paths'
import { monaco } from '../editor/monaco'
import { getState } from '../state/store'
import { ensureExternalModel, ensureModel, getActiveEditor, getAnyModel, hasPendingReveal, isExternalPath, isRevealing, onDidRename, openExternalFile, openFile, setBeforeJump } from './documents'
import { onDidCloseWorkspace, onDidOpenWorkspace } from './workspace'

// Back/forward like VS Code: leaving a file (any way: tabs, tree, map, quick open, jumps) and
// moving the cursor more than NEAR_LINES lines in one go (click, ⌘↓, go to definition) each
// remember where you were. Typing, paste, and undo never do.

const history = new NavHistory()
let lastEdit: NavLocation | null = null

// ---------- Change notifications for the title bar buttons ----------

const listeners = new Set<() => void>()
let version = 0
function changed(): void {
  version++
  for (const listener of [...listeners]) listener()
}

export function useNavigationState(): { back: boolean; forward: boolean } {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => version
  )
  return { back: history.can(-1), forward: history.can(1) }
}

// ---------- Moves that are not new history ----------

// Going back/forward and previewing search results with the arrow keys move the cursor without
// adding entries. Arriving in a file is told apart by the event itself: see trackEditor.
let moving = false
let previewing = false

function isPreviewing(): boolean {
  if (previewing && !document.activeElement?.closest('.search-results')) previewing = false
  return previewing
}

/** Arrow-key previews of search results: remember where you started once, then stay quiet. */
export function beginPreview(): void {
  if (isPreviewing()) return
  recordLocation()
  previewing = true
}

export function endPreview(): void {
  previewing = false
}

// ---------- Recording ----------

function current(): NavLocation | null {
  const editor = getActiveEditor()
  const uri = editor?.getModel()?.uri
  const position = editor?.getPosition()
  if (uri?.scheme !== 'file' || !position) return null
  return { path: uri.path, line: position.lineNumber, column: position.column }
}

function record(location: NavLocation): void {
  if (moving || isPreviewing()) return
  // The editor can report a file from the previous folder while it is being torn down.
  const root = getState().workspace?.root
  if (!root || (!isInside(root, location.path) && !isExternalPath(location.path))) return
  history.record(location)
  changed()
}

/** Called before any explicit jump (definition, problem, call stack, search result). */
export function recordLocation(): void {
  const here = current()
  if (here) record(here)
}

setBeforeJump(recordLocation)

const IGNORED_REASONS = new Set([
  monaco.editor.CursorChangeReason.ContentFlush,
  monaco.editor.CursorChangeReason.RecoverFromMarkers,
  monaco.editor.CursorChangeReason.Paste,
  monaco.editor.CursorChangeReason.Undo,
  monaco.editor.CursorChangeReason.Redo
])

// Follows the shared editor: records the place left when the file changes or the cursor jumps.
export function trackEditor(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  let last: NavLocation | null = null
  const position = editor.onDidChangeCursorPosition((event) => {
    const model = editor.getModel()
    if (!model || model.uri.scheme !== 'file') return
    const here = { path: model.uri.path, line: event.position.lineNumber, column: event.position.column }
    // Restoring a file's saved view and revealing a requested target are arriving, not jumping.
    const arriving = event.source === 'restoreState' || isRevealing()
    if (last && last.path === here.path && !arriving && !IGNORED_REASONS.has(event.reason) && Math.abs(last.line - here.line) > NEAR_LINES) record(last)
    last = here
  })
  const model = editor.onDidChangeModel((event) => {
    if (last && event.oldModelUrl && last.path === event.oldModelUrl.path) record(last)
    const now = editor.getPosition()
    const uri = editor.getModel()?.uri
    last = now && uri?.scheme === 'file' ? { path: uri.path, line: now.lineNumber, column: now.column } : null
  })
  const renamed = onDidRename.on(({ from, to }) => {
    if (last && (last.path === from || last.path.startsWith(`${from}/`))) last.path = to + last.path.slice(from.length)
  })
  return {
    dispose: () => {
      // The shared editor goes away when the last file tab closes or a diff takes over.
      if (last) record(last)
      position.dispose()
      model.dispose()
      renamed.dispose()
    }
  }
}

// ---------- Moving ----------

async function reachable(location: NavLocation): Promise<boolean> {
  if (getAnyModel(location.path)) return true
  const root = getState().workspace?.root
  try {
    if (root && isInside(root, location.path)) await ensureModel(location.path)
    else await ensureExternalModel(location.path)
    return true
  } catch {
    return false
  }
}

async function open(location: NavLocation): Promise<void> {
  const root = getState().workspace?.root
  const target = { line: location.line, column: location.column }
  if (root && isInside(root, location.path)) await openFile(location.path, target)
  else await openExternalFile(location.path, target)
}

// The tab switch renders and the editor reveals its target a frame later; the next move must
// not start before that, or the late reveal would undo it. Bounded because frames may not run
// while the window is covered, in which case a newer reveal simply replaces the late one.
async function settled(location: NavLocation): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (getActiveEditor()?.getModel()?.uri.path === location.path && !hasPendingReveal()) return
    await new Promise((resolve) => window.setTimeout(resolve, 16))
  }
}

async function move(direction: -1 | 1): Promise<void> {
  moving = true
  try {
    const here = current()
    for (;;) {
      const target = history.take(direction)
      if (!target) break
      // Entries for where you already are, or for files that are gone, are skipped.
      if (here && isNear(here, target)) continue
      if (!(await reachable(target))) continue
      if (here) history.leave(direction, here)
      changed()
      await open(target)
      await settled(target)
      break
    }
  } finally {
    moving = false
    changed()
  }
}

// Presses made while a move is still arriving wait their turn, so none is lost.
let queue: Promise<void> = Promise.resolve()
export function navigateHistory(direction: -1 | 1): Promise<void> {
  queue = queue.then(() => move(direction)).catch(() => undefined)
  return queue
}

export async function goToLastEdit(): Promise<void> {
  if (!lastEdit || !(await reachable(lastEdit))) return
  await open(lastEdit)
}

// ---------- Keeping entries valid ----------

monaco.editor.onDidCreateModel((model) => {
  if (model.uri.scheme !== 'file') return
  model.onDidChangeContent((event) => {
    if (event.isFlush) return
    const path = model.uri.path
    // Shift entries below the edit so going back lands on the same code, not the same line number.
    const edits: LineEdit[] = event.changes
      .map((change) => ({ startLine: change.range.startLineNumber, endLine: change.range.endLineNumber, inserted: change.text.split('\n').length - 1 }))
      .sort((a, b) => b.startLine - a.startLine)
    history.shift(path, edits)
    if (lastEdit?.path === path) lastEdit.line = shiftLine(lastEdit.line, edits)
    const first = event.changes.reduce((top, change) => (change.rangeOffset < top.rangeOffset ? change : top), event.changes[0])
    if (first) {
      const lines = first.text.split('\n')
      const line = first.range.startLineNumber + lines.length - 1
      const column = lines.length > 1 ? lines[lines.length - 1].length + 1 : first.range.startColumn + first.text.length
      lastEdit = { path, line, column }
    }
  })
})

onDidRename.on(({ from, to }) => {
  history.rename(from, to)
  if (lastEdit && (lastEdit.path === from || lastEdit.path.startsWith(`${from}/`))) lastEdit.path = to + lastEdit.path.slice(from.length)
})

const reset = () => {
  history.clear()
  lastEdit = null
  changed()
}
onDidOpenWorkspace.on(reset)
onDidCloseWorkspace.on(reset)
