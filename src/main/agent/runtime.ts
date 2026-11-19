import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { stringify as toYaml } from 'yaml'
import type { AgentChangeSet, AgentContext, AgentEndReason, AgentEvent, AgentMessageView, AgentPhase, AgentSessionInfo, AgentSessionSummary, AgentStartRequest } from '../../shared/agent'
import { isInside } from '../../shared/paths'
import type { CodemapAccess } from '../codemap/service'
import { callModel, type Block, type Message } from './providers'
import { rewriteNodeFile } from './rewrite'
import { systemPrompt } from './prompts'
import { rawAgentSettings, resolveProvider } from './settings'
import { checkChangeSet, readLibrary, runTool, toolLabel, toolsFor, type ToolEnv } from './tools'
import { ensureElectronHost, userDataDir } from './hostAdapter'

// The built-in agent: one loop per run (model → tools → model …), sessions saved per library,
// change sets kept until the user applies or rejects them, and parallel sub-agents in create mode.

interface Session extends AgentSessionInfo {
  library: string
  /** Full conversation sent to the model. */
  history: Message[]
}

const sessions = new Map<string, Session>()
const running = new Map<string, AbortController>()
/** One write at a time per session, so parallel sub-agents cannot interleave the JSON. */
const persistQueues = new Map<string, Promise<void>>()

function sessionsDir(library: string): string {
  const key = createHash('sha1').update(library).digest('hex').slice(0, 16)
  return path.join(userDataDir(), 'agent-sessions', key)
}

async function persist(s: Session): Promise<void> {
  const previous = persistQueues.get(s.id) ?? Promise.resolve()
  const write = previous.catch(() => undefined).then(() => writeSession(s))
  const settled = write.then(
    () => undefined,
    () => undefined
  )
  persistQueues.set(s.id, settled)
  try {
    await write
  } finally {
    if (persistQueues.get(s.id) === settled) persistQueues.delete(s.id)
  }
}

async function writeSession(s: Session): Promise<void> {
  const dir = sessionsDir(s.library)
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, `${s.id}.json`)
  const temp = `${target}.tmp-${randomUUID().slice(0, 6)}`
  await writeFile(temp, JSON.stringify(s), 'utf8')
  await rename(temp, target)
}

