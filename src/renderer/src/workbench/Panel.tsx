import { Trash, X } from 'lucide-react'
import { IconButton } from '../components/IconButton'
import { t } from '../lib/i18n'
import { clearOutput } from '../services/build'
import { listViews } from '../services/views'
import { setState, useStore } from '../state/store'
import { ViewHost } from './ViewHost'
import { TerminalActions } from '../views/TerminalView'

export function Panel() {
  useStore((s) => s.registryVersion)
  const panelView = useStore((s) => s.panelView)
  const problemCount = useStore((s) => s.diagnostics.length)
  const buildStatus = useStore((s) => s.build.status)
  const views = listViews('panel')
  const active = views.find((view) => view.id === panelView) ?? views[0]

  return (
    <section className="panel" aria-label={t('Panel')}>
      <div className="panel-header">
        <div className="panel-tabs" role="tablist">
          {views.map((view) => (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={view.id === active?.id}
              className={`panel-tab${view.id === active?.id ? ' is-active' : ''}`}
              onClick={() => setState({ panelView: view.id })}
            >
              <span>{t(view.title)}</span>
              {view.id === 'problems' && problemCount ? <span className="count-badge">{problemCount}</span> : null}
              {view.id === 'output' && buildStatus === 'running' ? <span className="build-pulse" /> : null}
            </button>
          ))}
        </div>
        <div className="panel-actions">
          {active?.id === 'terminal' ? <TerminalActions /> : null}
          {active?.id === 'output' ? (
            <IconButton size="sm" label={t('Clear Output')} onClick={clearOutput}>
              <Trash size={13} />
            </IconButton>
          ) : null}
          {active?.id === 'debugConsole' ? (
            <IconButton size="sm" label={t('Clear Console')} onClick={() => setState({ debugConsole: [] })}>
              <Trash size={13} />
            </IconButton>
          ) : null}
          <IconButton size="sm" label={t('Close Panel')} onClick={() => setState({ panelVisible: false })}>
            <X size={14} />
          </IconButton>
        </div>
      </div>
      <div className="panel-body">{active ? <ViewHost key={active.id} view={active} /> : null}</div>
    </section>
  )
}
