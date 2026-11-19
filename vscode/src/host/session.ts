export interface RevealTarget {
  path: string
  line: number
}

export type HostMode = 'map' | 'codemap'
export type WebviewSurface = 'sidebar' | 'panel'
export type SidebarSide = 'left' | 'right'
export type SidebarContainerKind = 'primary' | 'auxiliary'

export function resolveSidebarSide(primarySideBarLocation: string | undefined, container: SidebarContainerKind = 'primary'): SidebarSide {
  const primary: SidebarSide = primarySideBarLocation === 'right' ? 'right' : 'left'
  if (container === 'auxiliary') return primary === 'left' ? 'right' : 'left'
  return primary
}

export interface NavigationSnapshot {
  mode: HostMode
  projectFocusRel?: string
  codemapLibrary?: string | null
  codemapStack?: string[]
  codemapFlowId?: string | null
  codemapFocus?: string | null
  codemapReqIndex?: number
  codemapReqOn?: boolean
  followCursor?: boolean
}

export type PendingHostAction =
  | { kind: 'mode'; mode: HostMode }
  | { kind: 'revealCode'; path: string; line: number }
  | { kind: 'revealProject'; path: string }
  | { kind: 'cursor'; path: string; line: number }
  | { kind: 'snapshot'; snapshot: NavigationSnapshot }
  | { kind: 'sidebarSide'; side: SidebarSide }
  | { kind: 'openAiSettings' }
  | { kind: 'askSelection'; path: string; startLine: number; endLine: number; mode?: 'ask' | 'adjust' | 'require' }
  | { kind: 'externalFocus'; map: string | null; nodes: string[]; flow?: string | null; note?: string }
  | { kind: 'externalProposal'; sessionId: string; changeSetId?: string }

export interface DeliveredHostAction {
  channel:
    | 'host:mode'
    | 'host:revealCode'
    | 'host:revealProject'
    | 'host:cursor'
    | 'host:snapshot'
    | 'host:sidebarSide'
    | 'host:openAiSettings'
    | 'host:askSelection'
    | 'host:externalFocus'
    | 'host:externalProposal'
  payload: unknown
}

export interface HostPostEvent {
  type: 'event'
  channel: string
  payload?: unknown
}

export type HostPoster = (event: HostPostEvent) => void

export interface WebviewSession {
  ready: boolean
  pending: PendingHostAction[]
}

interface SurfaceSlot {
  session: WebviewSession
  post?: HostPoster
  parked: PendingHostAction[]
}

export function createWebviewSession(): WebviewSession {
  return { ready: false, pending: [] }
}

export function resetWebviewSession(session: WebviewSession): void {
  session.ready = false
  session.pending = []
}

export function queueHostAction(session: WebviewSession, action: PendingHostAction): DeliveredHostAction | null {
  if (!session.ready) {
    enqueueHostAction(session.pending, action)
    return null
  }
  return deliverHostAction(action)
}

export function flushReady(session: WebviewSession): DeliveredHostAction[] {
  session.ready = true
  const pending = session.pending.splice(0)
  return pending.map(deliverHostAction)
}

export function queueReveal(session: WebviewSession, target: RevealTarget): RevealTarget | null {
  const delivered = queueHostAction(session, { kind: 'revealCode', path: target.path, line: target.line })
  return delivered ? target : null
}

export function consumeReady(session: WebviewSession): RevealTarget | null {
  const reveal = flushReady(session).find((action) => action.channel === 'host:revealCode')
  return (reveal?.payload as RevealTarget | undefined) ?? null
}

