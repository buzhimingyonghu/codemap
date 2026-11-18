import { useCallback } from 'react'
import { Resizer } from '../components/Resizer'
import { FOLDER_VIEWS, getView, listViews } from '../services/views'
import { getState, setState, useStore } from '../state/store'
import { ActivityBar } from './ActivityBar'
import { EditorArea } from './EditorArea'
import { PromptDialog, Toasts } from './Overlays'
import { Panel } from './Panel'
import { QuickPick } from './QuickPick'
import { SettingsSheet } from './SettingsSheet'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'
import { ViewHost } from './ViewHost'
import { TooltipLayer } from '../components/Tooltip'
import { t } from '../lib/i18n'
import { ProjectMapView } from '../views/ProjectMap'
import { CodeMapView } from '../views/CodeMap'

export function Workbench() {
  useStore((s) => s.registryVersion)
  const hasWorkspace = useStore((s) => Boolean(s.workspace))
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const sidebarView = useStore((s) => s.sidebarView)
  const panelVisible = useStore((s) => s.panelVisible)
  const panelHeight = useStore((s) => s.panelHeight)
  const explorerMode = useStore((s) => s.explorerMode)
  const mapMode = explorerMode !== 'classic' && hasWorkspace
  const view = getView(sidebarView) ?? listViews('sidebar')[0]
  // Folder-bound views have nothing to show before a folder is open; the welcome screen covers that.
  // In either map mode the map is the explorer, so the tree sidebar steps aside; other views stay.
  const showSidebar = sidebarVisible && Boolean(view) && (hasWorkspace || !FOLDER_VIEWS.has(view.id)) && !(mapMode && view.id === 'explorer')

  const resizeSidebar = useCallback((delta: number) => {
    const next = Math.min(560, Math.max(180, getState().sidebarWidth + delta))
    setState({ sidebarWidth: next })
  }, [])
  const resizePanel = useCallback((delta: number) => {
    const max = Math.max(160, window.innerHeight - 220)
    const next = Math.min(max, Math.max(110, getState().panelHeight - delta))
    setState({ panelHeight: next })
  }, [])

  return (
    <div className={`workbench${mapMode ? ' is-map' : ''}`}>
      <TitleBar />
      <div className="workbench-body">
        <ActivityBar />
        <aside className={`sidebar${showSidebar ? '' : ' is-hidden'}`} style={{ width: showSidebar ? sidebarWidth : 0 }} aria-label={view ? t(view.title) : undefined}>
          <div className="sidebar-inner" style={{ width: sidebarWidth }}>
            {view && showSidebar ? <ViewHost key={view.id} view={view} /> : null}
          </div>
        </aside>
        {showSidebar ? <Resizer direction="horizontal" label={t('Resize sidebar')} onResize={resizeSidebar} onReset={() => setState({ sidebarWidth: 272 })} /> : null}
        <main className="main-column">
          {!mapMode ? <EditorArea /> : explorerMode === 'codemap' ? <CodeMapView /> : <ProjectMapView />}
          {panelVisible ? (
            <>
              <Resizer direction="vertical" label={t('Resize panel')} onResize={resizePanel} onReset={() => setState({ panelHeight: 240 })} />
              <div className="panel-wrap" style={{ height: panelHeight }}>
                <Panel />
              </div>
            </>
          ) : null}
        </main>
      </div>
      <StatusBar />
      <QuickPick />
      <SettingsSheet />
      <PromptDialog />
      <Toasts />
      <TooltipLayer />
    </div>
  )
}