export async function listSessions(library: string): Promise<AgentSessionSummary[]> {
  await ensureElectronHost()
  const dir = sessionsDir(library)
  const out: AgentSessionSummary[] = []
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue
    try {
      const s = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as Session
      out.push({ id: s.id, mode: s.mode, title: s.title, updatedAt: s.updatedAt })
    } catch {
      // skip a broken file
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

async function loadSession(library: string, id: string): Promise<Session> {
  const cached = sessions.get(id)
  if (cached) return cached
  await ensureElectronHost()
  const s = JSON.parse(await readFile(path.join(sessionsDir(library), `${id}.json`), 'utf8')) as Session
  if (s.library !== library) throw new Error('This conversation belongs to another node library')
  sessions.set(id, s)
  return s
}

export async function getSession(library: string, id: string): Promise<AgentSessionInfo> {
  const { history: _history, library: _library, ...view } = await loadSession(library, id)
  return view
}

export async function deleteSession(library: string, id: string): Promise<void> {
  await ensureElectronHost()
  running.get(id)?.abort()
  sessions.delete(id)
  await rm(path.join(sessionsDir(library), `${id}.json`), { force: true })
}

export function stopRun(sessionId: string): void {
  running.get(sessionId)?.abort()
}

// ---------- Running ----------

type Emit = (event: AgentEvent) => void

const TITLE_MAX = 40

function makeTitle(message: string): string {
  const line = message.trim().split('\n')[0]
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line || 'Conversation'
}

export async function startRun(library: string, access: CodemapAccess, req: AgentStartRequest, emit: Emit, extra?: { lsp?: ToolEnv['lsp'] }): Promise<string> {
  await ensureElectronHost()
  if (!['ask', 'adjust', 'create', 'require'].includes(req.mode)) throw new Error(`Unknown mode ${req.mode}`)
  if (!req.message?.trim()) throw new Error('Empty message')
  let s: Session
  if (req.sessionId) {
    s = await loadSession(library, req.sessionId)
    // A conversation belongs to the mode it was started in; another mode starts its own.
    if (s.mode !== req.mode) throw new Error(`This conversation belongs to the ${s.mode} mode; start a new conversation for ${req.mode}`)
    // A message sent while the run goes is queued and read by the run before its next model turn.
    if (running.has(s.id)) {
      s.messages.push({ role: 'user', text: req.message, at: Date.now() })
      ;(inbox.get(s.id) ?? inbox.set(s.id, []).get(s.id)!).push(req.message)
      void persist(s)
      return s.id
    }
  } else {
    s = { id: randomUUID(), library, mode: req.mode, title: makeTitle(req.message), updatedAt: Date.now(), messages: [], changeSets: [], history: [], gate: null }
    sessions.set(s.id, s)
  }
  s.gate = null
  // Build map: the repositories and knowledge are kept with the conversation.
  if (s.mode === 'create' && req.context.repos) s.sources = { repos: req.context.repos, docs: req.context.docs ?? [], output: req.context.output ?? '' }
  s.messages.push({ role: 'user', text: req.message, at: Date.now() })
  s.history.push({ role: 'user', content: [{ type: 'text', text: req.message }] })
  s.updatedAt = Date.now()
  await persist(s)
  emit({ type: 'session', sessionId: s.id, mode: s.mode, title: s.title })

  const runId = randomUUID()
  const controller = new AbortController()
  running.set(s.id, controller)
  void runLoop(s, access, req, runId, controller, emit, extra?.lsp).finally(() => {
    running.delete(s.id)
    inbox.delete(s.id)
    void persist(s)
  })
  return s.id
}

/** Messages the user sent while a run was going, waiting for the run's next turn. */
const inbox = new Map<string, string[]>()

const CUT_OFF =
  'Your last reply was cut off by the output limit, so any tool call in it was lost. Continue from where you stopped. If you were proposing a change set, split it: propose one or two files per propose_change_set call.'

interface LoopHooks {
  /** Called with every text block (main run: shown in the chat). */
  onText(text: string): void
  /** Wraps each tool call (main run: shown as steps). */
  onTool(name: string, label: string): (ok: boolean, summary: string) => void
  /** Messages to add before the next model turn (user messages typed while running). */
  pending?(): string[]
  /** Stop after this turn (a review gate was reached). */
  halt?(): boolean
  /** Asked when the model ends without a tool call: a nudge to keep going, or null to finish. */
  nudge?(): string | null
  /** After each turn (persist). */
  after?(): void
  /** Before each model call: what the run is doing and how many calls it made. */
  phase?(phase: AgentPhase, turn: number): void
}

/**
 * The model ↔ tools loop shared by the main run and sub-agents. No turn limit: it ends when the
 * model is done (no tool call and no nudge), at a review gate, or when stopped. A reply cut off
 * by the output limit is continued instead of being taken as the end.
 */
async function turnLoop(
  ctx: { provider: Awaited<ReturnType<typeof resolveProvider>>['provider']; key: string; model: string; system: string; signal: AbortSignal },
  history: Message[],
  defs: ReturnType<typeof toolsFor>,
  env: ToolEnv,
  emitUsage: (input: number, output: number) => void,
  hooks: LoopHooks
): Promise<'end' | 'gate' | 'stopped'> {
  let turn = 0
  let fixing = false
  for (;;) {
    if (ctx.signal.aborted) return 'stopped'
    hooks.phase?.(fixing ? 'fixing' : 'thinking', ++turn)
    const extra = hooks.pending?.() ?? []
    if (extra.length) {
      const last = history[history.length - 1]
      const blocks: Block[] = extra.map((text) => ({ type: 'text', text: `(Message from the user while you were working) ${text}` }))
      if (last?.role === 'user') last.content.push(...blocks)
      else history.push({ role: 'user', content: blocks })
    }
    let streamedInTurn = false
    const answer = await callModel(ctx.provider, ctx.key, {
      model: ctx.model,
      system: ctx.system,
      messages: compactHistory(history),
      tools: defs.map((d) => d.spec),
      signal: ctx.signal,
      onTextDelta: (delta) => {
        if (!delta) return
        streamedInTurn = true
        hooks.onText(delta)
      }
    })
    emitUsage(answer.usage.input, answer.usage.output)
    const cut = answer.stop === 'length'
    // A cut-off reply may end in a half-written tool call: keep only its text.
    const blocks = cut ? answer.blocks.filter((b) => b.type === 'text') : answer.blocks
    history.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '…' }] })
    // A live stream already delivered the text token by token. A JSON reply still arrives whole.
    if (!streamedInTurn) for (const b of blocks) if (b.type === 'text') hooks.onText(b.text)
    const calls = blocks.filter((b) => b.type === 'tool_use') as Array<Extract<Block, { type: 'tool_use' }>>
    if (!calls.length) {
      const next = cut ? CUT_OFF : (hooks.pending?.().length ? null : hooks.nudge?.() ?? null)
      if (next) {
        fixing = next !== CUT_OFF
        history.push({ role: 'user', content: [{ type: 'text', text: next }] })
        hooks.after?.()
        continue
      }
      // Messages typed during the last turn still get an answer.
      const late = hooks.pending?.() ?? []
      if (late.length) {
        history.push({ role: 'user', content: late.map((text) => ({ type: 'text', text })) })
        hooks.after?.()
        continue
      }
      return 'end'
    }
    fixing = false
    const results: Block[] = []
    for (const call of calls) {
      if (ctx.signal.aborted) return 'stopped'
      const done = hooks.onTool(call.name, toolLabel(defs, call.name, call.input))
      const result = await runTool(defs, env, call.name, call.input)
      done(result.ok, result.summary)
      results.push({ type: 'tool_result', id: call.id, content: result.content, isError: !result.ok })
    }
    history.push({ role: 'user', content: results })
    hooks.after?.()
    if (hooks.halt?.()) return 'gate'
  }
}

