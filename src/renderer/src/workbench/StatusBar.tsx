import { ArrowDown, ArrowUp, Braces, Bug, CircleCheck, CircleX, GitBranch, Hammer, LoaderCircle, TriangleAlert } from 'lucide-react'
import { languageFor, languageLabel } from '../lib/language'
import { t } from '../lib/i18n'
import { restartServer } from '../services/lsp'
import { setState, useStore } from '../state/store'

export function StatusBar() {
  const workspace = useStore((s) => s.workspace)
  const git = useStore((s) => s.git)
  const diagnostics = useStore((s) => s.diagnostics)
  const build = useStore((s) => s.build)
  const debugState = useStore((s) => s.debug.state)
  const cursor = useStore((s) => s.cursor)
  const activeTab = useStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId))
  const servers = useStore((s) => s.lspServers)
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length
  const debugging = debugState !== 'idle' && debugState !== 'terminated'
  const language = activeTab?.kind === 'file' && activeTab.path ? languageFor(activeTab.path) : null
  const server = language ? servers.find((entry) => entry.languages.includes(language)) : undefined
  const workspaceRoot = useStore((s) => s.workspace?.root ?? '')
  const serving = server?.projectRoots?.find((root) => activeTab?.path?.startsWith(`${root}/`))
  const servingLabel = serving ? (serving === workspaceRoot ? '' : ` · ${serving.slice(workspaceRoot.length + 1) || serving}`) : ''

  return (
    <footer className={`statusbar${debugging ? ' is-debugging' : ''}`}>
      <div className="status-left">
        {git?.isRepo ? (
          <button type="button" className="status-item" onClick={() => setState({ sidebarView: 'git', sidebarVisible: true })}>
            <GitBranch size={12} />
            <span>{git.branch ?? 'detached'}</span>
            {git.files.length ? <span className="status-dim">*</span> : null}
            {git.ahead ? (
              <span className="status-sync">
                <ArrowUp size={11} />
                {git.ahead}
              </span>
            ) : null}
            {git.behind ? (
              <span className="status-sync">
                <ArrowDown size={11} />
                {git.behind}
              </span>
            ) : null}
          </button>
        ) : null}
        {workspace ? (
          <button type="button" className="status-item" onClick={() => setState({ panelVisible: true, panelView: 'problems' })}>
            <CircleX size={12} />
            <span>{errors}</span>
            <TriangleAlert size={12} />
            <span>{warnings}</span>
          </button>
        ) : null}
        {build.status !== 'idle' ? (
          <button type="button" className={`status-item build-${build.status}`} onClick={() => setState({ panelVisible: true, panelView: 'output' })}>
            {build.status === 'running' ? <LoaderCircle size={12} className="spin" /> : build.status === 'succeeded' ? <CircleCheck size={12} /> : <Hammer size={12} />}
            <span>
              {build.status === 'running'
                ? t('Building…')
                : build.status === 'succeeded'
                  ? t('Built in {s}s', { s: ((build.durationMs ?? 0) / 1000).toFixed(1) })
                  : build.status === 'stopped'
                    ? t('Build stopped')
                    : t('Build failed')}
            </span>
          </button>
        ) : null}
        {debugging ? (
          <span className="status-item">
            <Bug size={12} />
            <span>{debugState === 'stopped' ? t('Paused') : debugState === 'starting' ? t('Starting') : t('Running')}</span>
          </span>
        ) : null}
      </div>
      <div className="status-right">
        {server ? (
          <button
            type="button"
            className={`status-item lsp-${server.state}`}
            data-tooltip={
              server.state === 'missing'
                ? t('{name} is not installed', { name: server.label })
                : server.state === 'ready'
                  ? t('{name} running{extra} · click to restart', {
                      name: server.label,
                      extra: `${servingLabel}${server.compileDatabase ? ` · ${server.compileDatabase === 'generated' ? 'auto compile_commands' : server.compileDatabase}` : ''}`
                    })
                  : t('{name} {state} · click to restart', { name: server.label, state: server.state })
            }
            onClick={() => server.state !== 'missing' && void restartServer(server.id)}
          >
            {server.state === 'starting' ? <LoaderCircle size={12} className="spin" /> : <Braces size={12} />}
            <span>{server.label}</span>
          </button>
        ) : null}
        {activeTab?.kind === 'file' && cursor ? (
          <span className="status-item">
            {t('Ln {line}, Col {col}', { line: cursor.line, col: cursor.column })}
            {cursor.selected ? t(' ({n} selected)', { n: cursor.selected }) : ''}
          </span>
        ) : null}
        {activeTab?.kind === 'file' && activeTab.path ? (
          <>
            <span className="status-item">{languageLabel(languageFor(activeTab.path))}</span>
            <span className="status-item">UTF-8</span>
          </>
        ) : null}
      </div>
    </footer>
  )
}
