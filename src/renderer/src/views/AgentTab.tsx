import { BookOpen, Check, ChevronDown, CircleAlert, CircleCheck, CircleSlash, Eye, EyeOff, FolderGit2, FolderOutput, History, Link2, LoaderCircle, MessageSquarePlus, Plus, Send, Settings2, Sparkles, Square, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AGENT_MODES, BUILD_LENSES, BUILD_TIERS, type AgentChangeSet, type AgentEndReason, type AgentMode, type AgentProvider, type AgentStepView, type AgentUsageSummary, type BuildLens, type BuildTier } from '@shared/agent'
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
  restoreSession,
  send,
  selectProvider,
  setMode,
  setModel,
  setOutput,
  applyChangeSet,
  discardChangeSet,
  discardStaleDrafts,
  drillDownNode,
  stop,
  setBuildLens,
  setBuildTier,
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
          <BuildControls />
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

const TIER_LABEL = (): Record<BuildTier, string> => ({ fast: t('Fast'), balanced: t('Balanced'), deep: t('Deep') })
const TIER_HINT = (): Record<BuildTier, string> => ({
  fast: t('Fast: L0+L1 skeleton with zero review pauses'),
  balanced: t('Balanced: align structured blueprint once, then build L0+L1'),
  deep: t('Deep: stage-by-stage drill-down to functions and branches')
})
const LENS_LABEL = (): Record<BuildLens, string> => ({ service: t('Services & Storage'), business: t('Business Flow'), troubleshoot: t('Troubleshooting') })
const LENS_HINT = (): Record<BuildLens, string> => ({
  service: t('Group by real microservices, entrypoints, DB/Redis/MQ'),
  business: t('Group by user-facing product capabilities and stages'),
  troubleshoot: t('Highlight state transitions, retries, timeouts, and background jobs')
})

