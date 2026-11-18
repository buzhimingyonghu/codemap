import { basename, dirname, isInside } from '@shared/paths'
import type { TransferResult } from '@shared/types'
import { getState, setState } from '../state/store'
import { handleRenamed } from './documents'
import { notify, reportError } from './ui'
import { t } from '../lib/i18n'
import { loadChildren, toggleFolder } from './workspace'

// Cut is tracked locally because the system clipboard has no "cut" flag for files.
// Copy puts real file references on the system clipboard, so Finder can paste them too.
let cutPaths: string[] | null = null

export function getCutPaths(): string[] {
  return cutPaths ?? []
}

export async function copyEntries(paths: string[]): Promise<void> {
  if (!paths.length) return
  cutPaths = null
  setState({ cutPaths: [] })
  await window.codemap.fs.writeClipboardFiles(paths)
}

export async function cutEntries(paths: string[]): Promise<void> {
  if (!paths.length) return
  await window.codemap.fs.writeClipboardFiles(paths)
  cutPaths = [...paths]
  setState({ cutPaths: [...paths] })
}

function summarize(result: TransferResult, verb: string): void {
  if (result.failed.length) {
    const first = result.failed[0]
    notify(
      result.created.length ? t(verb === 'Moved' ? 'Moved {n}, {failed} failed' : 'Copied {n}, {failed} failed', { n: result.created.length, failed: result.failed.length }) : t(verb === 'Moved' ? 'Could not move {name}' : 'Could not copy {name}', { name: basename(first.path) }),
      'error',
      first.error
    )
  } else if (result.created.length > 1) {
    notify(t(verb === 'Moved' ? 'Moved {n} items' : 'Copied {n} items', { n: result.created.length }), 'success')
  }
}

async function afterTransfer(result: TransferResult, targetDir: string, sources: string[], mode: 'copy' | 'move'): Promise<void> {
  await toggleFolder(targetDir, true)
  await loadChildren(targetDir)
  if (mode === 'move') {
    for (const source of sources) {
      const target = result.created.find((created) => basename(created) === basename(source))
      if (target && target !== source) handleRenamed(source, target)
      await loadChildren(dirname(source))
    }
  }
  const last = result.created[result.created.length - 1]
  if (last) setState({ selectedPath: last })
}

export async function transfer(sources: string[], targetDir: string, mode: 'copy' | 'move'): Promise<TransferResult | null> {
  if (!sources.length) return null
  try {
    const result = await window.codemap.fs.transfer(sources, targetDir, mode)
    await afterTransfer(result, targetDir, sources, mode)
    summarize(result, mode === 'move' ? 'Moved' : 'Copied')
    return result
  } catch (error) {
    reportError(error, mode === 'move' ? t('Move failed') : t('Copy failed'))
    return null
  }
}

// Pastes whatever file references are on the system clipboard: copied in Codemap,
// copied in Finder (⌘C on files or folders), or cut in Codemap.
export async function pasteInto(targetDir: string): Promise<void> {
  const files: string[] = await window.codemap.fs.readClipboardFiles().catch(() => [])
  if (!files.length) {
    notify(t('Clipboard has no files or folders'), 'info')
    return
  }
  const pending: string[] = cutPaths ?? []
  const isCut = pending.length > 0 && pending.length === files.length && pending.every((path) => files.includes(path))
  const result = await transfer(files, targetDir, isCut ? 'move' : 'copy')
  if (isCut && result && !result.failed.length) {
    cutPaths = null
    setState({ cutPaths: [] })
  }
}

export async function duplicate(path: string): Promise<void> {
  try {
    const created = await window.codemap.fs.duplicate(path)
    await loadChildren(dirname(path))
    setState({ selectedPath: created })
  } catch (error) {
    reportError(error, t('Cannot duplicate {name}', { name: basename(path) }))
  }
}

// Drop handler shared by the tree rows and the empty tree area.
export async function dropOnto(targetDir: string, sources: string[], forceCopy: boolean): Promise<void> {
  const root = getState().workspace?.root
  if (!root) return
  const inside = sources.filter((source) => isInside(root, source))
  // Like Finder: dragging inside the folder moves (⌥ copies); dragging in from outside copies.
  const mode = !forceCopy && inside.length === sources.length ? 'move' : 'copy'
  const meaningful = mode === 'move' ? sources.filter((source) => dirname(source) !== targetDir && source !== targetDir) : sources
  if (!meaningful.length) return
  await transfer(meaningful, targetDir, mode)
}
