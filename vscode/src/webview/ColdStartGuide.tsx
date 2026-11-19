import { FolderOpen, Map as MapIcon, Sparkles, Workflow } from 'lucide-react'
import { useState, type FC } from 'react'
import { t, useLocale } from '../../../src/renderer/src/lib/i18n'
import { addRepos, getAgent, setMode } from '../../../src/renderer/src/services/agent'
import { chooseLibrary, reloadCodeMap } from '../../../src/renderer/src/services/codeMap'
import { reportError } from '../../../src/renderer/src/services/ui'
import { getState } from '../../../src/renderer/src/state/store'
import { request } from './installBridge'
import { getVscodePrefs, setVscodePrefs } from './prefs'

export const ColdStartGuide: FC<{ onSelectMode(mode: 'map' | 'codemap'): void; onExpandToPanel(): void }> = function ColdStartGuide({
  onSelectMode,
  onExpandToPanel
}) {
  useLocale()
  const [busy, setBusy] = useState(false)

  const initialize = async () => {
    if (busy) return
    setBusy(true)
    try {
      await request('codemap:initDefaultLibrary')
      await reloadCodeMap()
      await setMode('create')
      await seedWorkspaceRepo()
      if (getVscodePrefs().surface === 'sidebar') {
        setVscodePrefs({ sidebarDrawerOpen: true })
        onExpandToPanel()
      }
    } catch (error) {
      reportError(error, t('Cannot initialize codemap/'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cm-placeholder cm-cold-start">
      <div className="cm-cold-cards">
        <article className="cm-cold-card">
          <MapIcon size={18} />
          <h3>{t('Project Map')}</h3>
          <p>{t('A zero-config bird’s-eye view of any repository: its directory territory and hot files.')}</p>
        </article>
        <article className="cm-cold-card">
          <Workflow size={18} />
          <h3>{t('Architecture Map')}</h3>
          <p>{t('Drill from the business into modules, call lines, and live execution flow, with four AI build modes and self-healing rules.')}</p>
        </article>
      </div>
      <div className="cm-placeholder-actions cm-cold-actions">
        <button type="button" className="button button--primary" disabled={busy} onClick={() => void initialize()}>
          <Sparkles size={14} />
          {busy ? t('Initializing codemap/…') : t('Initialize codemap/ & Build with AI')}
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => void chooseLibrary()}>
          <FolderOpen size={14} />
          {t('Choose an existing node library…')}
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => onSelectMode('map')}>
          <MapIcon size={14} />
          {t('Look at the project map first')}
        </button>
      </div>
    </div>
  )
}

async function seedWorkspaceRepo(): Promise<void> {
  const root = getState().workspace?.root
  if (!root || getAgent().repos.length) return
  const agent = window.codemap.agent
  const original = agent.pickRepos
  agent.pickRepos = () => Promise.resolve([root])
  try {
    await addRepos()
  } finally {
    agent.pickRepos = original
  }
}
