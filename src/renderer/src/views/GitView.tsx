import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CloudDownload,
  CloudUpload,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  Minus,
  Plus,
  RefreshCw,
  Undo2
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { basename, dirname } from '@shared/paths'
import type { GitFileChange } from '@shared/types'
import { isStaged, isUnstaged } from '@shared/gitParse'
import { Chevron, FileIcon } from '../components/Icon'
import { IconButton } from '../components/IconButton'
import { t } from '../lib/i18n'
import { openCommit, openDiff, openFile, saveAll } from '../services/documents'
import { refreshGit, runGit } from '../services/git'
import { confirm, notify, prompt } from '../services/ui'
import { useStore } from '../state/store'

const STATE_LETTER: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  conflicted: '!',
  typechange: 'T'
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d`
  return new Date(iso).toLocaleDateString()
}

function Section({ title, count, open, onToggle, actions, children }: { title: string; count?: number; open: boolean; onToggle: () => void; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="git-section">
      <div className="section-header" onClick={onToggle} role="button" aria-expanded={open} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
        <Chevron open={open} size={13} />
        <span className="section-title">{title}</span>
        {count !== undefined ? <span className="count-badge">{count}</span> : null}
        <div className="section-actions" onClick={(event) => event.stopPropagation()}>
          {actions}
        </div>
      </div>
      {open ? <div className="section-body">{children}</div> : null}
    </section>
  )
}

export function GitView() {
  const workspace = useStore((s) => s.workspace)
  const git = useStore((s) => s.git)
  const branches = useStore((s) => s.branches)
  const commits = useStore((s) => s.commits)
  const busy = useStore((s) => s.gitBusy)
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [open, setOpen] = useState({ staged: true, changes: true, history: true })

  const staged = useMemo(() => git?.files.filter(isStaged) ?? [], [git])
  const changes = useMemo(() => git?.files.filter(isUnstaged) ?? [], [git])

  if (!workspace) return <div className="view-empty"><p>{t('Open a folder to use source control')}</p></div>
  if (!git) return <div className="view-empty"><p>{t('Loading…')}</p></div>
  if (!git.isRepo) {
    return (
      <div className="view-empty">
        <p>{t('This folder is not a Git repository')}</p>
        <button type="button" className="button button--primary" onClick={() => void runGit(t('Initialize'), () => window.codemap.git.init(), t('Repository initialized'))}>
          {t('Initialize Repository')}
        </button>
      </div>
    )
  }

  const abs = (file: GitFileChange) => `${workspace.root}/${file.path}`

  const commit = async () => {
    if (!message.trim() && !amend) {
      notify(t('Write a commit message'), 'warning')
      return
    }
    await saveAll()
    if (!staged.length && !amend) {
      if (!changes.length) {
        notify(t('Nothing to commit'), 'info')
        return
      }
      const ok = await confirm(t('Stage all changes and commit?'), t('There are no staged changes.'), t('Stage All & Commit'))
      if (!ok) return
      await runGit(t('Stage'), () => window.codemap.git.stage(changes.map(abs)))
    }
    const done = await runGit(t('Commit'), () => window.codemap.git.commit(message, amend).then(() => true), amend ? t('Commit amended') : t('Committed'))
    if (done) {
      setMessage('')
      setAmend(false)
    }
  }

  const switchBranch = async () => {
    const locals = branches.filter((b) => !b.remote)
    const remotes = branches.filter((b) => b.remote && !locals.some((l) => b.name.endsWith(`/${l.name}`)))
    const choice = await window.codemap.app.popupMenu([
      { id: '__new', label: t('Create Branch…') },
      { separator: true },
      ...locals.map((b) => ({ id: b.name, label: b.current ? `✓ ${b.name}` : b.name, enabled: !b.current })),
      ...(remotes.length ? [{ separator: true }, ...remotes.map((b) => ({ id: b.name, label: b.name }))] : [])
    ])
    if (!choice) return
    if (choice === '__new') {
      const name = await prompt(t('New branch name'), { placeholder: 'feature/my-change', confirmLabel: t('Create') })
      if (name) await runGit(t('Create branch'), () => window.codemap.git.checkout(name.trim(), true), t('Switched to {name}', { name: name.trim() }))
      return
    }
    await runGit(t('Checkout'), () => window.codemap.git.checkout(choice, false), t('Switched to {name}', { name: choice }))
  }

  const discard = async (files: GitFileChange[]) => {
    const label = files.length === 1 ? `"${basename(files[0].path)}"` : t('{n} files', { n: files.length })
    const untracked = files.some((f) => f.worktree === 'untracked')
    const ok = await confirm(t('Discard changes in {name}?', { name: label }), untracked ? t('Untracked files will be deleted. This cannot be undone.') : t('This cannot be undone.'), t('Discard'), true)
    if (ok) await runGit(t('Discard'), () => window.codemap.git.discard(files.map(abs)))
  }

  const renderFile = (file: GitFileChange, kind: 'staged' | 'changes') => {
    const state = kind === 'staged' ? file.index : file.worktree
    const dir = dirname(file.path)
    return (
      <div
        key={`${kind}:${file.path}`}
        className={`git-file state-${state}`}
        onClick={() => {
          if (state === 'deleted') void openDiff(abs(file), kind === 'staged')
          else if (state === 'untracked') void openFile(abs(file))
          else void openDiff(abs(file), kind === 'staged')
        }}
        onDoubleClick={() => state !== 'deleted' && void openFile(abs(file))}
        title={file.path}
      >
        <FileIcon name={file.path} size={14} />
        <span className={`git-file-name${state === 'deleted' ? ' is-deleted' : ''}`}>{basename(file.path)}</span>
        {/* Always rendered so it absorbs free space and keeps the actions pinned right. */}
        <span className="git-file-dir">{dir !== '.' ? dir : ''}</span>
        <span className="git-file-actions" onClick={(event) => event.stopPropagation()}>
          {kind === 'changes' ? (
            <>
              <IconButton size="sm" label={t('Discard Changes')} onClick={() => void discard([file])}>
                <Undo2 size={13} />
              </IconButton>
              <IconButton size="sm" label={t('Stage')} onClick={() => void runGit(t('Stage'), () => window.codemap.git.stage([abs(file)]))}>
                <Plus size={14} />
              </IconButton>
            </>
          ) : (
            <IconButton size="sm" label={t('Unstage')} onClick={() => void runGit(t('Unstage'), () => window.codemap.git.unstage([abs(file)]))}>
              <Minus size={14} />
            </IconButton>
          )}
        </span>
        <span className="git-file-state">{state ? STATE_LETTER[state] : ''}</span>
      </div>
    )
  }

  return (
    <div className="git-view">
      <div className="view-header">
        <span className="view-title">{t('Source Control')}</span>
        <div className="view-actions">
          <IconButton size="sm" label={t('Pull')} disabled={Boolean(busy)} onClick={() => void runGit(t('Pull'), () => window.codemap.git.pull(), t('Pulled'))}>
            <CloudDownload size={15} />
          </IconButton>
          <IconButton size="sm" label={t('Push')} disabled={Boolean(busy)} onClick={() => void runGit(t('Push'), () => window.codemap.git.push(), t('Pushed'))}>
            <CloudUpload size={15} />
          </IconButton>
          <IconButton size="sm" label={t('Refresh')} onClick={() => void refreshGit()}>
            <RefreshCw size={14} className={busy ? 'spin' : undefined} />
          </IconButton>
        </div>
      </div>

      <div className="git-scroll">
        <div className="git-composer">
          <button type="button" className="branch-button" onClick={() => void switchBranch()} data-tooltip={t('Switch Branch')}>
            {git.detached ? <GitCommitHorizontal size={14} /> : <GitBranch size={14} />}
            <span className="branch-name">{git.branch ?? t('Detached HEAD')}</span>
            {git.ahead ? (
              <span className="sync-count">
                <ArrowUp size={11} />
                {git.ahead}
              </span>
            ) : null}
            {git.behind ? (
              <span className="sync-count">
                <ArrowDown size={11} />
                {git.behind}
              </span>
            ) : null}
            <ChevronDown size={13} className="branch-caret" />
          </button>
          <textarea
            className="commit-input"
            placeholder={git.branch ? t('Message (⌘↩ to commit on {name})', { name: git.branch }) : t('Message (⌘↩ to commit)')}
            value={message}
            rows={Math.min(8, Math.max(2, message.split('\n').length))}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.metaKey) {
                event.preventDefault()
                void commit()
              }
            }}
            aria-label={t('Commit message')}
          />
          <div className="commit-row">
            <button type="button" className="button button--primary commit-button" disabled={Boolean(busy)} onClick={() => void commit()}>
              <Check size={14} />
              <span>{amend ? t('Amend') : t('Commit')}</span>
            </button>
            <label className="check" data-tooltip={t('Amend the previous commit')}>
              <input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} />
              <span>{t('Amend')}</span>
            </label>
          </div>
        </div>

        {staged.length ? (
          <Section
            title={t('Staged Changes')}
            count={staged.length}
            open={open.staged}
            onToggle={() => setOpen({ ...open, staged: !open.staged })}
            actions={
              <IconButton size="sm" label={t('Unstage All')} onClick={() => void runGit(t('Unstage'), () => window.codemap.git.unstage(staged.map(abs)))}>
                <Minus size={14} />
              </IconButton>
            }
          >
            {staged.map((file) => renderFile(file, 'staged'))}
          </Section>
        ) : null}

        <Section
          title={t('Changes')}
          count={changes.length}
          open={open.changes}
          onToggle={() => setOpen({ ...open, changes: !open.changes })}
          actions={
            changes.length ? (
              <>
                <IconButton size="sm" label={t('Discard All Changes')} onClick={() => void discard(changes)}>
                  <Undo2 size={13} />
                </IconButton>
                <IconButton size="sm" label={t('Stage All')} onClick={() => void runGit(t('Stage'), () => window.codemap.git.stage(changes.map(abs)))}>
                  <Plus size={14} />
                </IconButton>
              </>
            ) : null
          }
        >
          {changes.length ? changes.map((file) => renderFile(file, 'changes')) : <div className="section-empty">{t('No changes')}</div>}
        </Section>

        <Section title={t('History')} count={commits.length || undefined} open={open.history} onToggle={() => setOpen({ ...open, history: !open.history })}
          actions={
            <IconButton size="sm" label={t('New Branch')} onClick={async () => {
              const name = await prompt(t('New branch name'), { placeholder: 'feature/my-change', confirmLabel: t('Create') })
              if (name) await runGit(t('Create branch'), () => window.codemap.git.checkout(name.trim(), true), t('Switched to {name}', { name: name.trim() }))
            }}>
              <GitBranchPlus size={14} />
            </IconButton>
          }
        >
          {commits.length ? (
            <ol className="commit-list">
              {commits.map((commit, index) => (
                <li key={commit.hash} className="commit-item" onClick={() => openCommit(commit.hash, commit.subject)} title={`${commit.subject}\n${commit.author} · ${new Date(commit.date).toLocaleString()}`}>
                  <span className={`commit-node${index === 0 ? ' is-head' : ''}`} aria-hidden="true" />
                  <span className="commit-subject">{commit.subject}</span>
                  <span className="commit-meta">{relativeTime(commit.date)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="section-empty">{t('No commits yet')}</div>
          )}
        </Section>
      </div>
    </div>
  )
}
