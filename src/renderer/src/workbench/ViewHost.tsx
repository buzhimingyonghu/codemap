import { useEffect, useRef } from 'react'
import type { ViewContribution } from '../services/views'

// Renders either a React view or a plugin-owned DOM view inside an error boundary-like guard.
export function ViewHost({ view }: { view: ViewContribution }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!view.mount || !ref.current) return
    const element = ref.current
    element.replaceChildren()
    let cleanup: ReturnType<NonNullable<ViewContribution['mount']>>
    try {
      cleanup = view.mount(element)
    } catch (error) {
      element.textContent = error instanceof Error ? error.message : String(error)
      element.classList.add('view-error')
      return
    }
    return () => {
      try {
        if (typeof cleanup === 'function') cleanup()
        else cleanup?.dispose()
      } catch (error) {
        console.warn(error)
      }
      element.replaceChildren()
    }
  }, [view])

  if (view.component) {
    const Component = view.component
    return <Component />
  }
  // Plugin views get the same header as built-in sidebar views so they feel native.
  return (
    <div className="plugin-view-frame">
      {view.location === 'sidebar' ? (
        <div className="view-header">
          <span className="view-title">{view.title}</span>
        </div>
      ) : null}
      <div className="plugin-view" ref={ref} data-plugin={view.source} />
    </div>
  )
}