async function runLoop(s: Session, access: CodemapAccess, req: AgentStartRequest, runId: string, controller: AbortController, emit: Emit, lsp?: ToolEnv['lsp']): Promise<void> {
  const settings = await rawAgentSettings()
  const reply: AgentMessageView = { role: 'assistant', text: '', steps: [], at: Date.now() }
  s.messages.push(reply)
  let reason: AgentEndReason = 'end'
  try {
    const { provider, key } = await resolveProvider()
    const model = req.model || settings.modeModels[s.mode] || provider.model
    if (!model) throw new Error(`No model chosen for ${provider.name}: pick one in Settings → AI`)
    const runSets = new Set<string>()
    let fixNudges = 0
    const env = makeEnv(s, access, runId, emit, settings.maxParallel, provider, key, model, controller.signal, undefined, (id) => runSets.add(id), lsp)
    const defs = toolsFor(s.mode, true, { lsp: Boolean(lsp) })
    const system = await systemPrompt(s.library, s.mode, withSources(s, req.context))
    reason = await turnLoop({ provider, key, model, system, signal: controller.signal }, s.history, defs, env, (input, output) => emit({ type: 'usage', sessionId: s.id, runId, input, output }), {
      onText: (text) => {
        reply.text += (reply.text ? '\n\n' : '') + text
        emit({ type: 'text', sessionId: s.id, runId, text })
      },
      onTool: (name, label) => {
        const callId = randomUUID().slice(0, 8)
        emit({ type: 'tool', sessionId: s.id, runId, callId, name, label })
        const step = { name, label, summary: undefined as string | undefined, ok: undefined as boolean | undefined }
        reply.steps!.push(step)
        return (ok, summary) => {
          step.ok = ok
          step.summary = summary
          emit({ type: 'tool-result', sessionId: s.id, runId, callId, ok, summary })
        }
      },
      pending: () => takeInbox(s.id),
      halt: () => Boolean(s.gate),
      // Its own proposals from this run that still fail the checker: send it back to fix them.
      nudge: () => {
        const broken = s.changeSets.filter((c) => c.status === 'proposed' && runSets.has(c.id) && c.problems.some((p) => p.level === 'error'))
        if (!broken.length || fixNudges++ >= 20) return null
        return BROKEN(broken)
      },
      after: () => {
        s.updatedAt = Date.now()
        void persist(s)
      },
      phase: (phase, turn) => emit({ type: 'phase', sessionId: s.id, runId, phase, turn })
    })
  } catch (error) {
    if (controller.signal.aborted) reason = 'stopped'
    else {
      reason = 'error'
      const message = error instanceof Error ? error.message : String(error)
      reply.text += (reply.text ? '\n\n' : '') + `⚠️ ${message}`
      emit({ type: 'error', sessionId: s.id, runId, message })
    }
  }
  // Keep the history valid for the next message: a trailing assistant tool call needs results.
  const last = s.history[s.history.length - 1]
  if (last?.role === 'assistant' && last.content.some((b) => b.type === 'tool_use')) {
    s.history.push({ role: 'user', content: last.content.filter((b) => b.type === 'tool_use').map((b) => ({ type: 'tool_result', id: (b as { id: string }).id, content: 'Interrupted.', isError: true })) })
  }
  // Messages that arrived after the last turn: keep them in the history for the next run.
  const left = takeInbox(s.id)
  if (left.length) s.history.push({ role: 'user', content: left.map((text) => ({ type: 'text', text })) })
  // A stop or an error leaves steps that never finished: mark them so they do not spin forever.
  if (reason === 'stopped' || reason === 'error') for (const step of reply.steps ?? []) if (step.ok === undefined) step.stopped = true
  reply.end = reason
  s.updatedAt = Date.now()
  emit({ type: 'done', sessionId: s.id, runId, reason })
}