function deliverHostAction(action: PendingHostAction): DeliveredHostAction {
  if (action.kind === 'mode') return { channel: 'host:mode', payload: { mode: action.mode } }
  if (action.kind === 'revealCode') return { channel: 'host:revealCode', payload: { path: action.path, line: action.line } }
  if (action.kind === 'cursor') return { channel: 'host:cursor', payload: { path: action.path, line: action.line } }
  if (action.kind === 'snapshot') return { channel: 'host:snapshot', payload: action.snapshot }
  if (action.kind === 'sidebarSide') return { channel: 'host:sidebarSide', payload: { side: action.side } }
  if (action.kind === 'openAiSettings') return { channel: 'host:openAiSettings', payload: {} }
  if (action.kind === 'askSelection') {
    return {
      channel: 'host:askSelection',
      payload: { path: action.path, startLine: action.startLine, endLine: action.endLine, mode: action.mode }
    }
  }
  if (action.kind === 'externalFocus') {
    return { channel: 'host:externalFocus', payload: { map: action.map, nodes: action.nodes, flow: action.flow, note: action.note } }
  }
  if (action.kind === 'externalProposal') {
    return { channel: 'host:externalProposal', payload: { sessionId: action.sessionId, changeSetId: action.changeSetId } }
  }
  return { channel: 'host:revealProject', payload: { path: action.path } }
}

function enqueueHostAction(queue: PendingHostAction[], action: PendingHostAction): void {
  const previous = queue.at(-1)
  if (previous && (action.kind === 'cursor' || action.kind === 'mode' || action.kind === 'sidebarSide' || action.kind === 'openAiSettings') && previous.kind === action.kind) {
    queue[queue.length - 1] = action
    return
  }
  queue.push(action)
}

function createSurfaceSlot(): SurfaceSlot {
  return { session: createWebviewSession(), parked: [] }
}

export class SurfaceHub {
  private readonly surfaces: Record<WebviewSurface, SurfaceSlot> = {
    sidebar: createSurfaceSlot(),
    panel: createSurfaceSlot()
  }

  attach(surface: WebviewSurface, post: HostPoster): void {
    const slot = this.surfaces[surface]
    resetWebviewSession(slot.session)
    slot.post = post
    if (slot.parked.length) {
      slot.session.pending = slot.parked.splice(0)
    }
  }

  detach(surface: WebviewSurface): void {
    const slot = this.surfaces[surface]
    slot.post = undefined
    resetWebviewSession(slot.session)
  }

  has(surface: WebviewSurface): boolean {
    return this.surfaces[surface].post != null
  }

  markReady(surface: WebviewSurface): DeliveredHostAction[] {
    const slot = this.surfaces[surface]
    const delivered = flushReady(slot.session)
    if (slot.post) {
      for (const action of delivered) slot.post({ type: 'event', channel: action.channel, payload: action.payload })
    }
    return delivered
  }

  send(surface: WebviewSurface, action: PendingHostAction): boolean {
    const slot = this.surfaces[surface]
    if (!slot.post) {
      enqueueHostAction(slot.parked, action)
      return false
    }
    const delivered = queueHostAction(slot.session, action)
    if (!delivered) return false
    slot.post({ type: 'event', channel: delivered.channel, payload: delivered.payload })
    return true
  }

  broadcast(channel: string, payload?: unknown): void {
    for (const surface of ['sidebar', 'panel'] as const) {
      this.surfaces[surface].post?.({ type: 'event', channel, payload })
    }
  }

  broadcastAction(action: PendingHostAction): void {
    for (const surface of ['sidebar', 'panel'] as const) {
      if (this.has(surface)) this.send(surface, action)
    }
  }
}

