import { CircleAlert, CircleX, Info, TriangleAlert } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { parseDiagnosticLine } from '@shared/diagnostics'
import { basename } from '@shared/paths'
import type { Diagnostic } from '@shared/types'
import { t } from '../lib/i18n'
import { openFile } from '../services/documents'
import { evaluateInConsole } from '../services/debug'
import { useStore } from '../state/store'

function useStickToBottom<T>(dependency: T) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const element = ref.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [dependency])
  const onScroll = () => {
    const element = ref.current
    if (!element) return
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
  }
  return { ref, onScroll }
}

export function OutputView() {
  const output = useStore((s) => s.output)
  const root = useStore((s) => s.workspace?.root ?? '')
  const build = useStore((s) => s.build)
  const { ref, onScroll } = useStickToBottom(output.length)

  if (!output.length) {
    return (
      <div className="panel-empty">
        {build.status === 'running' ? t('Waiting for output…') : t('Run a build to see its output here')}
      </div>
    )
  }

  return (
    <div className="output" ref={ref} onScroll={onScroll} role="log" aria-live="polite">
      {output.map((line) => {
        const diagnostic = line.stream !== 'system' ? parseDiagnosticLine(line.text, root) : null
        return (
          <div
            key={line.id}
            className={`output-line stream-${line.stream}${diagnostic ? ` is-link severity-${diagnostic.severity}` : ''}`}
            onClick={diagnostic ? () => void openFile(diagnostic.file, { line: diagnostic.line, column: diagnostic.column }) : undefined}
          >
            {line.text || ' '}
          </div>
        )
      })}
    </div>
  )
}

function SeverityIcon({ severity }: { severity: Diagnostic['severity'] }) {
  if (severity === 'error') return <CircleX size={14} className="sev sev-error" />
  if (severity === 'warning') return <TriangleAlert size={14} className="sev sev-warning" />
  return <Info size={14} className="sev sev-note" />
}

export function ProblemsView() {
  const diagnostics = useStore((s) => s.diagnostics)
  const root = useStore((s) => s.workspace?.root ?? '')
  const grouped = useMemo(() => {
    const map = new Map<string, Diagnostic[]>()
    for (const diagnostic of diagnostics) {
      const list = map.get(diagnostic.file) ?? []
      list.push(diagnostic)
      map.set(diagnostic.file, list)
    }
    return [...map.entries()]
  }, [diagnostics])

  if (!diagnostics.length) {
    return (
      <div className="panel-empty">
        <CircleAlert size={15} />
        <span>{t('No problems detected')}</span>
      </div>
    )
  }

  return (
    <div className="problems">
      {grouped.map(([file, list]) => (
        <div key={file} className="problem-group">
          <div className="problem-file">
            <span className="problem-file-name">{basename(file)}</span>
            <span className="problem-file-dir">{file.startsWith(root) ? file.slice(root.length + 1) : file}</span>
            <span className="count-badge">{list.length}</span>
          </div>
          {list.map((d, index) => (
            <div key={index} className="problem-row" onClick={() => void openFile(d.file, { line: d.line, column: d.column })}>
              <SeverityIcon severity={d.severity} />
              <span className="problem-message">{d.message}</span>
              <span className="problem-location">
                [{d.line}, {d.column}]
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function DebugConsoleView() {
  const lines = useStore((s) => s.debugConsole)
  const debugState = useStore((s) => s.debug.state)
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [cursor, setCursor] = useState(-1)
  const { ref, onScroll } = useStickToBottom(lines.length)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (debugState === 'stopped') inputRef.current?.focus({ preventScroll: true })
  }, [debugState])

  const submit = () => {
    if (!input.trim()) return
    void evaluateInConsole(input)
    setHistory([input, ...history.filter((h) => h !== input)].slice(0, 50))
    setCursor(-1)
    setInput('')
  }

  return (
    <div className="debug-console">
      <div className="console-lines" ref={ref} onScroll={onScroll} role="log">
        {lines.length === 0 ? <div className="panel-empty">{t('Program output and evaluation results appear here')}</div> : null}
        {lines.map((line) => (
          <div key={line.id} className={`console-line kind-${line.kind}`}>
            {line.kind === 'input' ? <span className="console-prompt">›</span> : null}
            {line.text || ' '}
          </div>
        ))}
      </div>
      <div className={`console-input${debugState === 'stopped' ? '' : ' is-disabled'}`}>
        <span className="console-prompt">›</span>
        <input
          ref={inputRef}
          value={input}
          placeholder={debugState === 'stopped' ? t('Evaluate expression') : t('Pause the program to evaluate')}
          aria-label={t('Evaluate expression')}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
            if (event.key === 'ArrowUp' && history.length) {
              const next = Math.min(history.length - 1, cursor + 1)
              setCursor(next)
              setInput(history[next])
              event.preventDefault()
            }
            if (event.key === 'ArrowDown') {
              const next = cursor - 1
              setCursor(Math.max(-1, next))
              setInput(next < 0 ? '' : history[next])
              event.preventDefault()
            }
          }}
        />
      </div>
    </div>
  )
}