/** Build map: a continued conversation keeps working from the sources saved with it. */
function withSources(s: Session, context: AgentContext): AgentContext {
  if (s.mode !== 'create' || !s.sources) return context
  return { ...context, repos: s.sources.repos, docs: s.sources.docs, output: s.sources.output }
}

function takeInbox(id: string): string[] {
  const q = inbox.get(id)
  return q ? q.splice(0) : []
}

function makeEnv(
  s: Session,
  access: CodemapAccess,
  runId: string,
  emit: Emit,
  maxParallel: number,
  provider: Awaited<ReturnType<typeof resolveProvider>>['provider'],
  key: string,
  model: string,
  signal: AbortSignal,
  worker?: { scope: string; workerId: string; node: string; proposed: () => void },
  onProposed?: (id: string) => void,
  lsp?: ToolEnv['lsp']
): ToolEnv {
  const scope = worker?.scope
  return {
    library: s.library,
    access,
    mode: s.mode === 'create' || !worker ? s.mode : 'create',
    lsp,
    focus: (map, nodes, flow, note) => {
      // A sub-agent lights up nodes too, but does not move the map away from the main agent.
      if (worker) emit({ type: 'worker-step', sessionId: s.id, runId, workerId: worker.workerId, node: worker.node, label: note ?? '', lit: nodes, note: true })
      else emit({ type: 'focus', sessionId: s.id, runId, map, nodes, flow, note })
    },
    propose: (input, extend) => {
      if (scope) {
        for (const rel of Object.keys(input.files)) {
          if (!isInside(path.join(s.library, scope), path.join(s.library, rel))) throw new Error(`Sub-agent for ${scope} may only write files under ${scope}/: ${rel}`)
        }
      }
      let set: AgentChangeSet
      if (extend) {
        // Grow an earlier proposal: same id and card, checked again as a whole.
        const old = s.changeSets.find((c) => c.id === extend)
        if (!old) throw new Error(`No proposal ${extend} in this conversation`)
        if (old.status === 'applied') throw new Error(`Proposal ${extend} is already applied; make a new proposal for further changes`)
        const files = { ...old.files, ...input.files }
        const changes = [...old.changes, ...input.changes]
        // The card shows the latest description, not every revision appended.
        const summary = input.summary || old.summary
        if (old.status === 'rejected') {
          // The user rejected that version: carry its content into a fresh proposal instead of failing.
          set = { title: input.title || old.title, summary, files, changes, requirement: input.requirement ?? old.requirement, id: randomUUID().slice(0, 8), sessionId: s.id, problems: checkChangeSet(s.library, { files, changes }, peerProposals(s, old.id)), status: 'proposed', replaces: old.id }
          s.changeSets.push(set)
        } else {
          Object.assign(old, { files, changes, summary, problems: checkChangeSet(s.library, { files, changes }, peerProposals(s, old.id)) })
          set = old
        }
      } else {
        set = { ...input, id: randomUUID().slice(0, 8), sessionId: s.id, problems: checkChangeSet(s.library, input, peerProposals(s)), status: 'proposed' }
        s.changeSets.push(set)
      }
      emit({ type: 'changeset', sessionId: s.id, runId, changeSet: set })
      worker?.proposed()
      onProposed?.(set.id)
      return set
    },
    gate: (stage, summary) => {
      // The user reviews the architecture and the logic, never checker errors: those are fixed first.
      const broken = s.changeSets.filter((c) => c.status === 'proposed' && c.problems.some((p) => p.level === 'error'))
      if (broken.length) throw new Error(BROKEN(broken))
      s.gate = { stage, summary }
      emit({ type: 'gate', sessionId: s.id, runId, stage, summary })
    },
    delegate: worker
      ? undefined
      : async (tasks) => {
          const queue = [...tasks]
          const reports: string[] = []
          emit({ type: 'phase', sessionId: s.id, runId, phase: 'workers', turn: 0, label: String(tasks.length) })
          const run = async () => {
            for (let t = queue.shift(); t && !signal.aborted; t = queue.shift()) {
              const workerId = randomUUID().slice(0, 6)
              emit({ type: 'worker', sessionId: s.id, runId, workerId, node: t.node, state: 'running' })
              try {
                const report = await runSubAgent(s, access, t.node, t.instructions, runId, workerId, emit, provider, key, model, signal, lsp)
                reports.push(`## ${t.node}\n${report}`)
                emit({ type: 'worker', sessionId: s.id, runId, workerId, node: t.node, state: signal.aborted ? 'stopped' : 'done' })
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                reports.push(`## ${t.node}\nFailed: ${message}`)
                emit({ type: 'worker', sessionId: s.id, runId, workerId, node: t.node, state: signal.aborted ? 'stopped' : 'failed', note: signal.aborted ? undefined : message })
              }
            }
          }
          await Promise.all(Array.from({ length: Math.min(maxParallel, tasks.length) }, run))
          return reports.join('\n\n')
        }
  }
}

