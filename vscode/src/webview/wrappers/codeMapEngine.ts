import {
  CodeMapEngine as BaseCodeMapEngine,
  type EngineHost,
  type Scene
} from '../../../../src/renderer/src/codemap/engine'

export * from '../../../../src/renderer/src/codemap/engine'

type ViewState = {
  view: { k: number; x: number; y: number }
  tweenFrame?: number
  applyView?: () => void
  resetView?: () => void
  editing?: boolean
  transitioning?: boolean
  scene?: Scene | null
}

const maps = new Set<CodeMapEngine>()

/** Refit every live code map to the current canvas size. */
export function refitCodeMaps(): void {
  for (const engine of maps) engine.refitToViewport()
}

/**
 * VS Code webview build of the code map. A jump from a hidden or much narrower canvas drops the
 * stale pan/zoom so `viewBox` + `xMidYMid meet` recenters, including automatic TB/LR rebuilds.
 */
export class CodeMapEngine extends BaseCodeMapEngine {
  private readonly svgEl: SVGSVGElement
  private lastW = 0
  private lastH = 0
  private pendingViewportReset = false
  private observer: ResizeObserver | null = null
  private onVisibility: (() => void) | null = null

  constructor(svg: SVGSVGElement, host: EngineHost) {
    super(svg, host)
    this.svgEl = svg
    if (!svg.getAttribute('preserveAspectRatio')) svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    maps.add(this)
    this.observer = new ResizeObserver(() => this.onViewportChange())
    this.observer.observe(svg)
    this.onVisibility = () => {
      if (!document.hidden) this.onViewportChange(true)
    }
    document.addEventListener('visibilitychange', this.onVisibility)
    this.onViewportChange()
  }

  private state(): ViewState {
    return this as unknown as ViewState
  }

  private onViewportChange(fromVisibility = false): void {
    const box = this.svgEl.getBoundingClientRect()
    const W = box.width
    const H = box.height
    const prevW = this.lastW
    const prevH = this.lastH
    const grew = (prevW <= 2 && W > 2) || (prevH <= 2 && H > 2)
    const shifted = Math.abs(W - prevW) >= 4 || Math.abs(H - prevH) >= 4
    if (!grew && !shifted && !fromVisibility) return
    if (W <= 2 || H <= 2) {
      this.lastW = W
      this.lastH = H
      return
    }
    const major = grew || prevW <= 2 || prevH <= 2 || Math.abs(W - prevW) / Math.max(1, prevW) >= 0.15 || Math.abs(H - prevH) / Math.max(1, prevH) >= 0.15
    this.lastW = W
    this.lastH = H
    if (!this.state().editing && (grew || shifted)) this.pendingViewportReset = true
    this.refitToViewport(major || grew)
  }

  refitToViewport(immediate = false): void {
    const state = this.state()
    if (state.editing || state.transitioning) return
    const jumping = immediate || this.pendingViewportReset
    if (jumping) {
      if (state.tweenFrame) {
        cancelAnimationFrame(state.tweenFrame)
        state.tweenFrame = 0
      }
      state.view = { k: 1, x: 0, y: 0 }
      state.applyView?.()
      return
    }
    state.resetView?.()
  }

  override render(scene: Scene, keepView: boolean): void {
    if (this.pendingViewportReset) {
      keepView = false
      this.pendingViewportReset = false
    }
    super.render(scene, keepView)
  }

  override dispose(): void {
    this.observer?.disconnect()
    this.observer = null
    if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility)
    this.onVisibility = null
    maps.delete(this)
    super.dispose()
  }
}
