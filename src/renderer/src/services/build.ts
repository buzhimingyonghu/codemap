import { parseDiagnostics } from '@shared/diagnostics'
import type { Diagnostic } from '@shared/types'
import { monaco } from '../editor/monaco'
import { getState, setState, uid } from '../state/store'
import { getModel, saveAll } from './documents'
import { notify, reportError } from './ui'
import { Emitter } from '../lib/events'
import { t } from '../lib/i18n'

const MAX_OUTPUT_LINES = 5000
let outputText = ''
let partial = ''
let finishedResolvers: Array<(ok: boolean) => void> = []
export const onDidFinishBuild = new Emitter<{ ok: boolean; diagnostics: Diagnostic[] }>()

export function appendOutput(stream: 'stdout' | 'stderr' | 'system', text: string): void {
  const combined = partial + text
  const lines = combined.split(/\r?\n/)
  partial = lines.pop() ?? ''
  if (!lines.length) return
  const entries = lines.map((line) => ({ id: uid(), stream, text: line }))
  const output = [...getState().output, ...entries]
  setState({ output: output.length > MAX_OUTPUT_LINES ? output.slice(-MAX_OUTPUT_LINES) : output })
}

function flushPartial(stream: 'stdout' | 'stderr' | 'system'): void {
  if (!partial) return
  setState({ output: [...getState().output, { id: uid(), stream, text: partial }] })
  partial = ''
}

export function clearOutput(): void {
  outputText = ''
  partial = ''
  setState({ output: [] })
}

export async function runBuild(): Promise<boolean> {
  const state = getState()
  if (!state.workspace) {
    notify(t('Open a folder first'), 'warning')
    return false
  }
  const command = state.settings?.buildCommand?.trim()
  if (!command) {
    setState({ settingsOpen: true })
    notify(t('Set a build command for this folder'), 'info')
    return false
  }
  if (state.build.status === 'running' && state.build.taskId) await stopBuild()
  await saveAll()
  clearOutput()
  setDiagnostics([])
  setState({
    build: { status: 'running', taskId: null, startedAt: Date.now() },
    panelVisible: true,
    panelView: 'output'
  })
  try {
    const taskId = await window.codemap.tasks.run(command)
    setState({ build: { ...getState().build, taskId } })
  } catch (error) {
    setState({ build: { status: 'failed', taskId: null } })
    reportError(error, t('Build failed to start'))
    return false
  }
  return new Promise((resolve) => finishedResolvers.push(resolve))
}

export async function stopBuild(): Promise<void> {
  const taskId = getState().build.taskId
  if (taskId) await window.codemap.tasks.stop(taskId)
}

export function handleTaskOutput(taskId: string, stream: 'stdout' | 'stderr' | 'system', text: string): void {
  if (getState().build.taskId && getState().build.taskId !== taskId) return
  outputText += text
  if (outputText.length > 4_000_000) outputText = outputText.slice(-2_000_000)
  appendOutput(stream, text)
}

export function handleTaskExit(taskId: string, code: number | null, signal: string | null, durationMs: number): void {
  const build = getState().build
  if (build.taskId && build.taskId !== taskId) return
  flushPartial('stdout')
  const root = getState().workspace?.root ?? ''
  const diagnostics = parseDiagnostics(outputText, root)
  setDiagnostics(diagnostics)
  const stopped = signal === 'SIGTERM' || signal === 'SIGKILL'
  const ok = code === 0
  const seconds = (durationMs / 1000).toFixed(1)
  const summary = stopped ? t('Build stopped after {s}s', { s: seconds }) : ok ? t('Build succeeded in {s}s', { s: seconds }) : t('Build failed with exit code {code} after {s}s', { code: String(code), s: seconds })
  appendOutput('system', `${summary}\n`)
  setState({ build: { status: stopped ? 'stopped' : ok ? 'succeeded' : 'failed', taskId: null, durationMs, exitCode: code } })
  if (!ok && diagnostics.length && !stopped) setState({ panelView: 'problems', panelVisible: true })
  const resolvers = finishedResolvers
  finishedResolvers = []
  for (const resolve of resolvers) resolve(ok)
  onDidFinishBuild.emit({ ok, diagnostics })
}

const MARKER_OWNER = 'codemap-build'

export function setDiagnostics(diagnostics: Diagnostic[]): void {
  setState({ diagnostics })
  applyMarkers()
}

// Re-run when a document opens so build errors appear on files opened after the build.
export function applyMarkers(): void {
  const byFile = new Map<string, Diagnostic[]>()
  for (const diagnostic of getState().diagnostics) {
    const list = byFile.get(diagnostic.file) ?? []
    list.push(diagnostic)
    byFile.set(diagnostic.file, list)
  }
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme !== 'file') continue
    const owned = getModel(model.uri.path) === model
    if (!owned) continue
    const list = byFile.get(model.uri.path) ?? []
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      list.map((d) => ({
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.line,
        endColumn: Math.max(d.column + 1, model.getLineMaxColumn(Math.min(d.line, model.getLineCount()))),
        message: d.message,
        severity:
          d.severity === 'error' ? monaco.MarkerSeverity.Error : d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        source: 'build'
      }))
    )
  }
}
