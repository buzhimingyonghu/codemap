import { Bug, Circle, Play, Settings2, Trash } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { basename } from '@shared/paths'
import type { DebugVariable } from '@shared/types'
import { Chevron } from '../components/Icon'
import { IconButton } from '../components/IconButton'
import { t } from '../lib/i18n'
import { openFile } from '../services/documents'
import { loadVariables, removeAllBreakpoints, selectFrame, startDebugging, toggleBreakpoint } from '../services/debug'
import { setState, useStore } from '../state/store'

function Section({ title, open, onToggle, actions, children, count }: { title: string; open: boolean; onToggle: () => void; actions?: ReactNode; children: ReactNode; count?: number }) {
  return (
    <section className="debug-section">
      <div className="section-header" onClick={onToggle} role="button" aria-expanded={open} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
        <Chevron open={open} size={13} />
        <span className="section-title">{title}</span>
        {count ? <span className="count-badge">{count}</span> : null}
        <div className="section-actions" onClick={(event) => event.stopPropagation()}>
          {actions}
        </div>
      </div>
      {open ? <div className="section-body">{children}</div> : null}
    </section>
  )
}

function VariableRow({ variable, depth }: { variable: DebugVariable; depth: number }) {
  const [open, setOpen] = useState(false)
  const children = useStore((s) => s.variables[variable.variablesReference])
  const expandable = variable.variablesReference > 0
  const toggle = () => {
    if (!expandable) return
    if (!open) void loadVariables(variable.variablesReference)
    setOpen(!open)
  }
  return (
    <>
      <div className="var-row" style={{ paddingLeft: 12 + depth * 14 }} onClick={toggle} title={variable.type ? `${variable.name}: ${variable.type}` : variable.name}>
        <span className="tree-twist">{expandable ? <Chevron open={open} size={12} /> : null}</span>
        <span className="var-name">{variable.name}</span>
        <span className="var-sep">=</span>
        <span className={`var-value${/^-?\d/.test(variable.value) ? ' is-number' : variable.value.startsWith('"') ? ' is-string' : ''}`}>{variable.value}</span>
      </div>
      {open && children?.map((child) => <VariableRow key={`${variable.variablesReference}:${child.name}`} variable={child} depth={depth + 1} />)}
    </>
  )
}

