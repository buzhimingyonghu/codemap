import { FileDiff, GitCommitHorizontal, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { FileIcon } from '../components/Icon'
import { CodeEditor } from '../editor/CodeEditor'
import { CommitViewer } from '../editor/CommitViewer'
import { DiffViewer } from '../editor/DiffViewer'
import { closeTab, getActiveTab } from '../services/documents'
import { revealInExplorer } from '../services/projectMap'
import { t } from '../lib/i18n'
import { setState, useStore, type Tab } from '../state/store'
import { Breadcrumbs } from './Breadcrumbs'
import { Welcome } from './Welcome'

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === 'diff') return <FileDiff size={14} className="tab-icon diff" />
  if (tab.kind === 'commit') return <GitCommitHorizontal size={14} className="tab-icon commit" />
  return <FileIcon name={tab.title} size={14} />
}

function TabBar() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const dirty = useStore((s) => s.dirty)
  const stripRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const strip = stripRef.current
    const active = strip?.querySelector<HTMLElement>('.tab.is-active')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [activeTabId])

  const showMenu = async (tab: Tab) => {
    const choice = await window.codemap.app.popupMenu([
      { id: 'close', label: t('Close') },
      { id: 'others', label: t('Close Others'), enabled: tabs.length > 1 },
      { id: 'right', label: t('Close to the Right') },
      { separator: true },
      { id: 'copy', label: t('Copy Path'), enabled: Boolean(tab.path) },
      { id: 'reveal', label: t('Reveal in Explorer'), enabled: tab.kind === 'file' },
      { id: 'finder', label: t('Reveal in Finder'), enabled: tab.kind === 'file' }
    ])
    if (choice === 'close') await closeTab(tab.id)
    if (choice === 'others') for (const other of tabs.filter((t) => t.id !== tab.id)) if (!(await closeTab(other.id))) break
    if (choice === 'right') {
      const index = tabs.findIndex((t) => t.id === tab.id)
      for (const other of tabs.slice(index + 1)) if (!(await closeTab(other.id))) break
    }
    if (choice === 'copy' && tab.path) await navigator.clipboard.writeText(tab.path)
    if (choice === 'reveal' && tab.path) revealInExplorer(tab.path)
    if (choice === 'finder' && tab.path) await window.codemap.fs.reveal(tab.path)
  }

  return (
    <div className="tabbar" ref={stripRef} role="tablist" aria-label={t('Open editors')}>
      {tabs.map((tab) => {
        const isDirty = tab.kind === 'file' && tab.path ? dirty[tab.path] : false
        const active = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            className={`tab${active ? ' is-active' : ''}${isDirty ? ' is-dirty' : ''} kind-${tab.kind}`}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault()
                void closeTab(tab.id)
              } else if (event.button === 0) setState({ activeTabId: tab.id })
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              void showMenu(tab)
            }}
            title={tab.path ?? tab.title}
          >
            <TabIcon tab={tab} />
            <span className="tab-title">{tab.title}</span>
            <button
              type="button"
              className="tab-close"
              aria-label={t('Close {name}', { name: tab.title })}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                void closeTab(tab.id)
              }}
            >
              <span className="tab-dirty-dot" aria-hidden="true" />
              <X size={13} className="tab-close-icon" />
            </button>
          </div>
        )
      })}
      <div className="tabbar-fill" />
    </div>
  )
}

export function EditorArea() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  useStore((s) => s.registryVersion)
  const active = tabs.find((tab) => tab.id === activeTabId) ?? null
  const lastFileTab = useRef<string | null>(null)
  if (active?.kind === 'file' && active.path) lastFileTab.current = active.path
  const filePath = active?.kind === 'file' ? (active.path ?? null) : null

  if (!tabs.length) return <Welcome />

  return (
    <div className="editor-area">
      <TabBar />
      {active ? <Breadcrumbs tab={active} /> : null}
      <div className="editor-stage">
        {/* One Monaco instance is reused across file tabs so models keep their undo stacks. */}
        <div className="editor-layer" hidden={!filePath}>
          {filePath ? <CodeEditor path={filePath} readOnly={Boolean(active?.readOnly)} /> : null}
        </div>
        {active?.kind === 'diff' ? (
          <div className="editor-layer">
            <DiffViewer key={active.id} tabId={active.id} />
          </div>
        ) : null}
        {active?.kind === 'commit' && active.hash ? (
          <div className="editor-layer">
            <CommitViewer hash={active.hash} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

export { getActiveTab }
