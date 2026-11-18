import { BookOpen, Check, ChevronDown, CircleAlert, CircleCheck, CircleSlash, Eye, EyeOff, FolderGit2, FolderOutput, History, Link2, LoaderCircle, MessageSquarePlus, Plus, Send, Sparkles, Square, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AGENT_MODES, type AgentChangeSet, type AgentEndReason, type AgentMode, type AgentStepView } from '@shared/agent'
import { t } from '../lib/i18n'
import {
  addLink,
  addLocalDocs,
  addRepos,
  outputFolder,
  removeDoc,
  removeRepo,
  approveGate,
  deleteSession,
  newSession,
  openSession,
  previewChangeSet,
  previewing,
  rejectChangeSet,
  restoreSession,
  send,
  setMode,
  setModel,
  setOutput,
  applyChangeSet,
  stop,
  useAgent,
  type WorkerView
} from '../services/agent'
import { useCodeMap } from '../services/codeMap'
import { setState } from '../state/store'

// The assistant tab of the code map side panel: pick a mode, talk, watch the map follow,
// review change sets on the map, and apply or reject them.

const MODE_LABEL = (): Record<AgentMode, string> => ({ ask: t('Ask'), adjust: t('Adjust map'), create: t('Build map'), require: t('Requirement') })
const MODE_HINT = (): Record<AgentMode, string> => ({
  ask: t('Ask about the system. The map follows the answer.'),
  adjust: t('Change the maps: split, merge, add a missed branch, rename. Changes are previewed on the map first.'),
  create: t('Build a new map from code and documents, stage by stage, stopping for your review.'),
  require: t('Describe a requirement. You get the affected nodes, a requirement layer, and test points.')
})
const PLACEHOLDER = (): Record<AgentMode, string> => ({
  ask: t('e.g. When a user cancels an order, how is the stock released?'),
  adjust: t('e.g. Split this node by its three branches'),
  create: t('e.g. Map the ordering and payment business in Repo/order-svc and Repo/payment-svc'),
  require: t('e.g. Orders should support coupons')
})

// How to describe the task well, per mode: shown under the input box.
const GUIDE = (): Record<AgentMode, string[]> => ({
  ask: [t('Name the scenario or node: "When a user stops a task…"'), t('Say what you want: the flow, where the data goes, why it fails')],
  adjust: [t('Select the node on the map first'), t('Say the change: split / merge / add a branch / rename, and why')],
  create: [t('Pick repositories above, then say in one sentence what the business does')],
  require: [t('Select the nodes the requirement touches, or name them'), t('Describe the requirement: what changes for the user'), t('Say any constraint: compatibility, rollout, performance')]
})

function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

/** Where the new map is written: the open node library, optionally a folder inside it. */
function Output() {
  const agent = useAgent()
  const { library } = useCodeMap()
  const folder = outputFolder(agent.output)
  const target = library ? (folder ? `${library}/${folder}` : library) : null
  return (
    <>
      <div className="ag-sources-row">
        <span className="ag-sources-lab">
          <FolderOutput size={12} />
          {t('Write to')}
        </span>
        {library ? (
          <button type="button" className="button ag-sources-add" onClick={() => void window.codemap.fs.reveal(library)}>
            {t('Show in Finder')}
          </button>
        ) : null}
      </div>
      {library ? (
        <div className="ag-output" data-tooltip={target ?? undefined}>
          <span className="ag-output-root">{shortPath(library)}/</span>
          <input
            className="input ag-output-input"
            value={agent.output}
            disabled={agent.running || !!agent.sessionId}
            placeholder={t('folder for the new map (empty: library root)')}
            onChange={(e) => setOutput(e.target.value)}
          />
        </div>
      ) : (
        <div className="ag-sources-hint">{t('You will pick where to keep the node library when you send the first message.')}</div>
      )}
    </>
  )
}

