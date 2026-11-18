import { CaseSensitive, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Ellipsis, Regex, RefreshCw, Replace, ReplaceAll, SearchX, WholeWord, X } from 'lucide-react'
import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { dirname } from '@shared/paths'
import { previewReplacement, type SearchMatch } from '@shared/search'
import { FileIcon } from '../components/Icon'
import { IconButton } from '../components/IconButton'
import { t } from '../lib/i18n'
import {
  clearSearch,
  collapseAll,
  dismiss,
  openMatch,
  replaceAll,
  replaceFile,
  replaceMatch,
  runSearch,
  setCollapsed,
  setReplacement,
  toggleDetails,
  toggleReplace,
  updateQuery,
  useSearch
} from '../services/search'
import { useStore } from '../state/store'

function Toggle({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`search-toggle${active ? ' is-active' : ''}`} aria-label={label} aria-pressed={active} data-tooltip={label} onClick={onClick}>
      {children}
    </button>
  )
}

type Row = { kind: 'file'; path: string } | { kind: 'match'; path: string; match: SearchMatch }

export function SearchView() {
  const workspace = useStore((s) => s.workspace)
  const s = useSearch()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [s.focusToken])

  // Flat list of visible rows, for arrow-key navigation through the results.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const file of s.files) {
      out.push({ kind: 'file', path: file.path })
      if (!s.collapsed[file.path]) for (const match of file.matches) out.push({ kind: 'match', path: file.path, match })
    }
    return out
  }, [s.files, s.collapsed])

  if (!workspace) return <div className="view-empty"><p>{t('Open a folder to search its files')}</p></div>

  const anyOpen = s.files.some((file) => !s.collapsed[file.path])
  const hasResults = s.files.length > 0

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void runSearch()
    } else if (event.key === 'ArrowDown' && rows.length) {
      event.preventDefault()
      focusRow(0)
    } else if (event.key === 'Escape' && s.pattern) {
      event.preventDefault()
      clearSearch()
    }
  }

  const focusRow = (index: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)
    el?.focus()
  }

  const onRowKey = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const row = rows[index]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = index + (event.key === 'ArrowDown' ? 1 : -1)
      if (next < 0) inputRef.current?.focus()
      else if (next < rows.length) {
        focusRow(next)
        const target = rows[next]
        if (target.kind === 'match') openMatch(target.path, target.match, true)
      }
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (row.kind === 'match') openMatch(row.path, row.match)
      else setCollapsed(row.path, !s.collapsed[row.path])
    } else if (event.key === 'ArrowLeft' && row.kind === 'file') setCollapsed(row.path, true)
    else if (event.key === 'ArrowRight' && row.kind === 'file') setCollapsed(row.path, false)
    else if ((event.key === 'Delete' || event.key === 'Backspace') && event.metaKey) {
      event.preventDefault()
      if (row.kind === 'match') dismiss(row.path, row.match)
      else dismiss(row.path)
    }
  }

  let summary = ''
  if (hasResults) summary = t(s.files.length === 1 ? (s.total === 1 ? '1 result in 1 file' : '{n} results in 1 file') : '{n} results in {m} files', { n: s.total, m: s.files.length })
  else if (s.pattern && !s.running && !s.error) summary = t('No results found')

  let rowIndex = 0
  return (
    <div className="search-view">
      <div className="view-header">
        <span className="view-title">{t('Search')}</span>
        <div className="view-actions">
          <IconButton label={t('Refresh')} size="sm" onClick={() => void runSearch()} disabled={!s.pattern}>
            <RefreshCw size={14} />
          </IconButton>
          <IconButton label={t('Clear Search Results')} size="sm" onClick={clearSearch} disabled={!s.pattern && !hasResults}>
            <SearchX size={14} />
          </IconButton>
          <IconButton label={anyOpen ? t('Collapse All') : t('Expand All')} size="sm" onClick={collapseAll} disabled={!hasResults}>
            {anyOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
          </IconButton>
        </div>
      </div>

      <div className="search-form">
        <button type="button" className="search-replace-toggle" aria-label={t('Toggle Replace')} aria-expanded={s.showReplace} data-tooltip={t('Toggle Replace')} onClick={toggleReplace}>
          {s.showReplace ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="search-fields">
          <div className={`search-box${s.error ? ' has-error' : ''}`}>
            <input
              ref={inputRef}
              className="search-input"
              value={s.pattern}
              placeholder={t('Search')}
              spellCheck={false}
              aria-label={t('Search')}
              aria-invalid={Boolean(s.error)}
              onChange={(event) => updateQuery({ pattern: event.target.value })}
              onKeyDown={onInputKey}
            />
            <Toggle label={t('Match Case')} active={s.matchCase} onClick={() => updateQuery({ matchCase: !s.matchCase }, true)}>
              <CaseSensitive size={15} />
            </Toggle>
            <Toggle label={t('Match Whole Word')} active={s.wholeWord} onClick={() => updateQuery({ wholeWord: !s.wholeWord }, true)}>
              <WholeWord size={15} />
            </Toggle>
            <Toggle label={t('Use Regular Expression')} active={s.isRegex} onClick={() => updateQuery({ isRegex: !s.isRegex }, true)}>
              <Regex size={15} />
            </Toggle>
          </div>
          {s.error ? <div className="search-error">{s.error}</div> : null}
          {s.showReplace ? (
            <div className="search-box">
              <input
                className="search-input"
                value={s.replacement}
                placeholder={t('Replace')}
                spellCheck={false}
                aria-label={t('Replace')}
                onChange={(event) => setReplacement(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.metaKey) {
                    event.preventDefault()
                    void replaceAll()
                  }
                }}
              />
              <button type="button" className="search-toggle" aria-label={t('Replace All')} data-tooltip={`${t('Replace All')} (⌘↩)`} disabled={!hasResults} onClick={() => void replaceAll()}>
                <ReplaceAll size={15} />
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="search-details-row">
        <IconButton label={t('Toggle Search Details')} size="sm" active={s.showDetails} onClick={toggleDetails}>
          <Ellipsis size={14} />
        </IconButton>
      </div>
      {s.showDetails ? (
        <div className="search-details">
          <label className="search-detail">
            <span>{t('files to include')}</span>
            <input className="search-input search-input--boxed" value={s.include} placeholder="src/**, *.ts" spellCheck={false} onChange={(event) => updateQuery({ include: event.target.value })} onKeyDown={onInputKey} />
          </label>
          <label className="search-detail">
            <span>{t('files to exclude')}</span>
            <input className="search-input search-input--boxed" value={s.exclude} placeholder="*.min.js, docs" spellCheck={false} onChange={(event) => updateQuery({ exclude: event.target.value })} onKeyDown={onInputKey} />
          </label>
        </div>
      ) : null}

      <div className={`search-summary${s.running ? ' is-running' : ''}`} aria-live="polite">
        {s.running ? <span className="search-progress" /> : null}
        <span>{summary}</span>
      </div>
      {s.truncated ? <div className="search-note">{t('Showing the first {n} results. Narrow the search to see the rest.', { n: s.total })}</div> : null}

      <div className="search-results" ref={listRef} role="tree" aria-label={t('Search Results')}>
        {s.files.map((file) => {
          const open = !s.collapsed[file.path]
          const fileRow = rowIndex++
          const dir = dirname(file.relative)
          return (
            <div key={file.path} role="group">
              <div
                className="search-file"
                role="treeitem"
                aria-expanded={open}
                tabIndex={-1}
                data-row={fileRow}
                title={file.relative}
                onClick={() => setCollapsed(file.path, open)}
                onKeyDown={(event) => onRowKey(event, fileRow)}
              >
                {open ? <ChevronDown size={13} className="chevron" /> : <ChevronRight size={13} className="chevron" />}
                <FileIcon name={file.relative} size={14} />
                <span className="search-file-name">{file.relative.slice(file.relative.lastIndexOf('/') + 1)}</span>
                <span className="search-file-dir">{dir && dir !== '.' && dir !== file.relative ? dir : ''}</span>
                <span className="search-row-actions" onClick={(event) => event.stopPropagation()}>
                  {s.showReplace ? (
                    <IconButton label={t('Replace All in File')} size="sm" onClick={() => void replaceFile(file.path)}>
                      <ReplaceAll size={13} />
                    </IconButton>
                  ) : null}
                  <IconButton label={t('Dismiss Result')} size="sm" onClick={() => dismiss(file.path)}>
                    <X size={13} />
                  </IconButton>
                </span>
                <span className="count-badge">{file.matches.length}</span>
              </div>
              {open
                ? file.matches.map((match) => {
                    const index = rowIndex++
                    return (
                      <div
                        key={`${match.line}:${match.column}`}
                        className="search-match"
                        role="treeitem"
                        tabIndex={-1}
                        data-row={index}
                        title={`${t('Line {n}', { n: match.line })}: ${match.before}${match.match}${match.after}`}
                        onClick={() => openMatch(file.path, match)}
                        onKeyDown={(event) => onRowKey(event, index)}
                      >
                        <span className="search-match-text">
                          {match.before}
                          <mark className={s.showReplace && s.pattern ? 'is-replacing' : undefined}>{match.match}</mark>
                          {s.showReplace && s.pattern ? <ins>{previewReplacement(s, s.replacement, match.match)}</ins> : null}
                          {match.after}
                        </span>
                        <span className="search-line-number">{match.line}</span>
                        <span className="search-row-actions" onClick={(event) => event.stopPropagation()}>
                          {s.showReplace ? (
                            <IconButton label={t('Replace')} size="sm" onClick={() => void replaceMatch(file.path, match)}>
                              <Replace size={13} />
                            </IconButton>
                          ) : null}
                          <IconButton label={t('Dismiss Result')} size="sm" onClick={() => dismiss(file.path, match)}>
                            <X size={13} />
                          </IconButton>
                        </span>
                      </div>
                    )
                  })
                : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