/** Sent back when the agent wants to stop while its proposal still fails the checker. */
const BROKEN = (sets: AgentChangeSet[]) =>
  [
    'Before you stop: these proposals still have checker errors. Go through all of them, then fix them together in one extend call per proposal (each error says how to fix it). If one cannot be fixed because the code really works that way, put the rule in the node ignore with the reason instead of guessing:',
    ...sets.map((c) => `- ${c.id} (${c.title}):\n` + c.problems.filter((p) => p.level === 'error').map((p) => `  error [${p.rule}] ${p.where}: ${p.msg}`).join('\n')),
    'Call propose_change_set with extend: <id> and the corrected files. Follow "画函数图（执行图）的规则" in the workflow for exec-entry / exec-dead-end / end-exit.'
  ].join('\n')


const SUB_AGENT = (node: string, scope: string) =>
  [
    `You are a sub-agent. Your only job: break down node ${node} into its own map, following "子 agent 做什么" in section E of the workflow. Sections A–D and review gates are the main agent's job, not yours.`,
    `Put every file under ${scope}/. Work with tools right away: read the code and the templates, then propose the files with propose_change_set (one or two files per call) and fix the checker problems it reports.`,
    'Do not stop to describe a plan or ask questions; nobody answers you. Finish only after your files are proposed, with a short report: what you drew, what is uncertain, what other modules or the parent map need to change.',
    "Write in the language of the task you were given (the instructions below)."
  ].join('\n')

