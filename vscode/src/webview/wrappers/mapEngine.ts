import { MapEngine as BaseMapEngine } from '../../../../src/renderer/src/map/engine'

export * from '../../../../src/renderer/src/map/engine'

type CachedEngine = {
  views?: Map<string, unknown>
  readCache?: Map<string, number>
  frameFocus?: () => void
  snap?: () => void
  invalidate?: () => void
}

const maps = new Set<MapEngine>()

/** Reframe every live project map. `immediate` snaps the camera instead of easing. */
export function refitProjectMaps(immediate = false): void {
  for (const engine of maps) engine.refit(immediate)
}

/**
 * VS Code webview build of the project map. Sidebar bottom sheets must not be measured as a
 * full-width right inset, and a large viewport jump recenters instead of keeping the old offset.
 */
export class MapEngine extends BaseMapEngine {
  private visibilityRefit: (() => void) | null = null

  constructor(...args: ConstructorParameters<typeof BaseMapEngine>) {
    super(...args)
    maps.add(this)
    const onVisibility = () => {
      if (!document.hidden) requestAnimationFrame(() => this.refit(true))
    }
    document.addEventListener('visibilitychange', onVisibility)
    this.visibilityRefit = () => document.removeEventListener('visibilitychange', onVisibility)
  }

  override setInset(right: number, bottom: number): void {
    const side = this.canvas.parentElement?.querySelector<HTMLElement>('.map-side')
    const sideBox = side?.getBoundingClientRect()
    const sideVisible = Boolean(side && sideBox && sideBox.width > 0 && sideBox.height > 0 && getComputedStyle(side).display !== 'none')
    const sidebar = Boolean(this.canvas.closest('.lumen-vscode.is-sidebar'))
    if (side && sideVisible && sideBox && (right >= this.view.W * 0.58 || sidebar)) {
      const canvasRect = this.canvas.getBoundingClientRect()
      const sheetBottom = Math.max(bottom, Math.round(canvasRect.bottom - sideBox.top + 8))
      super.setInset(0, sheetBottom)
      return
    }
    super.setInset(right, bottom)
  }

  override resize(): void {
    this.refit(false)
  }

  refit(immediate = false): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const W = this.canvas.clientWidth
    const H = this.canvas.clientHeight
    const prevW = this.view.W
    const prevH = this.view.H
    const hadValidSize = prevW >= 2 && prevH >= 2
    if (W < 2 || H < 2) return
    if ((this as unknown as { sized?: boolean }).sized && W === prevW && H === prevH && dpr === this.view.dpr && !immediate) return
    const major =
      !hadValidSize ||
      Math.abs(W - prevW) / Math.max(1, prevW) >= 0.15 ||
      Math.abs(H - prevH) / Math.max(1, prevH) >= 0.15
    const cached = this as unknown as CachedEngine
    cached.views?.clear()
    cached.readCache?.clear()
    super.resize()
    if (typeof cached.frameFocus === 'function') cached.frameFocus()
    else this.overview()
    if (major || immediate) {
      cached.snap?.()
      cached.invalidate?.()
    }
  }

  override destroy(): void {
    this.visibilityRefit?.()
    this.visibilityRefit = null
    maps.delete(this)
    super.destroy()
  }
}
