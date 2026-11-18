import { ChevronRight } from 'lucide-react'
import { FileIcon } from '../components/Icon'
import { t } from '../lib/i18n'
import { revealInExplorer } from '../services/projectMap'
import { useStore, type Tab } from '../state/store'

export function Breadcrumbs({ tab }: { tab: Tab }) {
  const root = useStore((s) => s.workspace?.root ?? '')
  if (!tab.path) {
    return (
      <div className="breadcrumbs">
        <span className="crumb is-last">{tab.title}</span>
      </div>
    )
  }
  const relative = tab.path.startsWith(`${root}/`) ? tab.path.slice(root.length + 1) : tab.path
  const parts = relative.split('/')
  return (
    <nav className="breadcrumbs" aria-label={t('Path')}>
      {parts.map((part, index) => {
        const last = index === parts.length - 1
        const target = `${root}/${parts.slice(0, index + 1).join('/')}`
        return (
          <span key={target} className="crumb-wrap">
            {index > 0 ? <ChevronRight size={12} className="crumb-sep" /> : null}
            <button
              type="button"
              className={`crumb${last ? ' is-last' : ''}`}
              onClick={() => revealInExplorer(target)}
            >
              {last ? <FileIcon name={part} size={13} /> : null}
              <span>{part}</span>
            </button>
          </span>
        )
      })}
      {tab.kind === 'diff' ? <span className="crumb-tag">{tab.staged ? t('Staged') : t('Working Tree')}</span> : null}
    </nav>
  )
}