export function DebugView() {
  const workspace = useStore((s) => s.workspace)
  const settings = useStore((s) => s.settings)
  const debug = useStore((s) => s.debug)
  const variables = useStore((s) => s.variables)
  const breakpoints = useStore((s) => s.breakpoints)
  const [open, setOpen] = useState({ variables: true, stack: true, breakpoints: true })

  if (!workspace) return <div className="view-empty"><p>{t('Open a folder to debug')}</p></div>

  const running = debug.state !== 'idle' && debug.state !== 'terminated'
  const program = settings?.debug.program
  const breakpointList = Object.entries(breakpoints).flatMap(([path, lines]) => lines.map((line) => ({ path, line })))

  return (
    <div className="debug-view">
      <div className="view-header">
        <span className="view-title">{t('Run and Debug')}</span>
        <div className="view-actions">
          <IconButton size="sm" label={t('Debug Configuration')} onClick={() => setState({ settingsOpen: true })}>
            <Settings2 size={14} />
          </IconButton>
        </div>
      </div>
      <div className="debug-scroll">
        {!running ? (
          <div className="debug-launch">
            <button type="button" className="button button--primary button--block" onClick={() => void startDebugging()}>
              <Play size={14} />
              <span>{t('Start Debugging')}</span>
            </button>
            <button type="button" className="debug-target" onClick={() => setState({ settingsOpen: true })} data-tooltip={t('Change program')}>
              <Bug size={13} />
              <span>{program ? basename(program) : t('Choose a program…')}</span>
            </button>
          </div>
        ) : (
          <div className={`debug-status status-${debug.state}`}>
            <span className="status-dot" />
            <span>
              {debug.state === 'stopped'
                ? debug.reason
                  ? t('Paused on {reason}', { reason: debug.reason })
                  : t('Paused')
                : debug.state === 'starting'
                  ? t('Starting…')
                  : t('Running')}
            </span>
          </div>
        )}

        <Section title={t('Variables')} open={open.variables} onToggle={() => setOpen({ ...open, variables: !open.variables })}>
          {debug.state === 'stopped' && debug.scopes.length ? (
            debug.scopes.map((scope) => <ScopeBlock key={scope.variablesReference} name={scope.name} reference={scope.variablesReference} items={variables[scope.variablesReference]} />)
          ) : (
            <div className="section-empty">{running ? t('Pause to inspect variables') : t('Not running')}</div>
          )}
        </Section>

        <Section title={t('Call Stack')} open={open.stack} onToggle={() => setOpen({ ...open, stack: !open.stack })} count={debug.frames.length || undefined}>
          {debug.frames.length ? (
            <ol className="stack-list" aria-label={t('Call Stack')}>
              {debug.frames.map((frame, index) => (
                <li
                  key={frame.id}
                  className={`stack-frame${frame.id === debug.selectedFrameId ? ' is-selected' : ''}${frame.path ? '' : ' is-external'}`}
                  onClick={() => void selectFrame(frame.id)}
                  title={frame.path ? `${frame.path}:${frame.line}` : frame.name}
                >
                  <span className="frame-index">{index}</span>
                  <span className="frame-name">{frame.name}</span>
                  <span className="frame-location">{frame.path ? `${basename(frame.path)}:${frame.line}` : t('no source')}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="section-empty">{running ? t('Running') : t('Not running')}</div>
          )}
        </Section>

        <Section
          title={t('Breakpoints')}
          open={open.breakpoints}
          onToggle={() => setOpen({ ...open, breakpoints: !open.breakpoints })}
          count={breakpointList.length || undefined}
          actions={
            breakpointList.length ? (
              <IconButton size="sm" label={t('Remove All Breakpoints')} onClick={() => void removeAllBreakpoints()}>
                <Trash size={13} />
              </IconButton>
            ) : null
          }
        >
          {breakpointList.length ? (
            breakpointList.map((bp) => (
              <div key={`${bp.path}:${bp.line}`} className="breakpoint-row" onClick={() => void openFile(bp.path, { line: bp.line })}>
                <Circle size={10} className="breakpoint-dot" fill="currentColor" />
                <span className="breakpoint-file">{basename(bp.path)}</span>
                <span className="breakpoint-line">{bp.line}</span>
                <span className="breakpoint-remove" onClick={(event) => event.stopPropagation()}>
                  <IconButton size="sm" label={t('Remove Breakpoint')} onClick={() => void toggleBreakpoint(bp.path, bp.line)}>
                    <Trash size={12} />
                  </IconButton>
                </span>
              </div>
            ))
          ) : (
            <div className="section-empty">{t('Click the gutter to add one')}</div>
          )}
        </Section>
      </div>
    </div>
  )
}

function ScopeBlock({ name, reference, items }: { name: string; reference: number; items?: DebugVariable[] }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="scope-block">
      <div
        className="scope-header"
        onClick={() => {
          if (!open) void loadVariables(reference)
          setOpen(!open)
        }}
      >
        <Chevron open={open} size={12} />
        <span>{name}</span>
      </div>
      {open ? (
        items ? (
          items.length ? (
            items.map((variable) => <VariableRow key={`${reference}:${variable.name}`} variable={variable} depth={1} />)
          ) : (
            <div className="section-empty indent">{t('No variables')}</div>
          )
        ) : (
          <LazyScope reference={reference} />
        )
      ) : null}
    </div>
  )
}

function LazyScope({ reference }: { reference: number }) {
  useEffect(() => {
    void loadVariables(reference)
  }, [reference])
  return <div className="section-empty indent">{t('Loading…')}</div>
}
