import { CornerDownLeft, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { basename, dirname } from '@shared/paths'
import { FileIcon } from '../components/Icon'
import { fuzzyMatch } from '../lib/fuzzy'
import { t } from '../lib/i18n'
import { executeCommand, listCommands } from '../services/commands'
import { openFile } from '../services/documents'
import { getState, setState, useStore } from '../state/store'

interface Item {
  id: string
  label: string
  detail?: string
  hint?: string
  positions: number[]
  score: number
  run: () => void
  icon?: 'file'
}

function Highlight({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return <>{text}</>
  const set = new Set(positions)
  return (
    <>
      {[...text].map((char, index) => (set.has(index) ? <mark key={index}>{char}</mark> : <span key={index}>{char}</span>))}
    </>
  )
}

let fileCache: { root: string; files: string[] } | null = null
export function invalidateFileCache(): void {
  fileCache = null
}

// Keyed by session so every open starts from fresh local state; typing that arrives
// before effects run is never wiped by a late reset.
export function QuickPick() {
  const quickPick = useStore((s) => s.quickPick)
  if (!quickPick) return null
  return <QuickPickSession key={quickPick.session} initialMode={quickPick.mode} />
}

function QuickPickSession({ initialMode }: { initialMode: 'files' | 'commands' }) {
  const root = useStore((s) => s.workspace?.root)
  useStore((s) => s.registryVersion)
  const [query, setQuery] = useState(initialMode === 'commands' ? '>' : '')
  const [files, setFiles] = useState<string[]>(() => (fileCache && fileCache.root === root ? fileCache.files : []))
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const mode = query.startsWith('>') ? 'commands' : 'files'

  useEffect(() => {
    if (!root) return
    let cancelled = false
    window.codemap.fs
      .listFiles(20000)
      .then((list) => {
        fileCache = { root, files: list }
        if (!cancelled) setFiles(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [root])

  const items = useMemo<Item[]>(() => {
    const close = () => setState({ quickPick: null })
    if (mode === 'commands') {
      const q = query.replace(/^>\s*/, '')
      const matches: Item[] = []
      for (const command of listCommands()) {
        // Titles are matched in the active language, and in English too, so either works.
        // "Prefix: value" titles (themes, languages) translate the prefix only.
        const colon = command.title.indexOf(': ')
        const title = colon > 0 ? `${t(command.title.slice(0, colon))}：${command.title.slice(colon + 2)}` : t(command.title)
        const label = command.category ? `${t(command.category)}: ${title}` : title
        const english = command.category ? `${command.category}: ${command.title}` : command.title
        const match = fuzzyMatch(q, label) ?? (english !== label ? fuzzyMatch(q, english) : null)
        if (!match) continue
        matches.push({
          id: command.id,
          label,
          hint: command.keybinding,
          positions: fuzzyMatch(q, label)?.positions ?? [],
          score: match.score,
          run: () => {
            close()
            void executeCommand(command.id)
          }
        })
      }
      return matches.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, 200)
    }
    if (!root) return []
    const recentTabs = getState()
      .tabs.filter((tab) => tab.kind === 'file' && tab.path)
      .map((tab) => tab.path as string)
    const source = query ? files : [...new Set([...recentTabs.reverse(), ...files])]
    const results: Item[] = []
    for (const file of source) {
      const relative = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
      const name = basename(file)
      const nameMatch = fuzzyMatch(query, name)
      const pathMatch = nameMatch ? null : fuzzyMatch(query, relative)
      if (!nameMatch && !pathMatch) continue
      const dir = dirname(relative)
      results.push({
        id: file,
        label: name,
        detail: dir === '.' ? '' : dir,
        positions: nameMatch?.positions ?? [],
        score: nameMatch ? nameMatch.score + 20 : (pathMatch?.score ?? 0),
        icon: 'file',
        run: () => {
          close()
          void openFile(file)
        }
      })
      if (!query && results.length >= 60) break
    }
    return query ? results.sort((a, b) => b.score - a.score || a.label.length - b.label.length).slice(0, 120) : results
  }, [mode, query, files, root])

  useEffect(() => setSelected(0), [query])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.qp-item.is-selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const close = () => setState({ quickPick: null })

  return (
    <div className="overlay overlay--top" onMouseDown={close}>
      <div className="quickpick" role="dialog" aria-label={mode === 'commands' ? t('Command palette') : t('Go to file')} onMouseDown={(event) => event.stopPropagation()}>
        <div className="qp-input">
          <Search size={14} />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            placeholder={mode === 'commands' ? t('Type a command') : t('Search files by name')}
            aria-label={t('Search')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') close()
              else if (event.key === 'ArrowDown') setSelected((s) => Math.min(items.length - 1, s + 1))
              else if (event.key === 'ArrowUp') setSelected((s) => Math.max(0, s - 1))
              else if (event.key === 'Enter') items[selected]?.run()
              else return
              event.preventDefault()
            }}
          />
        </div>
        <div className="qp-list" ref={listRef} role="listbox">
          {items.length === 0 ? <div className="qp-empty">{t('No results')}</div> : null}
          {items.map((item, index) => (
            <div
              key={item.id}
              role="option"
              aria-selected={index === selected}
              className={`qp-item${index === selected ? ' is-selected' : ''}`}
              onMouseMove={() => setSelected(index)}
              onClick={item.run}
            >
              {item.icon === 'file' ? <FileIcon name={item.label} size={14} /> : null}
              <span className="qp-label">
                <Highlight text={item.label} positions={item.positions} />
              </span>
              {item.detail ? <span className="qp-detail">{item.detail}</span> : null}
              {item.hint ? <kbd className="qp-hint">{item.hint}</kbd> : null}
              {index === selected ? <CornerDownLeft size={12} className="qp-enter" /> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