function BuildControls() {
  const agent = useAgent()
  return (
    <div className="ag-build">
      <div className="ag-build-row">
        <span className="ag-sources-lab">{t('Build tier')}</span>
        <div className="segmented ag-build-seg" role="radiogroup" aria-label={t('Build tier')}>
          {BUILD_TIERS.map((tier) => (
            <button key={tier} type="button" role="radio" aria-checked={agent.buildTier === tier} className={agent.buildTier === tier ? 'is-on' : undefined} title={TIER_HINT()[tier]} data-tooltip={TIER_HINT()[tier]} disabled={agent.running} onClick={() => setBuildTier(tier)}>
              {TIER_LABEL()[tier]}
            </button>
          ))}
        </div>
      </div>
      <div className="ag-build-row">
        <span className="ag-sources-lab">{t('Perspective')}</span>
        <div className="segmented ag-build-seg" role="radiogroup" aria-label={t('Perspective')}>
          {BUILD_LENSES.map((lens) => (
            <button key={lens} type="button" role="radio" aria-checked={agent.buildLens === lens} className={agent.buildLens === lens ? 'is-on' : undefined} title={LENS_HINT()[lens]} data-tooltip={LENS_HINT()[lens]} disabled={agent.running} onClick={() => setBuildLens(lens)}>
              {LENS_LABEL()[lens]}
            </button>
          ))}
        </div>
      </div>
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

      <ProposalTray />

      {agent.note ? <div className="ag-note">{agent.note}</div> : null}
      <div className="ag-compose">
        {selected && agent.mode !== 'create' ? (
          <div className="ag-context">
            <span className="cm-muted">{t('About')}</span>
            <button type="button" className="cm-pill is-link" onClick={() => onFocusNode(selected)}>
              {selected}
            </button>
            <button type="button" className="button ag-drill" disabled={agent.running} onClick={() => void drillDownNode(selected)}>
              {t('Drill down this node')}
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
          <ProviderModelPicker />
          {agent.usage.contextTokens > 0 || agent.usage.totalInput > 0 ? (
            <span className="ag-usage" title={usageTip(agent.usage)} data-tooltip={usageTip(agent.usage)}>
              {t('Ctx {ctx}', { ctx: fmtTokens(agent.usage.contextTokens) })}
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

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function usageTip(u: AgentUsageSummary): string {
  if ((u.workerInput ?? 0) > 0) {
    return t('Context window: {ctx} tokens · Main in/out: {in}/{out} · Sub-agents in/out: {win}/{wout}', {
      ctx: fmtTokens(u.contextTokens),
      in: fmtTokens(u.totalInput),
      out: fmtTokens(u.totalOutput),
      win: fmtTokens(u.workerInput ?? 0),
      wout: fmtTokens(u.workerOutput ?? 0)
    })
  }
  return t('Context window: {ctx} tokens · Cumulative input: {in} · Output: {out}', {
    ctx: fmtTokens(u.contextTokens),
    in: fmtTokens(u.totalInput),
    out: fmtTokens(u.totalOutput)
  })
}

function isStaleDraft(set: AgentChangeSet): boolean {
  return set.status === 'rejected' || (set.status === 'proposed' && set.problems.some((problem) => problem.level === 'error'))
}

function problemCounts(set: AgentChangeSet): { errors: number; warnings: number } {
  return {
    errors: set.problems.filter((problem) => problem.level === 'error').length,
    warnings: set.problems.filter((problem) => problem.level !== 'error').length
  }
}

/** Proposals live outside the conversation so applied and rejected cards do not break the reading flow. */
function ProposalTray() {
  const agent = useAgent()
  const chains = changeSetChains(agent.changeSets)
  const pending = chains.filter(({ set }) => set.status === 'proposed')
  const processed = chains.filter(({ set }) => set.status === 'applied' || set.status === 'rejected')
  const staleCount = agent.changeSets.filter(isStaleDraft).length
  const [pendingOpen, setPendingOpen] = useState(true)
  const [processedOpen, setProcessedOpen] = useState(false)
  if (!chains.length) return null
  return (
    <div className="ag-tray">
      {pending.length ? (
        <section className={'ag-tray-group' + (pendingOpen ? ' is-open' : '')}>
          <div className="ag-tray-head">
            <button type="button" className="ag-tray-toggle" aria-expanded={pendingOpen} onClick={() => setPendingOpen((open) => !open)}>
              <ChevronDown size={12} className={pendingOpen ? 'is-open' : ''} />
              {t('Pending proposals ({n})', { n: pending.length })}
            </button>
            {staleCount >= 2 && !agent.running ? (
              <button type="button" className="button ag-sources-add" onClick={() => void discardStaleDrafts()}>
                {t('Clean up stale drafts ({n})', { n: staleCount })}
              </button>
            ) : null}
          </div>
          {pendingOpen ? (
            <div className="ag-tray-list">
              {pending.map(({ set, earlier }) =>
                agent.running ? <DraftLine key={set.id} set={set} /> : <ChangeSetCard key={set.id} set={set} earlier={earlier} />
              )}
            </div>
          ) : null}
        </section>
      ) : staleCount >= 2 && !agent.running ? (
        <div className="ag-tray-head">
          <button type="button" className="button ag-sources-add" onClick={() => void discardStaleDrafts()}>
            {t('Clean up stale drafts ({n})', { n: staleCount })}
          </button>
        </div>
      ) : null}
      {processed.length ? (
        <section className={'ag-tray-group is-done' + (processedOpen ? ' is-open' : '')}>
          <button type="button" className="ag-tray-toggle" aria-expanded={processedOpen} onClick={() => setProcessedOpen((open) => !open)}>
            <ChevronDown size={12} className={processedOpen ? 'is-open' : ''} />
            {t('Processed ({n})', { n: processed.length })}
          </button>
          {processedOpen ? (
            <div className="ag-tray-list">
              {processed.map(({ set }) => (
                <ProcessedLine key={set.id} set={set} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

/** While the agent works, a proposal is still a draft: id, files, and a way to throw it away. */
function DraftLine({ set }: { set: AgentChangeSet }) {
  return (
    <div className="ag-draft">
      <LoaderCircle size={12} className="spin" />
      <span className="ag-id">#{set.id}</span>
      <span className="ag-draft-title">{set.title}</span>
      <span className="ag-draft-meta">{t('{n} files', { n: Object.keys(set.files).length })}</span>
      {set.status !== 'applied' ? (
        <button type="button" className="icon-button icon-button--sm" aria-label={t('Discard')} title={t('Discard draft proposal')} data-tooltip={t('Discard draft proposal')} onClick={() => void discardChangeSet(set)}>
          <Trash2 size={12} />
        </button>
      ) : null}
    </div>
  )
}

function ChangeSetCard({ set, earlier = [] }: { set: AgentChangeSet; earlier?: AgentChangeSet[] }) {
  const agent = useAgent()
  const shown = previewing() === set.id
  const files = Object.keys(set.files)
  const ops = (op: string) => set.changes.filter((change) => op in change).length
  const { errors, warnings } = problemCounts(set)
  const [problemsOpen, setProblemsOpen] = useState(false)
  const [more, setMore] = useState(false)
  const long = set.summary.length > 160 || set.summary.includes('\n')
  const askFix = () => {
    void send(
      t('Please fix all checker errors in proposal #{id} (“{title}”), or discard it with discard_change_set if it should be replaced cleanly.', { id: set.id, title: set.title }),
      []
    )
  }
  return (
    <div className={'ag-set is-' + set.status + ' is-open'}>
      <div className="ag-set-head">
        <span className="ag-id">#{set.id}</span>
        <span className="ag-set-title">
          {set.requirement ? t('Requirement') + ' · ' : ''}
          {set.title}
        </span>
        {earlier.length ? <span className="ag-set-rev">{t('revised {n} times', { n: earlier.length })}</span> : null}
      </div>
      {set.summary ? (
        <div className="ag-set-summary">
          <p className={'cm-desc' + (long && !more ? ' is-clamped' : '')}>{set.summary}</p>
          {long ? (
            <button type="button" className="ag-set-more" onClick={() => setMore((value) => !value)}>
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
        {errors ? (
          <button type="button" className="ag-set-problems is-bad" aria-expanded={problemsOpen} onClick={() => setProblemsOpen((open) => !open)}>
            {t('{n} errors', { n: errors })}
          </button>
        ) : null}
        {warnings ? (
          <button type="button" className="ag-set-problems is-warn" aria-expanded={problemsOpen} onClick={() => setProblemsOpen((open) => !open)}>
            {t('{n} warnings', { n: warnings })}
          </button>
        ) : null}
      </div>
      {problemsOpen && set.problems.length ? (
        <ul className="ag-set-problem-list">
          {set.problems.map((problem, index) => (
            <li key={index} className={problem.level === 'error' ? 'is-bad' : 'is-warn'}>
              <b>{problem.rule}</b>
              {problem.where ? <span className="mono"> {problem.where}</span> : null}
              <span> {problem.msg}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {files.length ? (
        <details className="ag-set-files">
          <summary>{t('Files')}</summary>
          {files.map((file) => (
            <div key={file} className="mono">
              {file}
            </div>
          ))}
        </details>
      ) : null}
      <div className="ag-set-actions">
        <button type="button" className="button" onClick={() => previewChangeSet(shown ? null : set)}>
          {shown ? <EyeOff size={13} /> : <Eye size={13} />}
          {shown ? t('Hide on map') : t('Show on map')}
        </button>
        <button type="button" className="button" onClick={() => void discardChangeSet(set)}>
          <Trash2 size={13} />
          {t('Discard')}
        </button>
        {errors > 0 && !agent.running ? (
          <button type="button" className="button" onClick={askFix}>
            {t('Ask AI to fix')}
          </button>
        ) : null}
        <button type="button" className="button button--primary" disabled={errors > 0} onClick={() => void applyChangeSet(set)}>
          <Check size={13} />
          {set.requirement ? t('Save requirement') : t('Apply')}
        </button>
      </div>
    </div>
  )
}

function ProcessedLine({ set }: { set: AgentChangeSet }) {
  return (
    <div className={'ag-processed is-' + set.status}>
      <span className="ag-processed-mark">{set.status === 'applied' ? '✓' : '–'}</span>
      <span className="ag-id">#{set.id}</span>
      <span className="ag-processed-title">{set.title}</span>
      {set.status === 'rejected' ? (
        <button type="button" className="button ag-sources-add" onClick={() => void discardChangeSet(set)}>
          {t('Discard')}
        </button>
      ) : null}
    </div>
  )
}

function providerLabel(provider: AgentProvider): string {
  if (provider.keySource !== 'local') return provider.name
  const offline = provider.hasKey === false ? t(' (offline)') : ''
  if (provider.localSource === 'claude' || provider.id === 'local-gateway') return t('Claude Code Gateway') + offline
  if (provider.localSource === 'codex' || provider.id === 'local-codex') return t('Codex / Magpie Gateway') + offline
  return t('Local gateway') + offline
}

function ProviderModelPicker() {
  const agent = useAgent()
  const providers = agent.settings?.providers ?? []
  const activeProviderId = agent.providerId || agent.settings?.activeProvider || ''
  const provider = providers.find((item) => item.id === activeProviderId)
  const [models, setModels] = useState<string[]>([])
  const [loadedFor, setLoadedFor] = useState('')
  const fallback = (!agent.providerId || agent.providerId === agent.settings?.activeProvider ? agent.settings?.modeModels[agent.mode] : '') || provider?.model || ''
  const label = provider ? providerLabel(provider) : t('Provider')
  const effective = `${label} · ${agent.model || fallback || t('Default model')}`
  const options = [...models]
  for (const id of [agent.model, provider?.model || '']) {
    if (id && !options.includes(id)) options.push(id)
  }

  useEffect(() => {
    if (!activeProviderId || provider?.hasKey === false) {
      setModels([])
      setLoadedFor(activeProviderId)
      return
    }
    let cancelled = false
    setModels([])
    void window.codemap.agent.models(activeProviderId).then(
      (list) => {
        if (cancelled) return
        setModels(list)
        setLoadedFor(activeProviderId)
      },
      () => {
        if (cancelled) return
        setModels([])
        setLoadedFor('')
      }
    )
    return () => {
      cancelled = true
    }
  }, [activeProviderId, provider?.baseUrl, provider?.kind, provider?.hasKey])

  return (
    <div className="ag-pickers">
      <select
        className="input ag-provider"
        value={activeProviderId}
        aria-label={t('Provider')}
        title={effective}
        data-tooltip={effective}
        onChange={(event) => {
          const value = event.target.value
          if (value === '__settings__') setState({ settingsOpen: true })
          else void selectProvider(value)
        }}
      >
        {!activeProviderId ? <option value="">{t('Provider')}</option> : null}
        {providers.map((item) => (
          <option key={item.id} value={item.id}>
            {providerLabel(item)}
          </option>
        ))}
        <option value="__settings__">{t('Configure providers…')}</option>
      </select>
      <button type="button" className="icon-button icon-button--sm" aria-label={t('Configure providers…')} data-tooltip={t('Configure providers…')} onClick={() => setState({ settingsOpen: true })}>
        <Settings2 size={13} />
      </button>
      <select
        className="input ag-model"
        value={agent.model}
        aria-label={t('Model')}
        title={effective}
        data-tooltip={effective}
        onFocus={() => {
          if (loadedFor === activeProviderId || !activeProviderId || provider?.hasKey === false) return
          void window.codemap.agent.models(activeProviderId).then(
            (list) => {
              setModels(list)
              setLoadedFor(activeProviderId)
            },
            () => setLoadedFor('')
          )
        }}
        onChange={(event) => setModel(event.target.value)}
      >
        <option value="">{fallback ? t('Default ({model})', { model: fallback }) : t('Default model')}</option>
        {options.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
    </div>
  )
}

// Conversation text: headings, compact tables, lists, and fenced code stay readable
// apart from the proposal tray. Inline code that names a node opens it on the map.
function RichText({ text, onNode }: { text: string; onNode(id: string): void }) {
  return (
    <div className="ag-text">
      {renderBlocks(text, onNode)}
    </div>
  )
}

function renderBlocks(text: string, onNode: (id: string) => void): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    if (line.startsWith('```')) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++])
      if (i < lines.length) i++
      out.push(
        <pre key={key++} className="ag-code">
          {body.join('\n')}
        </pre>
      )
      continue
    }
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const rows = [splitRow(line)]
      i += 2
      while (i < lines.length && isTableRow(lines[i])) rows.push(splitRow(lines[i++]))
      out.push(
        <div key={key++} className="ag-table-wrap">
          <table className="ag-table">
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) =>
                    rowIndex === 0 ? <th key={cellIndex}>{inline(cell, onNode)}</th> : <td key={cellIndex}>{inline(cell, onNode)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }
    if (/^#{1,6}\s+/.test(line)) {
      const level = Math.min(line.match(/^#+/)?.[0].length ?? 3, 4)
      const Tag = ('h' + level) as 'h1' | 'h2' | 'h3' | 'h4'
      out.push(
        <Tag key={key++} className="ag-heading">
          {inline(line.replace(/^#+\s*/, ''), onNode)}
        </Tag>
      )
      i++
      continue
    }
    if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s/, ''))
      out.push(
        <ul key={key++}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{inline(item, onNode)}</li>
          ))}
        </ul>
      )
      continue
    }
    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) paragraph.push(lines[i++])
    out.push(
      <p key={key++}>
        {paragraph.map((item, itemIndex) => (
          <span key={itemIndex}>
            {itemIndex ? <br /> : null}
            {inline(item, onNode)}
          </span>
        ))}
      </p>
    )
  }
  return out
}

function isTableRow(line: string | undefined): boolean {
  return !!line && line.includes('|') && (line.trim().startsWith('|') || line.split('|').length > 2)
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
}

function isBlockStart(line: string, next: string | undefined): boolean {
  return line.startsWith('```') || /^#{1,6}\s+/.test(line) || /^\s*([-*]|\d+\.)\s/.test(line) || (isTableRow(line) && !!next && /^\s*\|?\s*:?-{3,}:?/.test(next))
}

function inline(line: string, onNode: (id: string) => void): ReactNode[] {
  const out: ReactNode[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(line))) {
    if (match.index > last) out.push(line.slice(last, match.index))
    if (match[1] !== undefined) {
      const id = match[1]
      const looksLikeNode = /^[A-Za-z0-9][\w-]*(\.[\w-]+)*$/.test(id) && !/\.(go|ts|js|py|yaml|md)$/.test(id)
      out.push(
        looksLikeNode ? (
          <button key={match.index} type="button" className="ag-node" onClick={() => onNode(id)}>
            {id}
          </button>
        ) : (
          <code key={match.index}>{id}</code>
        )
      )
    } else out.push(<b key={match.index}>{match[2]}</b>)
    last = match.index + match[0].length
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}
