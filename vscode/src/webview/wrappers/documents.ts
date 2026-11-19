import {
  openExternalFile as originalOpenExternalFile,
  openFile as originalOpenFile,
  type RevealTarget
} from '../../../../src/renderer/src/services/documents'
import { request } from '../installBridge'
import { isInternalReveal } from '../prefs'
import { recordOpen } from './projectMap'
import { getState, setState } from '../../../../src/renderer/src/state/store'

export * from '../../../../src/renderer/src/services/documents'

/** Native VS Code tab in the active column. Skips the rising Monaco overlay. */
async function openNative(path: string, target?: RevealTarget): Promise<void> {
  if (getState().explorerMode === 'map') recordOpen(path)
  if (getState().activeTabId !== null || getState().mapEditorOpen) setState({ activeTabId: null, mapEditorOpen: false })
  const line = target?.line ?? 1
  await request('host:openInVSCode', [path, line, false])
}

export async function openFile(path: string, target?: RevealTarget): Promise<void> {
  if (!isInternalReveal()) {
    await openNative(path, target)
    return
  }
  await originalOpenFile(path, target)
}

export async function openExternalFile(path: string, target?: RevealTarget): Promise<void> {
  if (!isInternalReveal()) {
    await openNative(path, target)
    return
  }
  await originalOpenExternalFile(path, target)
}