/** A sub-agent breaks one node down; it may only propose files inside that node's folder. */
async function runSubAgent(
  s: Session,
  access: CodemapAccess,
  node: string,
  instructions: string,
  runId: string,
  workerId: string,
  emit: Emit,
  provider: Awaited<ReturnType<typeof resolveProvider>>['provider'],
  key: string,
  model: string,
  signal: AbortSignal,
  lsp?: ToolEnv['lsp']
): Promise<string> {
  const lib = readLibrary(s.library, true)
  const entry = lib.model.nodes.get(node)
  const scope = entry ? path.dirname(entry.file) : node.split('.').join('/')
  let proposed = 0
  const mine = new Set<string>()
  const env = makeEnv(s, access, runId, emit, 1, provider, key, model, signal, { scope, workerId, node, proposed: () => proposed++ }, (id) => mine.add(id), lsp)
  const defs = toolsFor('create', false, { lsp: Boolean(lsp) }).filter((d) => d.spec.name !== 'review_gate')
  const system = await systemPrompt(s.library, 'create', { stack: [], selected: [node], flow: null }, SUB_AGENT(node, scope))
  const history: Message[] = [{ role: 'user', content: [{ type: 'text', text: instructions }] }]
  let report = ''
  let nudges = 0
  const reason = await turnLoop({ provider, key, model, system, signal }, history, defs, env, (input, output) => emit({ type: 'usage', sessionId: s.id, runId, input, output }), {
    onText: (text) => {
      report = text
      emit({ type: 'worker-step', sessionId: s.id, runId, workerId, node, label: text.split('\n')[0].slice(0, 160), note: true })
    },
    onTool: (_name, label) => {
      emit({ type: 'worker-step', sessionId: s.id, runId, workerId, node, label })
      return (ok, summary) => emit({ type: 'worker-step', sessionId: s.id, runId, workerId, node, label, ok, summary })
    },
    // Ending with words only is not done: it has to propose its map first.
    nudge: () => {
      if (nudges++ >= 20) return null
      if (!proposed) return 'You have not proposed any file yet. Do the work now with tools: read the code you need, then call propose_change_set with the map for this node (one or two files per call). Do not describe a plan.'
      const broken = s.changeSets.filter((c) => c.status === 'proposed' && mine.has(c.id) && c.problems.some((p) => p.level === 'error'))
      return broken.length ? BROKEN(broken) : null
    },
    after: () => {
      s.updatedAt = Date.now()
      void persist(s)
    }
  })
  if (reason === 'stopped') return 'Stopped.'
  if (!proposed) return (report || 'No report.') + '\n(This sub-agent proposed no files.)'
  return report || 'No report.'
}

/** Other unapplied proposals in this session. The set being replaced is not one of its own peers. */
function peerProposals(s: Session, exceptId?: string): Array<Pick<AgentChangeSet, 'changes' | 'files'>> {
  return s.changeSets.filter((set) => set.status === 'proposed' && set.id !== exceptId).map((set) => ({ changes: set.changes, files: set.files }))
}

const COMPACT_AT = 140_000
const COMPACT_TOOL = 1200

