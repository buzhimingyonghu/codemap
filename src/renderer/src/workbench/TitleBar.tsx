import {
  ArrowLeft,
  ArrowRight,
  ArrowDownToDot,
  ArrowUpFromDot,
  Hammer,
  ListTree,
  Map as MapIcon,
  PanelBottom,
  PanelLeft,
  Pause,
  Play,
  RotateCw,
  Search,
  Square,
  StepForward,
  Workflow
} from 'lucide-react'
import { IconButton } from '../components/IconButton'
import { runBuild, stopBuild } from '../services/build'
import { control, startDebugging, stopDebugging } from '../services/debug'
import { t } from '../lib/i18n'
import { setExplorerMode } from '../services/projectMap'
import { showCodeMap } from '../services/codeMap'
import { navigateHistory, useNavigationState } from '../services/navigation'
import { setState, useStore } from '../state/store'

export function TitleBar() {
  const workspace = useStore((s) => s.workspace)
  const build = useStore((s) => s.build)
  const debug = useStore((s) => s.debug)
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const panelVisible = useStore((s) => s.panelVisible)
  const explorerMode = useStore((s) => s.explorerMode)
  const building = build.status === 'running'
  const debugging = debug.state !== 'idle' && debug.state !== 'terminated'
  const paused = debug.state === 'stopped'
  const nav = useNavigationState()

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <IconButton label={t('Toggle Sidebar (⌘B)')} active={sidebarVisible} onClick={() => setState({ sidebarVisible: !sidebarVisible })}>
          <PanelLeft size={16} />
        </IconButton>
      </div>

      <div className="titlebar-center">
        <div className={`run-cluster${debugging ? ' is-debugging' : ''}`}>
          {debugging ? (
            <>
              <IconButton label={paused ? t('Continue (F5)') : t('Pause')} tone="accent" onClick={() => void control(paused ? 'continue' : 'pause')}>
                {paused ? <Play size={15} /> : <Pause size={15} />}
              </IconButton>
              <IconButton label={t('Step Over (F10)')} disabled={!paused} onClick={() => void control('next')}>
                <StepForward size={15} />
              </IconButton>
              <IconButton label={t('Step Into (F11)')} disabled={!paused} onClick={() => void control('stepIn')}>
                <ArrowDownToDot size={15} />
              </IconButton>
              <IconButton label={t('Step Out (⇧F11)')} disabled={!paused} onClick={() => void control('stepOut')}>
                <ArrowUpFromDot size={15} />
              </IconButton>
              <IconButton label={t('Restart')} onClick={async () => {
                await stopDebugging()
                await startDebugging()
              }}>
                <RotateCw size={14} />
              </IconButton>
              <IconButton label={t('Stop (⇧F5)')} tone="danger" onClick={() => void stopDebugging()}>
                <Square size={13} fill="currentColor" />
              </IconButton>
            </>
          ) : (
            <>
              <IconButton label={building ? t('Stop Build') : t('Build (⇧⌘B)')} disabled={!workspace} tone={building ? 'danger' : 'default'} onClick={() => void (building ? stopBuild() : runBuild())}>
                {building ? <Square size={13} fill="currentColor" /> : <Hammer size={15} />}
              </IconButton>
              <IconButton label={t('Start Debugging (F5)')} disabled={!workspace} tone="accent" onClick={() => void startDebugging()}>
                <Play size={15} />
              </IconButton>
            </>
          )}
        </div>

        <div className="nav-cluster">
          <IconButton label={t('Go Back (⌃-)')} size="sm" disabled={!nav.back} onClick={() => void navigateHistory(-1)}>
            <ArrowLeft size={15} />
          </IconButton>
          <IconButton label={t('Go Forward (⌃⇧-)')} size="sm" disabled={!nav.forward} onClick={() => void navigateHistory(1)}>
            <ArrowRight size={15} />
          </IconButton>
        </div>

        <button type="button" className="command-center" disabled={!workspace} onClick={() => setState({ quickPick: { mode: 'files', session: Date.now() } })}>
          <Search size={13} />
          <span className="command-center-label">{workspace ? workspace.name : 'Codemap'}</span>
          {building ? <span className="build-pulse" aria-label={t('Building')} /> : null}
          <kbd>⌘P</kbd>
        </button>
      </div>

      <div className="titlebar-right">
        <div className="mode-switch" role="radiogroup" aria-label={t('Explorer mode')}>
          <button
            type="button"
            role="radio"
            aria-checked={explorerMode === 'classic'}
            aria-label={t('File Tree')}
            data-tooltip={t('File Tree')}
            className={explorerMode === 'classic' ? 'is-on' : undefined}
            onClick={() => setExplorerMode('classic')}
          >
            <ListTree size={14} />
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={explorerMode === 'map'}
            aria-label={t('Project Map')}
            data-tooltip={t('Project Map (⇧⌘M)')}
            className={explorerMode === 'map' ? 'is-on' : undefined}
            onClick={() => setExplorerMode('map')}
          >
            <MapIcon size={14} />
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={explorerMode === 'codemap'}
            aria-label={t('Code Map')}
            data-tooltip={t('Code Map (⇧⌘Y)')}
            className={explorerMode === 'codemap' ? 'is-on' : undefined}
            disabled={!workspace}
            onClick={() => showCodeMap()}
          >
            <Workflow size={14} />
          </button>
        </div>
        <IconButton label={t('Toggle Panel (⌘J)')} active={panelVisible} onClick={() => setState({ panelVisible: !panelVisible })}>
          <PanelBottom size={16} />
        </IconButton>
      </div>
    </header>
  )
}
