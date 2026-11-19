import { useSyncExternalStore } from 'react'

export type WebviewSurface = 'sidebar' | 'panel'
export type SidebarSide = 'left' | 'right'

export interface VscodePrefs {
  surface: WebviewSurface
  followCursor: boolean
  /** Narrow sidebar only: floating summary/detail drawer over the map canvas. */
  sidebarDrawerOpen: boolean
  sidebarSide: SidebarSide
}

function initialSidebarSide(): SidebarSide {
  if (typeof document === 'undefined') return 'left'
  return document.getElementById('root')?.dataset.sidebarSide === 'right' ? 'right' : 'left'
}

function initialSurface(): WebviewSurface {
  if (typeof document === 'undefined') return 'panel'
  return document.getElementById('root')?.dataset.surface === 'sidebar' ? 'sidebar' : 'panel'
}

function initialPrefs(): VscodePrefs {
  const surface = initialSurface()
  const sidebar = surface === 'sidebar'
  return {
    surface,
    followCursor: sidebar,
    sidebarDrawerOpen: false,
    sidebarSide: initialSidebarSide()
  }
}

let prefs: VscodePrefs = initialPrefs()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getVscodePrefs(): VscodePrefs {
  return prefs
}

export function setVscodePrefs(patch: Partial<VscodePrefs>): void {
  const next: VscodePrefs = { ...prefs, ...patch }
  if (
    next.surface === prefs.surface &&
    next.followCursor === prefs.followCursor &&
    next.sidebarDrawerOpen === prefs.sidebarDrawerOpen &&
    next.sidebarSide === prefs.sidebarSide
  ) {
    return
  }
  prefs = next
  emit()
}

export function subscribeVscodePrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useVscodePrefs(): VscodePrefs {
  return useSyncExternalStore(subscribeVscodePrefs, getVscodePrefs, getVscodePrefs)
}

let revealDepth = 0

/** True while a programmatic highlight should not steal the native VS Code editor. */
export function isInternalReveal(): boolean {
  return revealDepth > 0
}

export async function withInternalReveal<T>(fn: () => Promise<T>): Promise<T> {
  revealDepth += 1
  try {
    return await fn()
  } finally {
    revealDepth -= 1
  }
}