function Sources() {
  const agent = useAgent()
  const [link, setLink] = useState('')
  const [open, setOpen] = useState(true)
  const count = agent.repos.length + agent.docs.length
  const submitLink = () => {
    if (addLink(link)) setLink('')
  }
  return (
    <div className={'ag-sources' + (open ? ' is-open' : '')}>
      <button type="button" className="ag-sources-toggle" onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={12} className={open ? 'is-open' : ''} />
        {t('Repositories and knowledge')}
        {count ? <span className="cm-tab-count">{count}</span> : null}
        {!agent.repos.length ? <span className="ag-sources-need">{t('Pick at least one repository')}</span> : null}
      </button>
      {open ? (
        <div className="ag-sources-body">
          <Output />
          <div className="ag-sources-row">
            <span className="ag-sources-lab">
              <FolderGit2 size={12} />
              {t('Repositories')}
            </span>
            <button type="button" className="button ag-sources-add" disabled={agent.running} onClick={() => void addRepos()}>
              <Plus size={12} />
              {t('Add folders')}
            </button>
          </div>
          {agent.repos.map((r) => (
            <div key={r} className="ag-source" data-tooltip={r}>
              <FolderGit2 size={12} />
              <span className="ag-source-name">{shortPath(r)}</span>
              <button type="button" className="icon-button icon-button--sm" aria-label={t('Remove')} onClick={() => removeRepo(r)}>
                <X size={12} />
              </button>
            </div>
          ))}
          <div className="ag-sources-row">
            <span className="ag-sources-lab">
              <BookOpen size={12} />
              {t('Knowledge')}
            </span>
            <button type="button" className="button ag-sources-add" disabled={agent.running} onClick={() => void addLocalDocs()}>
              <Plus size={12} />
              {t('Local files')}
            </button>
          </div>
          <div className="ag-link-row">
            <input
              className="input ag-link-input"
              value={link}
              placeholder={t('Paste a link (wiki, design doc) and press Enter')}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitLink()
                }
              }}
            />
            <button type="button" className="icon-button icon-button--sm" aria-label={t('Add link')} disabled={!/^https?:\/\/\S+$/.test(link.trim())} onClick={submitLink}>
              <Link2 size={13} />
            </button>
          </div>
          {agent.docs.map((d) => (
            <div key={d.value} className="ag-source" data-tooltip={d.value}>
              {d.kind === 'url' ? <Link2 size={12} /> : <BookOpen size={12} />}
              <span className="ag-source-name">{d.kind === 'url' ? d.value.replace(/^https?:\/\//, '') : shortPath(d.value)}</span>
              <button type="button" className="icon-button icon-button--sm" aria-label={t('Remove')} onClick={() => removeDoc(d.value)}>
                <X size={12} />
              </button>
            </div>
          ))}
          {agent.docs.some((d) => d.kind === 'url') ? <div className="ag-sources-hint">{t('Links are passed along as references; paste the key content into the message if the assistant needs it.')}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

export function AgentTab({ selected, onFocusNode }: { selected: string | null; onFocusNode(id: string): void }) {
  const agent = useAgent()
  const [draft, setDraft] = useState('')
  const [history, setHistory] = useState(false)
  const [allModes, setAllModes] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const configured = agent.settings?.providers.find((p) => p.id === agent.settings?.activeProvider)?.hasKey !== false

  useEffect(() => {
    void restoreSession()
  }, [])
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [agent.messages, agent.changeSets.length, agent.gate, agent.workers])

  const needRepo = agent.mode === 'create' && !agent.repos.length && !agent.sessionId
  const sessionsShown = allModes ? agent.sessions : agent.sessions.filter((s) => s.mode === agent.mode)
  const submit = () => {
    if (!draft.trim() || needRepo) return
    void send(draft, selected ? [selected] : [])
    setDraft('')
  }

  return (
    <section className="ag">
      <div className="ag-head">
        <div className="segmented ag-modes" role="radiogroup" aria-label={t('Assistant mode')}>
          {AGENT_MODES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={agent.mode === m} className={agent.mode === m ? 'is-on' : undefined} data-tooltip={MODE_HINT()[m]} disabled={agent.running} onClick={() => void setMode(m)}>
              {MODE_LABEL()[m]}
            </button>
          ))}
        </div>
        <div className="ag-head-tools">
          <button type="button" className="icon-button icon-button--sm" aria-label={t('Conversations')} data-tooltip={t('Conversations')} onClick={() => setHistory((v) => !v)}>
            <History size={14} />
          </button>
          <button type="button" className="icon-button icon-button--sm" aria-label={t('New conversation')} data-tooltip={t('New conversation')} disabled={agent.running} onClick={() => newSession()}>
            <MessageSquarePlus size={14} />
          </button>
        </div>
      </div>

      {history ? (
        <div className="ag-history">
          <div className="ag-history-filter">
            <span className="cm-muted">{allModes ? t('All conversations') : t('{mode} conversations', { mode: MODE_LABEL()[agent.mode] })}</span>
            <button type="button" className="button ag-sources-add" onClick={() => setAllModes((v) => !v)}>
              {allModes ? t('Only this mode') : t('Show all modes')}
            </button>
          </div>
          {sessionsShown.length ? (
            sessionsShown.map((s) => (
              <div key={s.id} className={'ag-history-row' + (s.id === agent.sessionId ? ' is-on' : '')}>
                <button type="button" className="ag-history-open" disabled={agent.running} onClick={() => void openSession(s.id).then((ok) => ok && setHistory(false))}>
                  <span className="ag-history-mode">{MODE_LABEL()[s.mode]}</span>
                  <span className="ag-history-title">{s.title}</span>
                  <span className="ag-history-time">{new Date(s.updatedAt).toLocaleString()}</span>
                </button>
                <button type="button" className="icon-button icon-button--sm" aria-label={t('Delete')} onClick={() => void deleteSession(s.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          ) : (
            <div className="cm-empty">{t('No conversations yet')}</div>
          )}
        </div>
      ) : null}

      {agent.mode === 'create' ? <Sources /> : null}

      <div className="ag-scroll" ref={scrollRef}>
        {!agent.messages.length ? (
          <div className="ag-intro">
            <Sparkles size={18} />
            <p>{MODE_HINT()[agent.mode]}</p>
            {!configured ? (
              <button type="button" className="button" onClick={() => setState({ settingsOpen: true })}>
                {t('Set up a model in Settings')}
              </button>
            ) : null}
          </div>
        ) : null}
        {agent.messages.map((m, i) => (
          <div key={i} className={'ag-msg is-' + m.role}>
            {m.steps?.length ? <Steps steps={m.steps} /> : null}
            {m.text ? <RichText text={m.text} onNode={onFocusNode} /> : null}
            {m.role === 'assistant' && m.end && m.end !== 'end' ? <EndNote reason={m.end} /> : null}
          </div>
        ))}
        {agent.workers.length ? (
          <div className="ag-workers">
            <div className="cm-lab">{t('Sub-agents')}</div>
            {agent.workers.map((w) => (
              <Worker key={w.id} worker={w} onFocusNode={onFocusNode} />
            ))}
          </div>
        ) : null}
        {changeSetChains(agent.changeSets).map(({ set, earlier }) =>
          agent.running && set.status === 'proposed' ? <DraftLine key={set.id} set={set} /> : <ChangeSetCard key={set.id} set={set} earlier={earlier} />
        )}
        {agent.running ? <Progress /> : null}
        {agent.gate ? (
          <div className="ag-gate">
            <div className="ag-gate-title">
              <CircleAlert size={14} />
              {t('Review: {stage}', { stage: agent.gate.stage })}
            </div>
            <RichText text={agent.gate.summary} onNode={onFocusNode} />
            <div className="ag-gate-actions">
              <button type="button" className="button button--primary" disabled={agent.running} onClick={() => void approveGate()}>
                <Check size={13} />
                {t('Approve and continue')}
              </button>
              <span className="cm-muted">{t('Or write what to change below')}</span>
            </div>
          </div>
        ) : null}
      </div>

      {agent.note ? <div className="ag-note">{agent.note}</div> : null}
      <div className="ag-compose">
        {selected && agent.mode !== 'create' ? (
          <div className="ag-context">
            <span className="cm-muted">{t('About')}</span>
            <button type="button" className="cm-pill is-link" onClick={() => onFocusNode(selected)}>
              {selected}
            </button>
          </div>
        ) : null}
        <textarea
          className="input ag-input"
          value={draft}
          rows={3}
          placeholder={PLACEHOLDER()[agent.mode]}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        {!agent.messages.length ? (
          <ul className="ag-guide" aria-label={t('How to describe it')}>
            {GUIDE()[agent.mode].map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        ) : null}
        <div className="ag-compose-bar">
          <ModelPicker />
          {agent.usage.input ? (
            <span className="ag-usage" data-tooltip={t('Tokens used in this conversation')}>
              {Math.round(agent.usage.input / 1000)}k / {Math.round(agent.usage.output / 1000)}k
            </span>
          ) : null}
          {agent.running ? (
            <button type="button" className="button" onClick={() => void stop()}>
              <Square size={12} />
              {t('Stop')}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--primary"
            disabled={!draft.trim() || needRepo}
            data-tooltip={needRepo ? t('Pick at least one repository') : agent.running ? t('The assistant reads it before its next step') : undefined}
            onClick={submit}
          >
            <Send size={12} />
            {t('Send')}
          </button>
        </div>
      </div>
    </section>
  )
}

/** A sub-agent: its node, state and latest step; click the row to see every step. */
function Worker({ worker: w, onFocusNode }: { worker: WorkerView; onFocusNode(id: string): void }) {
  const [open, setOpen] = useState(false)
  const last = w.steps[w.steps.length - 1]
  return (
    <div className={'ag-worker-box is-' + w.state}>
      <div className={'ag-worker is-' + w.state}>
        <button type="button" className="ag-worker-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <ChevronDown size={12} className={open ? 'is-open' : ''} />
          {w.state === 'running' ? <LoaderCircle size={12} className="spin" /> : w.state === 'done' ? <CircleCheck size={12} /> : w.state === 'stopped' ? <CircleSlash size={12} /> : <CircleAlert size={12} />}
        </button>
        <button type="button" className="ag-worker-node mono" onClick={() => onFocusNode(w.node)}>
          {w.node}
        </button>
        <span className="ag-worker-note">{w.note ?? (last ? last.label : t('Starting…'))}</span>
        <span className="ag-worker-count">{t('{n} steps', { n: w.steps.filter((s) => s.name !== 'note').length })}</span>
      </div>
      {open && w.steps.length ? (
        <ol className="ag-step-list ag-worker-steps">
          {w.steps.map((s, i) => (
            <li key={i} className={(s.name === 'note' ? 'is-note ' : '') + stepClass(s)}>
              <span className="ag-step-label">{s.label}</span>
              {s.summary ? <span className="ag-step-sum">{s.summary}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

function stepClass(s: AgentStepView): string {
  if (s.stopped) return 'is-stopped'
  return s.ok === false ? 'is-bad' : s.ok ? 'is-ok' : 'is-run'
}

/** While a run goes: what it is doing, how many model calls so far, and for how long. */
function Progress() {
  const agent = useAgent()
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const p = agent.progress
  if (!p) return null
  const last = [...agent.messages].reverse().find((m) => m.role === 'assistant')
  const step = [...(last?.steps ?? [])].reverse().find((s) => s.ok === undefined && !s.stopped)
  const busy = agent.workers.filter((w) => w.state === 'running').length
  const what =
    p.phase === 'workers'
      ? t('Sub-agents working: {busy} of {n} running', { busy, n: agent.workers.length || p.workers || 0 })
      : p.phase === 'fixing'
        ? t('Fixing checker errors')
        : p.phase === 'tools' && step
          ? step.label
          : t('Waiting for the model')
  const secs = Math.max(0, Math.round((Date.now() - p.since) / 1000))
  const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
  return (
    <div className="ag-progress" role="status">
      <LoaderCircle size={12} className="spin" />
      <span className="ag-progress-what">{what}</span>
      <span className="ag-progress-meta">
        {p.turn ? t('round {n}', { n: p.turn }) + ' · ' : ''}
        {time}
      </span>
    </div>
  )
}

const END_LABEL = (): Record<AgentEndReason, string> => ({
  end: t('Done'),
  gate: t('Waiting for your review'),
  stopped: t('Stopped'),
  limit: t('Stopped at the limit'),
  error: t('Ended with an error')
})

function EndNote({ reason }: { reason: AgentEndReason }) {
  return (
    <div className={'ag-end is-' + reason}>
      {reason === 'stopped' ? <CircleSlash size={12} /> : reason === 'gate' ? <CircleAlert size={12} /> : <CircleAlert size={12} />}
      {END_LABEL()[reason]}
    </div>
  )
}

/**
 * Proposals that continue a rejected one (replaces) are one piece of work: show the newest
 * version, with how many earlier versions it went through.
 */
function changeSetChains(sets: AgentChangeSet[]): Array<{ set: AgentChangeSet; earlier: AgentChangeSet[] }> {
  const replacedBy = new Map<string, string>()
  for (const c of sets) if (c.replaces) replacedBy.set(c.replaces, c.id)
  const byId = new Map(sets.map((c) => [c.id, c]))
  const out: Array<{ set: AgentChangeSet; earlier: AgentChangeSet[] }> = []
  for (const c of sets) {
    if (replacedBy.has(c.id)) continue
    const earlier: AgentChangeSet[] = []
    for (let prev = c.replaces ? byId.get(c.replaces) : undefined; prev; prev = prev.replaces ? byId.get(prev.replaces) : undefined) earlier.unshift(prev)
    out.push({ set: c, earlier })
  }
  return out
}

function Steps({ steps }: { steps: AgentStepView[] }) {
  const [open, setOpen] = useState(false)
  const running = steps.filter((s) => s.ok === undefined && !s.stopped).length
  const failed = steps.filter((s) => s.ok === false).length
  return (
    <div className="ag-steps">
      <button type="button" className="ag-steps-toggle" onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={12} className={open ? 'is-open' : ''} />
        {t('{n} steps', { n: steps.length })}
        {running ? <LoaderCircle size={11} className="spin" /> : null}
        {failed ? <span className="is-bad">{t('{n} failed', { n: failed })}</span> : null}
        {!open ? <span className="ag-steps-last">{steps[steps.length - 1]?.label}</span> : null}
      </button>
      {open ? (
        <ol className="ag-step-list">
          {steps.map((s, i) => (
            <li key={i} className={stepClass(s)}>
              <span className="ag-step-label">{s.label}</span>
              {s.summary ? <span className="ag-step-sum">{s.summary}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

/** While the agent works, a proposal is a draft it is still writing and checking: no buttons yet. */
function DraftLine({ set }: { set: AgentChangeSet }) {
  return (
    <div className="ag-draft">
      <LoaderCircle size={12} className="spin" />
      <span className="ag-draft-title">{set.title}</span>
      <span className="ag-draft-meta">
        {t('{n} files', { n: Object.keys(set.files).length })} · {t('Checking and fixing')}
      </span>
    </div>
  )
}

function ChangeSetCard({ set, earlier = [] }: { set: AgentChangeSet; earlier?: AgentChangeSet[] }) {
  const shown = previewing() === set.id
  const files = Object.keys(set.files)
  const ops = (op: string) => set.changes.filter((c) => op in c).length
  // Waiting for a decision: open. Applied or rejected: one line, click to open.
  const [open, setOpen] = useState(set.status === 'proposed')
  const [more, setMore] = useState(false)
  useEffect(() => setOpen(set.status === 'proposed'), [set.status])
  const long = set.summary.length > 160 || set.summary.includes('\n')
  return (
    <div className={'ag-set is-' + set.status + (open ? ' is-open' : '')}>
      <button type="button" className="ag-set-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={12} className={open ? 'is-open' : ''} />
        <span className="ag-set-title">
          {set.requirement ? t('Requirement') + ' · ' : ''}
          {set.title}
        </span>
        {earlier.length ? <span className="ag-set-rev">{t('revised {n} times', { n: earlier.length })}</span> : null}
        <span className="ag-set-status">{set.status === 'applied' ? t('Applied') : set.status === 'rejected' ? t('Rejected') : t('Proposed')}</span>
      </button>
      {!open ? null : (
        <>
      {set.summary ? (
        <div className="ag-set-summary">
          <p className={'cm-desc' + (long && !more ? ' is-clamped' : '')}>{set.summary}</p>
          {long ? (
            <button type="button" className="ag-set-more" onClick={() => setMore((v) => !v)}>
              {more ? t('Show less') : t('Show more')}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="cm-req-meta">
        <span className="is-add">+{ops('add')}</span>
        <span className="is-mod">~{ops('modify')}</span>
        <span className="is-del">−{ops('remove')}</span>
        {files.length ? <span>{t('{n} files', { n: files.length })}</span> : null}
      </div>
      {files.length ? (
        <details className="ag-set-files">
          <summary>{t('Files')}</summary>
          {files.map((f) => (
            <div key={f} className="mono">
              {f}
            </div>
          ))}
        </details>
      ) : null}
      {set.status === 'proposed' ? (
        <div className="ag-set-actions">
          <button type="button" className="button" onClick={() => previewChangeSet(shown ? null : set)}>
            {shown ? <EyeOff size={13} /> : <Eye size={13} />}
            {shown ? t('Hide on map') : t('Show on map')}
          </button>
          <button type="button" className="button" onClick={() => void rejectChangeSet(set)}>
            <X size={13} />
            {t('Reject')}
          </button>
          <button type="button" className="button button--primary" onClick={() => void applyChangeSet(set)}>
            <Check size={13} />
            {set.requirement ? t('Save requirement') : t('Apply')}
          </button>
        </div>
      ) : null}
        </>
      )}
    </div>
  )
}

function ModelPicker() {
  const agent = useAgent()
  const [models, setModels] = useState<string[] | null>(null)
  const provider = agent.settings?.providers.find((p) => p.id === agent.settings?.activeProvider)
  const fallback = agent.settings?.modeModels[agent.mode] || provider?.model || ''
  return (
    <select
      className="input ag-model"
      value={agent.model}
      aria-label={t('Model')}
      onFocus={() => {
        if (!models) void window.codemap.agent.models().then(setModels, () => setModels([]))
      }}
      onChange={(event) => setModel(event.target.value)}
    >
      <option value="">{fallback ? t('Default ({model})', { model: fallback }) : t('Default model')}</option>
      {(models ?? []).map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  )
}

// Minimal rendering: paragraphs, bullet lines, inline code. Inline code that names a node
// becomes a link that opens it on the map.
function RichText({ text, onNode }: { text: string; onNode(id: string): void }) {
  const blocks = text.split(/\n{2,}/)
  return (
    <div className="ag-text">
      {blocks.map((block, i) => {
        if (block.startsWith('\u0060\u0060\u0060')) {
          return (
            <pre key={i} className="ag-code">
              {block.replace(/^\u0060\u0060\u0060[^\n]*\n?/, '').replace(/\u0060\u0060\u0060\s*$/, '')}
            </pre>
          )
        }
        const lines = block.split('\n')
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''), onNode)}</li>
              ))}
            </ul>
          )
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {j ? <br /> : null}
                {inline(l.replace(/^#+\s*/, ''), onNode)}
              </span>
            ))}
          </p>
        )
      })}
    </div>
  )
}

function inline(line: string, onNode: (id: string) => void): ReactNode[] {
  const out: ReactNode[] = []
  const re = /\u0060([^\u0060]+)\u0060|\*\*([^*]+)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index))
    if (m[1] !== undefined) {
      const id = m[1]
      const looksLikeNode = /^[A-Za-z0-9][\w-]*(\.[\w-]+)*$/.test(id) && !/\.(go|ts|js|py|yaml|md)$/.test(id)
      out.push(
        looksLikeNode ? (
          <button key={m.index} type="button" className="ag-node" onClick={() => onNode(id)}>
            {id}
          </button>
        ) : (
          <code key={m.index}>{id}</code>
        )
      )
    } else out.push(<b key={m.index}>{m[2]}</b>)
    last = m.index + m[0].length
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}
