import type { ComponentType } from 'react'
import type { Disposable } from '../lib/events'
import { getState, setState } from '../state/store'

export type ViewLocation = 'sidebar' | 'panel'

// Built-in views render React components; plugin views receive a DOM element and
// can render with any library. Both are stored in the same registry.
export interface ViewContribution {
  id: string
  title: string
  location: ViewLocation
  icon?: string
  order?: number
  source: string
  component?: ComponentType
  mount?: (element: HTMLElement) => void | (() => void) | Disposable
  badge?: () => number | undefined
}

const views = new Map<string, ViewContribution>()

// Views that only make sense with a folder open; hidden on the welcome screen.
export const FOLDER_VIEWS = new Set(['explorer', 'search', 'git', 'debug'])

function bump(): void {
  setState({ registryVersion: getState().registryVersion + 1 })
}

export function registerView(view: ViewContribution): Disposable {
  views.set(view.id, view)
  bump()
  return {
    dispose: () => {
      if (views.get(view.id) === view) {
        views.delete(view.id)
        const state = getState()
        if (state.sidebarView === view.id) setState({ sidebarView: 'explorer' })
        if (state.panelView === view.id) setState({ panelView: 'output' })
        bump()
      }
    }
  }
}

export function getView(id: string): ViewContribution | undefined {
  return views.get(id)
}

export function listViews(location: ViewLocation): ViewContribution[] {
  return [...views.values()].filter((view) => view.location === location).sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

export function showView(id: string): void {
  const view = views.get(id)
  if (!view) return
  if (view.location === 'sidebar') setState({ sidebarView: id, sidebarVisible: true })
  else setState({ panelView: id, panelVisible: true })
}
