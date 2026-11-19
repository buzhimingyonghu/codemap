import { afterEach, expect, test, vi } from 'vitest'
import {
  CursorFollowController,
  SurfaceHub,
  closeSidebarHost,
  resolveSidebarSide,
  rootElement,
  sanitizeSnapshot,
  type HostPostEvent,
  type NavigationSnapshot
} from '../src/host/session'

afterEach(() => {
  vi.useRealTimers()
})

function capture(): { post: (event: HostPostEvent) => void; events: HostPostEvent[] } {
  const events: HostPostEvent[] = []
  return { events, post: (event) => events.push(event) }
}

test('root markup keeps the panel attribute by default and names the sidebar', () => {
  const panel = rootElement('/work/"a&b<c>"', 'map "one"')
  expect(panel).toContain('data-workspace-root="/work/&quot;a&amp;b&lt;c&gt;&quot;"')
  expect(panel).toContain('data-workspace-name="map &quot;one&quot;"')
  expect(panel).toContain('data-surface="panel"')
  expect(panel).toContain('data-sidebar-side="left"')
  expect(rootElement('/repo', 'side', 'sidebar')).toContain('data-surface="sidebar"')
  expect(rootElement('/repo', 'side', 'sidebar', 'right')).toContain('data-sidebar-side="right"')
  expect(rootElement('/repo', 'main', 'panel', 'right')).toContain('data-surface="panel"')
})

test('sidebar side follows the primary bar and flips for the auxiliary bar', () => {
  expect(resolveSidebarSide(undefined)).toBe('left')
  expect(resolveSidebarSide('left')).toBe('left')
  expect(resolveSidebarSide('right')).toBe('right')
  expect(resolveSidebarSide('other', 'primary')).toBe('left')
  expect(resolveSidebarSide('left', 'auxiliary')).toBe('right')
  expect(resolveSidebarSide('right', 'auxiliary')).toBe('left')
  expect(resolveSidebarSide(undefined, 'auxiliary')).toBe('right')
})

test('surfaces queue until ready, coalesce repeats, and broadcast only attached views', () => {
  const hub = new SurfaceHub()
  const sidebar = capture()
  const panel = capture()

  expect(hub.send('sidebar', { kind: 'mode', mode: 'map' })).toBe(false)
  expect(hub.send('sidebar', { kind: 'mode', mode: 'codemap' })).toBe(false)
  expect(hub.send('sidebar', { kind: 'cursor', path: '/repo/a.ts', line: 1 })).toBe(false)
  expect(hub.send('sidebar', { kind: 'cursor', path: '/repo/a.ts', line: 9 })).toBe(false)
  expect(hub.send('sidebar', { kind: 'sidebarSide', side: 'left' })).toBe(false)
  expect(hub.send('sidebar', { kind: 'sidebarSide', side: 'right' })).toBe(false)
  hub.attach('sidebar', sidebar.post)
  expect(hub.has('sidebar')).toBe(true)
  expect(hub.has('panel')).toBe(false)

  expect(hub.markReady('sidebar')).toEqual([
    { channel: 'host:mode', payload: { mode: 'codemap' } },
    { channel: 'host:cursor', payload: { path: '/repo/a.ts', line: 9 } },
    { channel: 'host:sidebarSide', payload: { side: 'right' } }
  ])
  expect(sidebar.events).toEqual([
    { type: 'event', channel: 'host:mode', payload: { mode: 'codemap' } },
    { type: 'event', channel: 'host:cursor', payload: { path: '/repo/a.ts', line: 9 } },
    { type: 'event', channel: 'host:sidebarSide', payload: { side: 'right' } }
  ])

  hub.attach('panel', panel.post)
  const snapshot: NavigationSnapshot = { mode: 'map', followCursor: true, codemapStack: ['root'] }
  expect(hub.send('panel', { kind: 'snapshot', snapshot })).toBe(false)
  expect(hub.markReady('panel')).toEqual([{ channel: 'host:snapshot', payload: snapshot }])

  hub.broadcast('fs:changed', { path: '/repo/a.ts' })
  hub.broadcastAction({ kind: 'revealProject', path: '/repo/a.ts' })
  expect(sidebar.events.at(-2)).toEqual({ type: 'event', channel: 'fs:changed', payload: { path: '/repo/a.ts' } })
  expect(sidebar.events.at(-1)).toEqual({ type: 'event', channel: 'host:revealProject', payload: { path: '/repo/a.ts' } })
  expect(panel.events.at(-2)).toEqual({ type: 'event', channel: 'fs:changed', payload: { path: '/repo/a.ts' } })
  expect(panel.events.at(-1)).toEqual({ type: 'event', channel: 'host:revealProject', payload: { path: '/repo/a.ts' } })

  hub.detach('sidebar')
  expect(hub.has('sidebar')).toBe(false)
  hub.broadcast('codemap:changed')
  expect(sidebar.events.some((event) => event.channel === 'codemap:changed')).toBe(false)
  expect(panel.events.at(-1)).toEqual({ type: 'event', channel: 'codemap:changed', payload: undefined })

  hub.detach('panel')
  expect(hub.send('panel', { kind: 'openAiSettings' })).toBe(false)
  expect(hub.send('panel', { kind: 'askSelection', path: '/repo/src/pay.ts', startLine: 2, endLine: 6, mode: 'adjust' })).toBe(false)
  expect(hub.send('panel', { kind: 'externalFocus', map: null, nodes: ['order'], flow: null, note: 'queued' })).toBe(false)
  expect(hub.send('panel', { kind: 'externalProposal', sessionId: 's1', changeSetId: 'c1' })).toBe(false)
  const reattached = capture()
  hub.attach('panel', reattached.post)
  expect(hub.markReady('panel').map((action) => action.channel)).toEqual([
    'host:openAiSettings',
    'host:askSelection',
    'host:externalFocus',
    'host:externalProposal'
  ])
  expect(reattached.events.map((event) => event.channel)).toEqual([
    'host:openAiSettings',
    'host:askSelection',
    'host:externalFocus',
    'host:externalProposal'
  ])
})