/** Shrinks old tool output before a model call. The stored history is left unchanged. */
export function compactHistory(history: Message[]): Message[] {
  const size = history.reduce((sum, message) => sum + message.content.reduce((inner, block) => inner + ('text' in block ? block.text.length : 'content' in block ? block.content.length : JSON.stringify(block).length), 0), 0)
  const oversized = history.filter((message) => message.content.some((block) => block.type === 'tool_result' && block.content.length > COMPACT_TOOL)).length
  if ((size <= COMPACT_AT && oversized < 3) || history.length <= 6) return history
  const keep = history.length - 4
  return history.map((message, index) => {
    if (index >= keep) return message
    let changed = false
    const content = message.content.map((block) => {
      if (block.type !== 'tool_result' || block.content.length <= COMPACT_TOOL) return block
      changed = true
      return { ...block, content: block.content.slice(0, 600) + '\n... [earlier tool output compacted; call read tool again if needed]' }
    })
    return changed ? { ...message, content } : message
  })
}

function sanitizeProposalFiles(files: Record<string, string> | undefined): Record<string, string> {
  const clean: Record<string, string> = {}
  if (!files) return clean
  for (const [key, value] of Object.entries(files)) {
    const normalized = path.normalize(key).replace(/^[/\\]+/, '')
    if (!normalized || normalized.startsWith('..') || path.isAbsolute(key)) {
      throw new Error(`Refusing file path outside the library: ${key}`)
    }
    clean[normalized.split(path.sep).join('/')] = String(value)
  }
  return clean
}

/**
 * Registers a proposal made outside the chat (an MCP tool, for example) in its own session,
 * so the user can Apply or Reject it from the panel.
 */
export async function injectExternalProposal(
  library: string,
  proposal: Omit<AgentChangeSet, 'id' | 'sessionId' | 'problems' | 'status'>,
  emit?: (event: AgentEvent) => void
): Promise<{ sessionId: string; changeSet: AgentChangeSet }> {
  await ensureElectronHost()
  const cleanFiles = sanitizeProposalFiles(proposal.files)
  const normalizedProposal = { ...proposal, files: cleanFiles }
  const session: Session = {
    id: randomUUID(),
    library,
    mode: proposal.requirement ? 'require' : 'adjust',
    title: proposal.title || 'External proposal',
    updatedAt: Date.now(),
    messages: [],
    changeSets: [],
    history: [],
    gate: null
  }
  const changeSet: AgentChangeSet = {
    ...normalizedProposal,
    id: randomUUID().slice(0, 8),
    sessionId: session.id,
    problems: checkChangeSet(library, normalizedProposal),
    status: 'proposed'
  }
  session.changeSets.push(changeSet)
  sessions.set(session.id, session)
  await persist(session)
  emit?.({ type: 'session', sessionId: session.id, mode: session.mode, title: session.title })
  emit?.({ type: 'changeset', sessionId: session.id, runId: 'external', changeSet })
  return { sessionId: session.id, changeSet }
}

// ---------- Applying change sets ----------

function requirementYaml(set: AgentChangeSet): string {
  const req = set.requirement!
  return toYaml({ schema: 'codemap/v1', requirement: { id: req.id, name: req.name, status: 'designing', ...(req.desc ? { desc: req.desc } : {}) }, changes: set.changes }, { lineWidth: 0 })
}

/**
 * Writes an accepted change set. New files are written as given; base-map changes are merged
 * into the node files with the requirement engine, then written back; a require-mode set is
 * saved as requirements/<id>.yaml. Only files inside the open folder and the library are written.
 */
