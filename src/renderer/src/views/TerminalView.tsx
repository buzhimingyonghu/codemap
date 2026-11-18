import { Plus, SquareTerminal, Trash } from 'lucide-react'
import { useEffect, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'
import { IconButton } from '../components/IconButton'
import { t } from '../lib/i18n'
import { createTerminal, killTerminal, selectTerminal, useTerminals } from '../services/terminals'

export function TerminalView() {
  const { sessions, activeId } = useTerminals()
  const hostRef = useRef<HTMLDivElement>(null)
  const active = sessions.find((s) => s.id === activeId) ?? null

  // A panel opened on this tab with no shell yet starts one.
  useEffect(() => {
    if (!sessions.length) void createTerminal()
    // Only on mount; later empty states come from the user closing shells.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Every session's element stays in the stage (moving xterm's element in and out of the page
  // loses its rendered rows); only the active one is shown, fitted, and focused.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    for (const s of sessions) {
      if (s.element.parentElement !== host) host.appendChild(s.element)
      s.element.hidden = s !== active
    }
    if (!active) return
    if (!active.term.element) active.term.open(active.element)
    const fit = () => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          active.fit.fit()
        } catch {
          // Not laid out yet.
        }
      }
    }
    fit()
    // Rows drawn while hidden are stale; repaint the whole viewport on show.
    active.term.refresh(0, active.term.rows - 1)
    const observer = new ResizeObserver(() => requestAnimationFrame(fit))
    observer.observe(host)
    active.term.focus()
    return () => observer.disconnect()
  }, [active, sessions])

  return (
    <div className="terminal-view">
      <div className="terminal-stage" ref={hostRef} onMouseDown={() => active?.term.focus()}>
        {!active ? <div className="panel-empty">{t('No terminal open')}</div> : null}
      </div>
      {sessions.length > 1 ? (
        <ul className="terminal-list" aria-label={t('Terminals')}>
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className={`terminal-tab${session.id === activeId ? ' is-active' : ''}${session.exited ? ' is-exited' : ''}`}
                title={session.title}
                onClick={() => selectTerminal(session.id)}
              >
                <SquareTerminal size={13} />
                <span className="terminal-tab-title">
                  {session.index}: {session.title}
                </span>
              </button>
              <IconButton size="sm" label={t('Kill Terminal')} className="terminal-tab-kill" onClick={() => killTerminal(session.id)}>
                <Trash size={12} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Panel header actions for the terminal tab. */
export function TerminalActions() {
  const { activeId } = useTerminals()
  return (
    <>
      <IconButton size="sm" className="terminal-new" label={t('New Terminal (⌃⇧`)')} onClick={() => void createTerminal().then((s) => s?.term.focus())}>
        <Plus size={14} />
      </IconButton>
      <IconButton size="sm" className="terminal-kill" label={t('Kill Terminal')} disabled={!activeId} onClick={() => activeId && killTerminal(activeId)}>
        <Trash size={13} />
      </IconButton>
    </>
  )
}
