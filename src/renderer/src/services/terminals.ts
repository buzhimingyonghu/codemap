import { useSyncExternalStore } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { getTheme } from '../editor/themes'
import { t } from '../lib/i18n'
import { getState, setState, useStore } from '../state/store'
import { reportError } from './ui'

// Terminal sessions live here, outside React: switching panel tabs, hiding the panel, or
// re-rendering never kills a shell or loses its scrollback. The view only attaches the
// xterm element of the active session to its container.

export interface TerminalSession {
  id: string
  title: string
  shell: string
  /** 1-based number among open terminals, used for a stable short name. */
  index: number
  term: Terminal
  fit: FitAddon
  element: HTMLDivElement
  exited: boolean
}

let sessions: TerminalSession[] = []
let activeId: string | null = null
let creating: Promise<TerminalSession | null> | null = null
const listeners = new Set<() => void>()
let wired = false
let version = 0

function emit(): void {
  version++
  for (const listener of [...listeners]) listener()
}

export function useTerminals(): { sessions: TerminalSession[]; activeId: string | null } {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => version
  )
  return { sessions, activeId }
}

export function getActiveSession(): TerminalSession | null {
  return sessions.find((s) => s.id === activeId) ?? null
}

// ---------- Theme ----------
// ANSI colors per appearance; background and foreground follow the editor theme so the
// terminal reads as part of the panel.
const DARK_ANSI = {
  black: '#1d2027',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#2dd4bf',
  white: '#d8dee9',
  brightBlack: '#6b7385',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#5eead4',
  brightWhite: '#ffffff'
}
const LIGHT_ANSI = {
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0550ae',
  magenta: '#8250df',
  cyan: '#0f766e',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#0e7490',
  brightWhite: '#8c959f'
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

export function terminalTheme(themeId: string): ITheme {
  const theme = getTheme(themeId)
  const dark = theme.appearance === 'dark'
  return {
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
    background: cssVar('--bg-panel', theme.editor.background),
    foreground: theme.editor.foreground,
    cursor: theme.editor.cursor,
    cursorAccent: cssVar('--bg-panel', theme.editor.background),
    selectionBackground: theme.editor.selection
  }
}

// ---------- Sessions ----------
function wire(): void {
  if (wired) return
  wired = true
  window.codemap.terminal.onData(({ id, data }) => sessions.find((s) => s.id === id)?.term.write(data))
  window.codemap.terminal.onExit(({ id, code }) => {
    const session = sessions.find((s) => s.id === id)
    if (!session) return
    session.exited = true
    session.term.write(`\r\n\x1b[2m${t('[Process exited with code {code}]', { code })}\x1b[0m\r\n`)
    emit()
  })
  useStore.subscribe((state, previous) => {
    if (state.theme === previous.theme) return
    // CSS variables update on the next frame; read them after that.
    requestAnimationFrame(() => {
      for (const s of sessions) s.term.options.theme = terminalTheme(state.theme)
    })
  })
}

/** Opens a new shell in the current folder and makes it active. */
export function createTerminal(): Promise<TerminalSession | null> {
  wire()
  creating ??= (async () => {
    const element = document.createElement('div')
    element.className = 'terminal-host'
    const term = new Terminal({
      fontFamily: "'SF Mono', ui-monospace, Menlo, Monaco, monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: false,
      scrollback: 5000,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      theme: terminalTheme(getState().theme)
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    try {
      const info = await window.codemap.terminal.create(term.cols, term.rows)
      const name = info.shell.split('/').pop() || 'shell'
      const index = (sessions.reduce((max, s) => Math.max(max, s.index), 0) || 0) + 1
      const session: TerminalSession = { id: info.id, title: name, shell: info.shell, index, term, fit, element, exited: false }
      term.onData((data) => {
        if (!session.exited) window.codemap.terminal.write(session.id, data)
      })
      term.onResize(({ cols, rows }) => window.codemap.terminal.resize(session.id, cols, rows))
      // Shells set the title to "user@host: dir" (or the running command). The prompt's
      // user@host part says nothing in a local IDE, so keep only what follows it.
      term.onTitleChange((title) => {
        const clean = title.replace(/^[^\s@]+@[^\s:]+:?\s*/, '').trim()
        session.title = clean || name
        emit()
      })
      // ⌘K clears like Terminal.app. Every other ⌘ combination is left to the browser and the
      // app (⌘C/⌘V copy and paste natively, ⌘P, ⌘J, ⌘W… reach their commands), never the shell.
      term.attachCustomKeyEventHandler((event) => {
        // ⌃- / ⌃⇧- are back/forward everywhere; the window handler has already run them.
        if (event.ctrlKey && !event.metaKey && event.code === 'Minus') return false
        if (event.type !== 'keydown' || !event.metaKey) return true
        if (event.key.toLowerCase() === 'k') {
          term.clear()
        }
        return false
      })
      sessions = [...sessions, session]
      activeId = session.id
      emit()
      return session
    } catch (error) {
      term.dispose()
      reportError(error, t('Cannot start a terminal'))
      return null
    } finally {
      creating = null
    }
  })()
  return creating
}

export function selectTerminal(id: string): void {
  if (activeId === id) return
  activeId = id
  emit()
}

export function killTerminal(id: string): void {
  const index = sessions.findIndex((s) => s.id === id)
  if (index < 0) return
  const [session] = sessions.splice(index, 1)
  sessions = [...sessions]
  void window.codemap.terminal.kill(id).catch(() => undefined)
  session.term.dispose()
  session.element.remove()
  if (activeId === id) activeId = sessions[Math.min(index, sessions.length - 1)]?.id ?? null
  emit()
}

export function clearTerminal(): void {
  getActiveSession()?.term.clear()
}

/** Shows the terminal panel, starting a shell if none is open, and focuses it. */
export async function showTerminal(focus = true): Promise<void> {
  setState({ panelVisible: true, panelView: 'terminal' })
  if (!sessions.length) await createTerminal()
  if (focus) requestAnimationFrame(() => getActiveSession()?.term.focus())
}

/** ⌃` : open and focus the terminal, or hide the panel when the terminal already has focus. */
export async function toggleTerminal(): Promise<void> {
  const state = getState()
  const focused = document.activeElement?.closest('.terminal-view')
  if (state.panelVisible && state.panelView === 'terminal' && focused) {
    setState({ panelVisible: false })
    return
  }
  await showTerminal()
}

export async function newTerminal(): Promise<void> {
  setState({ panelVisible: true, panelView: 'terminal' })
  await createTerminal()
  requestAnimationFrame(() => getActiveSession()?.term.focus())
}

/** Closes every shell, e.g. when the folder changes (new shells start in the new folder). */
export function killAllTerminals(): void {
  for (const session of [...sessions]) killTerminal(session.id)
}