test('cursor follow debounces, drops duplicates, and cancels when disabled', () => {
  vi.useFakeTimers()
  const followed: Array<{ path: string; line: number }> = []
  const cursor = new CursorFollowController((target) => followed.push(target), 250)
  expect(cursor.isEnabled()).toBe(true)

  cursor.update('', 1)
  cursor.update(null, 1)
  cursor.update('/repo/a.ts', 4)
  cursor.update('/repo/a.ts', 5)
  cursor.update('/repo/a.ts', 8)
  expect(followed).toEqual([])
  vi.advanceTimersByTime(249)
  expect(followed).toEqual([])
  vi.advanceTimersByTime(1)
  expect(followed).toEqual([{ path: '/repo/a.ts', line: 8 }])

  cursor.update('/repo/a.ts', 8)
  vi.advanceTimersByTime(250)
  expect(followed).toEqual([{ path: '/repo/a.ts', line: 8 }])

  cursor.update('/repo/b.ts', 2)
  cursor.setEnabled(false)
  vi.advanceTimersByTime(250)
  expect(followed).toHaveLength(1)
  cursor.setEnabled(true)
  cursor.update('/repo/b.ts', 3)
  cursor.flush()
  expect(followed).toEqual([
    { path: '/repo/a.ts', line: 8 },
    { path: '/repo/b.ts', line: 3 }
  ])

  cursor.update('/repo/c.ts', 1)
  cursor.dispose()
  vi.advanceTimersByTime(250)
  expect(followed).toHaveLength(2)
})

test('closing the sidebar host is a no-op while hidden and remembers a dragged bar', async () => {
  const calls: string[] = []
  let visible = false
  const hidden = await closeSidebarHost({
    isVisible: () => visible,
    container: 'primary',
    closePrimary: async () => {
      calls.push('primary')
    },
    closeAuxiliary: async () => {
      calls.push('auxiliary')
    }
  })
  expect(hidden).toBe('primary')
  expect(calls).toEqual([])

  visible = true
  const stayedPrimary = await closeSidebarHost({
    isVisible: () => {
      if (calls.includes('primary-close')) visible = false
      return visible
    },
    container: 'primary',
    closePrimary: async () => {
      calls.push('primary-close')
      visible = false
    },
    closeAuxiliary: async () => {
      calls.push('auxiliary-close')
    }
  })
  expect(stayedPrimary).toBe('primary')
  expect(calls).toEqual(['primary-close'])

  let dragged = true
  const detectedAuxiliary = await closeSidebarHost({
    isVisible: () => dragged,
    container: 'primary',
    closePrimary: async () => {
      calls.push('miss-primary')
    },
    closeAuxiliary: async () => {
      calls.push('hit-auxiliary')
      dragged = false
    }
  })
  expect(detectedAuxiliary).toBe('auxiliary')

  let stillAuxiliary = true
  const remembered = await closeSidebarHost({
    isVisible: () => stillAuxiliary,
    container: detectedAuxiliary,
    closePrimary: async () => {
      calls.push('primary-again')
    },
    closeAuxiliary: async () => {
      calls.push('auxiliary-again')
      stillAuxiliary = false
    }
  })
  expect(remembered).toBe('auxiliary')

  let draggedBack = true
  const detectedPrimary = await closeSidebarHost({
    isVisible: () => draggedBack,
    container: 'auxiliary',
    closeAuxiliary: async () => {
      calls.push('miss-auxiliary')
    },
    closePrimary: async () => {
      calls.push('hit-primary')
      draggedBack = false
    }
  })
  expect(detectedPrimary).toBe('primary')
  expect(calls).toEqual(['primary-close', 'miss-primary', 'hit-auxiliary', 'auxiliary-again', 'miss-auxiliary', 'hit-primary'])
})

test('legacy snapshots drop openTarget and keep the remaining navigation', () => {
  const sanitized = sanitizeSnapshot({
    mode: 'codemap',
    openTarget: 'rising',
    followCursor: true,
    codemapStack: ['root'],
    codemapLibrary: null,
    codemapFlowId: 'checkout',
    codemapFocus: 'pay',
    codemapReqIndex: 2,
    codemapReqOn: false,
    projectFocusRel: 'src/app.ts'
  }, 'panel', { mode: 'map' })
  expect(sanitized).toEqual({
    mode: 'codemap',
    projectFocusRel: 'src/app.ts',
    codemapLibrary: null,
    codemapStack: ['root'],
    codemapFlowId: 'checkout',
    codemapFocus: 'pay',
    codemapReqIndex: 2,
    codemapReqOn: false,
    followCursor: true
  })
  expect(sanitized).not.toHaveProperty('openTarget')
  expect(sanitizeSnapshot({ mode: 'other', openTarget: 'vscode' })).toBeNull()
  expect(sanitizeSnapshot(null)).toBeNull()
})
