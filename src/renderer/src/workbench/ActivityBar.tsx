import { Settings } from 'lucide-react'
import { NamedIcon } from '../components/Icon'
import { t } from '../lib/i18n'
import { showExplorer } from '../services/projectMap'
import { FOLDER_VIEWS, listViews } from '../services/views'
import { getState, setState, useStore } from '../state/store'

export function ActivityBar() {
  useStore((s) => s.registryVersion)
  const sidebarView = useStore((s) => s.sidebarView)
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const hasWorkspace = useStore((s) => Boolean(s.workspace))
  const mapMode = useStore((s) => s.explorerMode !== 'classic') && hasWorkspace
  const editorOverMap = useStore((s) => s.mapEditorOpen && s.tabs.length > 0)
  const mapShowing = mapMode && !editorOverMap
  const gitCount = useStore((s) => s.git?.files.length ?? 0)
  const debugState = useStore((s) => s.debug.state)
  const views = listViews('sidebar')

  const select = (id: string) => {
    const state = getState()
    // In map mode the explorer is the map in the main area, so the item brings the map back
    // (closing any other sidebar view) instead of toggling the sidebar.
    if (id === 'explorer' && mapMode) {
      showExplorer()
      return
    }
    if (state.sidebarView === id && state.sidebarVisible) setState({ sidebarVisible: false })
    else setState({ sidebarView: id, sidebarVisible: true })
  }

  return (
    <nav className="activitybar" aria-label={t('Views')}>
      <div className="activity-items">
        {views.map((view) => {
          const active =
            view.id === 'explorer' && mapMode
              ? mapShowing && (!sidebarVisible || sidebarView === 'explorer')
              : sidebarVisible && sidebarView === view.id && (hasWorkspace || !FOLDER_VIEWS.has(view.id))
          const badge = view.id === 'git' ? gitCount : undefined
          const live = view.id === 'debug' && debugState !== 'idle' && debugState !== 'terminated'
          return (
            <button
              key={view.id}
              type="button"
              className={`activity-item${active ? ' is-active' : ''}`}
              aria-label={t(view.title)}
              aria-pressed={active}
              data-tooltip={t(view.title)}
              data-tooltip-placement="right"
              onClick={() => select(view.id)}
            >
              <span className="activity-indicator" aria-hidden="true" />
              <NamedIcon name={view.icon} size={19} strokeWidth={1.7} />
              {badge ? <span className="activity-badge">{badge > 99 ? '99+' : badge}</span> : null}
              {live ? <span className="activity-live" aria-hidden="true" /> : null}
            </button>
          )
        })}
      </div>
      <div className="activity-items">
        <button
          type="button"
          className="activity-item"
          aria-label={t('Settings')}
          data-tooltip={t('Settings (⌘,)')}
          data-tooltip-placement="right"
          onClick={() => setState({ settingsOpen: true })}
        >
          <Settings size={19} strokeWidth={1.7} />
        </button>
      </div>
    </nav>
  )
}
