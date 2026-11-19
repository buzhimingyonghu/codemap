import { revealInExplorer as originalRevealInExplorer } from '../../../../src/renderer/src/services/projectMap'
import { getState } from '../../../../src/renderer/src/state/store'
import { request } from '../installBridge'

export * from '../../../../src/renderer/src/services/projectMap'

/** Map mode flies to the canvas. Every other mode highlights the native Explorer without leaving the map. */
export function revealInExplorer(path: string): void {
  if (getState().explorerMode === 'map') {
    originalRevealInExplorer(path)
    return
  }
  void request('host:revealInExplorer', [path])
}
