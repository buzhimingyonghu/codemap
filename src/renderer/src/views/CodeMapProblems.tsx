import { CircleAlert, CircleCheck, Info, ListTodo, TriangleAlert, Workflow } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Issue } from '@shared/codemap/codemap.mjs'
import { t } from '../lib/i18n'
import { allIssues, ensureCodeMap, openIssue, openTodo, showCodeMap, useCodeMap } from '../services/codeMap'
import { useStore } from '../state/store'

// Panel tab listing code map checks. Kept apart from Problems, which every build replaces.

function LevelIcon({ level }: { level: Issue['level'] }) {
  if (level === 'error') return <CircleAlert size={13} className="sev sev-error" />
  if (level === 'warn') return <TriangleAlert size={13} className="sev sev-warning" />
  return <Info size={13} className="sev sev-info" />
}

export function CodeMapProblemsView() {
  const data = useCodeMap()
  const hasWorkspace = useStore((s) => Boolean(s.workspace))
  const [showInfo, setShowInfo] = useState(false)
  const issues = useMemo(() => allIssues(data), [data.check, data.yamlErrors]) // eslint-disable-line react-hooks/exhaustive-deps
  const grouped = useMemo(() => {
    const map = new Map<string, Issue[]>()
    for (const issue of issues) {
      if (!showInfo && issue.level === 'info') continue
      const file = /\.ya?ml$/.test(issue.where.split(' ')[0]) ? issue.where.split(' ')[0] : t('Other')
      const list = map.get(file) ?? []
      list.push(issue)
      map.set(file, list)
    }
    return [...map.entries()]
  }, [issues, showInfo])
  const infoCount = issues.filter((i) => i.level === 'info').length

  if (data.status !== 'ready') {
    return (
      <div className="panel-empty">
        <Workflow size={15} />
        <span>{data.status === 'loading' ? t('Reading the code map') : t('No code map loaded')}</span>
        {hasWorkspace && data.status !== 'loading' ? (
          <button
            type="button"
            className="button"
            onClick={() => {
              showCodeMap()
              void ensureCodeMap()
            }}
          >
            {t('Open Code Map')}
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="problems cm-problems">
      <div className="cm-problems-bar">
        <span className="cm-muted">{data.library}</span>
        {infoCount ? (
          <label className="cm-toggle">
            <input type="checkbox" checked={showInfo} onChange={(event) => setShowInfo(event.target.checked)} />
            <span>{t('Show {n} hints', { n: infoCount })}</span>
          </label>
        ) : null}
      </div>
      {data.todos.items.length ? (
        <div className="problem-group cm-problems-todos">
          <div className="problem-file">
            <ListTodo size={13} className="sev cm-todo-icon" />
            <span className="problem-file-name">{t('To-dos')}</span>
            <span className="problem-file-dir" />
            <span className="count-badge">{data.todos.items.length}</span>
          </div>
          {data.todos.items.map((item, i) => (
            <div key={`${item.file}-${i}`} className="problem-row" onClick={() => void openTodo(item)}>
              {item.kind === 'note' ? <ListTodo size={13} className="sev cm-todo-icon" /> : <TriangleAlert size={13} className="sev cm-todo-icon" />}
              <span className="problem-message">
                {item.title}{' '}
                <span className="cm-muted">{item.node ? (data.check?.model.nodes.get(item.node)?.node.name ?? item.node) : `${item.dir} · ${t('no node yet')}`}</span>
              </span>
              <span className="problem-location">{item.kind === 'note' ? item.file : (item.code ?? item.file)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {grouped.length ? (
        grouped.map(([file, list]) => (
          <div key={file} className="problem-group">
            <div className="problem-file">
              <span className="problem-file-name">{file}</span>
              <span className="problem-file-dir" />
              <span className="count-badge">{list.length}</span>
            </div>
            {list.map((issue, i) => (
              <div key={i} className="problem-row" onClick={() => void openIssue(issue)}>
                <LevelIcon level={issue.level} />
                <span className="problem-message">
                  {issue.msg} <span className="cm-muted">{issue.where.split(' ').slice(1).join(' ')}</span>
                </span>
                <span className="problem-location">{issue.rule}</span>
              </div>
            ))}
          </div>
        ))
      ) : (
        <div className="panel-empty">
          <CircleCheck size={15} />
          <span>{t('Nodes and requirements have no problems')}</span>
        </div>
      )}
    </div>
  )
}