export interface CursorFollowTimer {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

const defaultCursorTimer: CursorFollowTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export class CursorFollowController {
  private enabled = true
  private pending: { path: string; line: number } | null = null
  private timerHandle: unknown = null
  private lastEmitted: { path: string; line: number } | null = null

  constructor(
    private readonly onFollow: (target: { path: string; line: number }) => void,
    private readonly debounceMs = 250,
    private readonly clock: CursorFollowTimer = defaultCursorTimer
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.cancel()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  update(filePath: string | null | undefined, line1Based: number): void {
    if (!this.enabled || !filePath) return
    const next = { path: filePath, line: line1Based }
    if (this.lastEmitted && this.lastEmitted.path === next.path && this.lastEmitted.line === next.line && !this.pending) return
    this.pending = next
    this.arm()
  }

  flush(): void {
    if (!this.pending || !this.enabled) {
      this.cancel()
      return
    }
    const target = this.pending
    this.pending = null
    this.cancel()
    this.emit(target)
  }

  dispose(): void {
    this.cancel()
    this.pending = null
  }

  private arm(): void {
    this.cancel()
    this.timerHandle = this.clock.set(() => {
      this.timerHandle = null
      const target = this.pending
      this.pending = null
      if (!this.enabled || !target) return
      this.emit(target)
    }, this.debounceMs)
  }

  private emit(target: { path: string; line: number }): void {
    if (this.lastEmitted && this.lastEmitted.path === target.path && this.lastEmitted.line === target.line) return
    this.lastEmitted = target
    this.onFollow(target)
  }

  private cancel(): void {
    if (this.timerHandle == null) return
    this.clock.clear(this.timerHandle)
    this.timerHandle = null
  }

}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function rootElement(root: string, name: string, surface: WebviewSurface = 'panel', sidebarSide: SidebarSide = 'left'): string {
  return `<div id="root" data-workspace-root="${escapeHtml(root)}" data-workspace-name="${escapeHtml(name)}" data-surface="${surface}" data-sidebar-side="${sidebarSide}"></div>`
}

export async function closeSidebarHost(deps: {
  isVisible: () => boolean
  container: SidebarContainerKind
  closePrimary: () => PromiseLike<unknown>
  closeAuxiliary: () => PromiseLike<unknown>
}): Promise<SidebarContainerKind> {
  if (!deps.isVisible()) return deps.container
  if (deps.container === 'primary') await deps.closePrimary()
  else await deps.closeAuxiliary()
  if (!deps.isVisible()) return deps.container
  const detected: SidebarContainerKind = deps.container === 'primary' ? 'auxiliary' : 'primary'
  if (detected === 'primary') await deps.closePrimary()
  else await deps.closeAuxiliary()
  return detected
}

/** Drops a legacy persisted `openTarget` and keeps every field that is still valid. */
export function sanitizeSnapshot(raw: unknown, _surface?: WebviewSurface, _previous?: NavigationSnapshot): NavigationSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const incoming = raw as Partial<NavigationSnapshot>
  if (incoming.mode !== 'map' && incoming.mode !== 'codemap') return null
  const snapshot: NavigationSnapshot = { mode: incoming.mode }
  if (typeof incoming.projectFocusRel === 'string') snapshot.projectFocusRel = incoming.projectFocusRel
  if (incoming.codemapLibrary === null || typeof incoming.codemapLibrary === 'string') snapshot.codemapLibrary = incoming.codemapLibrary
  if (Array.isArray(incoming.codemapStack) && incoming.codemapStack.every((id) => typeof id === 'string')) snapshot.codemapStack = incoming.codemapStack
  if (incoming.codemapFlowId === null || typeof incoming.codemapFlowId === 'string') snapshot.codemapFlowId = incoming.codemapFlowId
  if (incoming.codemapFocus === null || typeof incoming.codemapFocus === 'string') snapshot.codemapFocus = incoming.codemapFocus
  if (typeof incoming.codemapReqIndex === 'number' && Number.isFinite(incoming.codemapReqIndex)) snapshot.codemapReqIndex = incoming.codemapReqIndex
  if (typeof incoming.codemapReqOn === 'boolean') snapshot.codemapReqOn = incoming.codemapReqOn
  if (typeof incoming.followCursor === 'boolean') snapshot.followCursor = incoming.followCursor
  return snapshot
}

/** CSP for the webview document. `connect-src` must include the webview origin so `__lumenLazyWorker` can `fetch()` `*.worker.js`. */
export function buildWebviewCsp(cspSource: string, nonce: string): string {
  return [
    `default-src 'none'`,
    `img-src ${cspSource} data: blob:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} data:`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `connect-src ${cspSource}`,
    `worker-src blob:`
  ].join('; ')
}
