import { Clock, FolderOpen } from 'lucide-react'
import { t } from '../lib/i18n'
import { openFolderDialog, openFolderPath } from '../services/workspace'
import { useStore } from '../state/store'

export function Welcome() {
  const workspace = useStore((s) => s.workspace)
  const recent = useStore((s) => s.recentFolders)
  const home = recent[0]?.match(/^\/Users\/[^/]+/)?.[0]

  if (workspace) {
    return (
      <div className="welcome welcome--workspace">
        <div className="welcome-mark" aria-hidden="true" />
        <div className="shortcut-grid">
          <span>{t('Go to File')}</span>
          <kbd>⌘P</kbd>
          <span>{t('Commands')}</span>
          <kbd>⇧⌘P</kbd>
          <span>{t('Build')}</span>
          <kbd>⇧⌘B</kbd>
          <span>{t('Debug')}</span>
          <kbd>F5</kbd>
        </div>
      </div>
    )
  }

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-brand">
          <div className="welcome-mark" aria-hidden="true" />
          <h1>Codemap</h1>
        </div>
        <button type="button" className="button button--primary button--large" onClick={() => void openFolderDialog()}>
          <FolderOpen size={16} />
          <span>{t('Open Folder')}</span>
          <kbd>⌘O</kbd>
        </button>
        {recent.length ? (
          <section className="recent">
            <h2>
              <Clock size={13} />
              <span>{t('Recent')}</span>
            </h2>
            <ul>
              {recent.slice(0, 7).map((folder) => {
                const name = folder.split('/').pop()
                return (
                  <li key={folder}>
                    <button type="button" className="recent-item" onClick={() => void openFolderPath(folder)}>
                      <span className="recent-name">{name}</span>
                      <span className="recent-path">{home ? folder.replace(home, '~') : folder}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  )
}