export async function applyChangeSet(library: string, root: string | null, sessionId: string, setId: string, beforeWrite?: (file: string) => void): Promise<string[]> {
  const s = await loadSession(library, sessionId)
  const set = s.changeSets.find((c) => c.id === setId)
  if (!set) throw new Error('No such change set')
  if (set.status !== 'proposed') throw new Error(`Change set is already ${set.status}`)
  if (!root || !isInside(root, library)) throw new Error('The node library is outside the open folder, so it cannot be edited')
  const written: string[] = []
  const write = async (rel: string, text: string) => {
    const target = path.resolve(library, rel)
    if (!isInside(library, target)) throw new Error(`Refusing to write outside the library: ${rel}`)
    await mkdir(path.dirname(target), { recursive: true })
    beforeWrite?.(target)
    await writeFile(target, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
    written.push(rel)
  }
  for (const [rel, text] of Object.entries(set.files)) await write(rel, text)
  if (set.requirement) {
    await write(path.join('requirements', `${set.requirement.id.replace(/[^\w-]/g, '-')}.yaml`), requirementYaml(set))
  } else if (set.changes.length) {
    const merged = await mergeIntoBase(library, set.changes)
    for (const [rel, text] of Object.entries(merged.files)) await write(rel, text)
    for (const rel of merged.removed) {
      const target = path.resolve(library, rel)
      if (!isInside(library, target)) continue
      beforeWrite?.(target)
      await rm(target, { force: true })
      written.push(`(removed) ${rel}`)
    }
  }
  set.status = 'applied'
  s.updatedAt = Date.now()
  await persist(s)
  return written
}

export async function rejectChangeSet(library: string, sessionId: string, setId: string): Promise<void> {
  const s = await loadSession(library, sessionId)
  const set = s.changeSets.find((c) => c.id === setId)
  if (!set) throw new Error('No such change set')
  set.status = 'rejected'
  await persist(s)
}

/** The edited object written into its existing file with comments kept; plain YAML if that fails. */
async function keepFormatting(file: string, next: Record<string, unknown>): Promise<string> {
  try {
    return rewriteNodeFile(await readFile(file, 'utf8'), next)
  } catch {
    return toYaml(next, { lineWidth: 0 })
  }
}

/** Applies requirement-style changes to the base library and returns the node files that changed. */
async function mergeIntoBase(library: string, changes: Record<string, unknown>[]): Promise<{ files: Record<string, string>; removed: string[] }> {
  const { loadLibrary } = await import('../codemap/loadLibrary.mjs')
  const { applyRequirement } = await import('../../shared/codemap/codemap.mjs')
  const loaded = loadLibrary(library)
  const applied = applyRequirement(loaded.docs, { file: '(change set)', requirement: { id: 'change-set' }, changes }, loaded.links)
  const errors = applied.problems.filter((p) => p.level === 'error')
  if (errors.length) throw new Error(`The change set does not apply: ${errors.map((e) => e.msg).join('; ')}`)
  // Files whose content changed: compare each node / link file before and after.
  const out: Record<string, string> = {}
  const nodeBefore = new Map(loaded.docs.map((d) => [d.file, yaml.dump(d.node)]))
  for (const d of applied.docs ?? []) {
    if (nodeBefore.get(d.file) === yaml.dump(d.node)) continue
    out[d.file] = await keepFormatting(path.join(library, d.file), d.node)
  }
  const linkBefore = new Map(loaded.links.map((l) => [l.file, yaml.dump(l.data)]))
  for (const l of applied.linkDocs ?? []) {
    // A link file the change set created is named after its owner: <owner folder>/links.yaml.
    let file = l.file
    if (!linkBefore.has(file)) {
      const owner = String((l.data as { owner?: string }).owner ?? '')
      const ownerFile = loaded.docs.find((d) => d.node.id === owner)?.file
      file = ownerFile ? path.join(path.dirname(ownerFile), 'links.yaml') : path.join('links', `${owner}.yaml`)
    }
    if (linkBefore.get(l.file) === yaml.dump(l.data)) continue
    out[file] = linkBefore.has(l.file) ? await keepFormatting(path.join(library, l.file), l.data as Record<string, unknown>) : toYaml(l.data, { lineWidth: 0 })
  }
  // Top-level node files the change set removed (remove: node on a file node).
  const after = new Set((applied.docs ?? []).map((d) => d.file))
  const removed = loaded.docs.map((d) => d.file).filter((f) => !after.has(f))
  return { files: out, removed }
}
