import type { DebugEvent } from '@shared/types'
import { getState, initialDebug, setState, uid, type ConsoleLine } from '../state/store'
import { t } from '../lib/i18n'
import { runBuild } from './build'
import { openFile } from './documents'
import { notify, reportError } from './ui'

function log(kind: ConsoleLine['kind'], text: string): void {
  const lines = text.replace(/\n$/, '').split('\n')
  const entries = lines.map((line) => ({ id: uid(), kind, text: line }))
  const next = [...getState().debugConsole, ...entries]
  setState({ debugConsole: next.length > 3000 ? next.slice(-3000) : next })
}

export async function startDebugging(): Promise<void> {
  const state = getState()
  if (!state.workspace || !state.settings) {
    notify(t('Open a folder first'), 'warning')
    return
  }
  const config = state.settings.debug
  if (!config.program) {
    setState({ settingsOpen: true })
    notify(t('Choose the program to debug'), 'info')
    return
  }
  if (state.debug.state === 'stopped' && state.debug.threadId !== null) {
    await control('continue')
    return
  }
  if (state.debug.state !== 'idle' && state.debug.state !== 'terminated') return
  if (config.preLaunchBuild && state.settings.buildCommand.trim()) {
    const ok = await runBuild()
    if (!ok) {
      notify(t('Build failed, debugging cancelled'), 'error')
      return
    }
  }
  setState({
    debug: { ...initialDebug, state: 'starting' },
    variables: {},
    debugConsole: [],
    sidebarView: 'debug',
    sidebarVisible: true,
    panelVisible: true,
    panelView: 'debugConsole'
  })
  try {
    await window.codemap.debug.start(config)
  } catch (error) {
    setState({ debug: { ...initialDebug, state: 'idle' } })
    reportError(error, t('Cannot start debugging'))
  }
}

export async function stopDebugging(): Promise<void> {
  try {
    await window.codemap.debug.stop()
  } finally {
    setState({ debug: { ...initialDebug, state: 'idle' } })
  }
}

export async function control(command: 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut'): Promise<void> {
  const { debug } = getState()
  const threadId = debug.threadId
  if (threadId === null) return
  if (command !== 'pause' && debug.state !== 'stopped') return
  try {
    await window.codemap.debug[command](threadId)
  } catch (error) {
    reportError(error)
  }
}

export async function selectFrame(frameId: number): Promise<void> {
  const frame = getState().debug.frames.find((entry) => entry.id === frameId)
  if (!frame) return
  setState({ debug: { ...getState().debug, selectedFrameId: frameId, scopes: [] }, variables: {} })
  if (frame.path) {
    setState({ debug: { ...getState().debug, location: { path: frame.path, line: frame.line } } })
    void openFile(frame.path, { line: frame.line, column: frame.column || 1 })
  }
  try {
    const scopes = await window.codemap.debug.scopes(frameId)
    setState({ debug: { ...getState().debug, scopes } })
    const first = scopes.find((scope) => !scope.expensive)
    if (first) await loadVariables(first.variablesReference)
  } catch (error) {
    console.warn(error)
  }
}

export async function loadVariables(reference: number): Promise<void> {
  if (!reference || getState().variables[reference]) return
  try {
    const variables = await window.codemap.debug.variables(reference)
    setState({ variables: { ...getState().variables, [reference]: variables } })
  } catch (error) {
    console.warn(error)
  }
}

async function onStopped(threadId: number | undefined, reason?: string): Promise<void> {
  let resolvedThread = threadId ?? null
  if (resolvedThread === null) {
    const threads = await window.codemap.debug.threads().catch(() => [])
    resolvedThread = threads[0]?.id ?? null
  }
  if (resolvedThread === null) return
  const frames = await window.codemap.debug.stackTrace(resolvedThread).catch(() => [])
  setState({
    debug: { ...getState().debug, state: 'stopped', threadId: resolvedThread, frames, reason, scopes: [] },
    variables: {}
  })
  const top = frames.find((frame) => frame.path) ?? frames[0]
  if (top) await selectFrame(top.id)
}

export function handleDebugEvent(event: DebugEvent): void {
  switch (event.type) {
    case 'state':
      if (event.state === 'stopped') {
        setState({ debug: { ...getState().debug, state: 'stopped', threadId: event.threadId ?? getState().debug.threadId } })
        void onStopped(event.threadId, event.reason)
      } else if (event.state === 'running') {
        setState({ debug: { ...getState().debug, state: 'running', frames: [], scopes: [], location: undefined }, variables: {} })
      } else if (event.state === 'terminated') {
        setState({ debug: { ...initialDebug, state: 'terminated' }, variables: {} })
        log('output', t('Debug session ended'))
      } else {
        setState({ debug: { ...getState().debug, state: event.state } })
      }
      break
    case 'output':
      log(event.category === 'stderr' ? 'stderr' : 'output', event.text)
      break
    case 'breakpoints':
      break
    case 'error':
      log('error', event.message)
      reportError(event.message)
      break
  }
}

export async function toggleBreakpoint(path: string, line: number): Promise<void> {
  const current = getState().breakpoints[path] ?? []
  const next = current.includes(line) ? current.filter((entry) => entry !== line) : [...current, line].sort((a, b) => a - b)
  const breakpoints = { ...getState().breakpoints }
  if (next.length) breakpoints[path] = next
  else delete breakpoints[path]
  setState({ breakpoints })
  try {
    await window.codemap.debug.setBreakpoints(path, next)
  } catch (error) {
    reportError(error)
  }
}

export async function removeAllBreakpoints(): Promise<void> {
  const paths = Object.keys(getState().breakpoints)
  setState({ breakpoints: {} })
  for (const path of paths) await window.codemap.debug.setBreakpoints(path, []).catch(() => undefined)
}

export async function evaluateInConsole(expression: string): Promise<void> {
  const trimmed = expression.trim()
  if (!trimmed) return
  log('input', trimmed)
  const { debug } = getState()
  if (debug.state !== 'stopped') {
    log('error', t('The program must be paused to evaluate expressions'))
    return
  }
  try {
    const result = await window.codemap.debug.evaluate(trimmed, debug.selectedFrameId)
    log('result', result)
  } catch (error) {
    log('error', error instanceof Error ? error.message : String(error))
  }
}
