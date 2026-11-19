import { LocateFixed, Map as MapIcon, Maximize2, PanelBottom, PanelLeft, PanelLeftOpen, PanelRight, Workflow } from 'lucide-react'
import type { FC } from 'react'
import { t, useLocale } from '../../../src/renderer/src/lib/i18n'
import { liftOff } from '../../../src/renderer/src/services/projectMap'
import { useStore } from '../../../src/renderer/src/state/store'
import { request } from './installBridge'
import { setVscodePrefs, useVscodePrefs } from './prefs'

export const VscodeTopBar: FC<{
  onSelectMode(mode: 'map' | 'codemap'): void
  onToggleFollow?: (next: boolean) => void
  onExpandToPanel?: () => void
  onCollapseToSidebar?: () => void
}> = function VscodeTopBar({ onSelectMode, onToggleFollow, onExpandToPanel, onCollapseToSidebar }) {
  useLocale()
  const { surface, followCursor, sidebarDrawerOpen, sidebarSide } = useVscodePrefs()
  const explorerMode = useStore((state) => state.explorerMode)
  const workspace = useStore((state) => state.workspace)
  const mapEditorOpen = useStore((state) => state.mapEditorOpen)
  const sidebar = surface === 'sidebar'

  const toggleFollow = () => {
    const next = !followCursor
    if (onToggleFollow) onToggleFollow(next)
    else setVscodePrefs({ followCursor: next })
  }
  const expand = () => {
    if (onExpandToPanel) onExpandToPanel()
    else void request('host:expandToPanel')
  }
  const collapse = () => {
    if (onCollapseToSidebar) onCollapseToSidebar()
    else void request('host:collapseToSidebar')
  }
  const dockRight = sidebar && sidebarSide === 'right'
  const ExpandIcon = dockRight ? PanelLeftOpen : Maximize2

  return (
    <header className={`lumen-vscode-topbar${sidebar ? ' is-sidebar' : ''}`}>
      <div className="lumen-vscode-topbar-side">
        {sidebar ? null : (
          <span className="lumen-vscode-workspace" title={workspace?.root}>
            {workspace?.name || t('No folder open')}
          </span>
        )}
        <div className="lumen-vscode-modes" role="radiogroup" aria-label={t('Explorer mode')}>
          <button
            type="button"
            role="radio"
            aria-checked={explorerMode === 'map'}
            className={explorerMode === 'map' ? 'is-on' : undefined}
            title={`${t('Project Map')} (⇧⌘M / Ctrl+Shift+M)`}
            disabled={!workspace}
            onClick={() => onSelectMode('map')}
          >
            <MapIcon size={14} />
            <span>{sidebar ? t('Map') : t('Project Map')}</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={explorerMode === 'codemap'}
            className={explorerMode === 'codemap' ? 'is-on' : undefined}
            title={`${t('Code Map')} (⇧⌘Y / Ctrl+Shift+Y)`}
            disabled={!workspace}
            onClick={() => onSelectMode('codemap')}
          >
            <Workflow size={14} />
            <span>{sidebar ? t('Architecture') : t('Code Map')}</span>
          </button>
        </div>
      </div>

      <div className="lumen-vscode-topbar-side is-right">
        <button
          type="button"
          className={`lumen-vscode-action${followCursor ? ' is-on' : ''}`}
          aria-pressed={followCursor}
          title={t('Follow Active Editor Cursor')}
          onClick={toggleFollow}
        >
          <LocateFixed size={13} />
          <span>{t('Follow')}</span>
        </button>
        {sidebar ? (
          <>
            <button
              type="button"
              className={`lumen-vscode-action${sidebarDrawerOpen ? ' is-on' : ''}`}
              aria-pressed={sidebarDrawerOpen}
              title={t('Toggle Details / Prefixes Drawer')}
              onClick={() => setVscodePrefs({ sidebarDrawerOpen: !sidebarDrawerOpen })}
            >
              <PanelBottom size={13} />
              <span>{t('Info')}</span>
            </button>
            <button type="button" className="lumen-vscode-action" title={t('Open Full Map in Editor Area')} onClick={expand}>
              <ExpandIcon size={13} />
              <span>{t('Expand')}</span>
            </button>
          </>
        ) : (
          <>
            <button type="button" className="lumen-vscode-action" title={t('Dock Map in Sidebar')} onClick={collapse}>
              {sidebarSide === 'right' ? <PanelRight size={13} /> : <PanelLeft size={13} />}
              <span>{t('Sidebar')}</span>
            </button>
            {mapEditorOpen ? (
              <button type="button" className="lumen-vscode-back" title={t('Back to Map (Esc)')} onClick={liftOff}>
                <span>{t('Back to Map')}</span>
                <kbd>Esc</kbd>
              </button>
            ) : null}
          </>
        )}
      </div>
    </header>
  )
}
