import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import yaml from 'js-yaml'
import { stringify as toYaml } from 'yaml'
import type { AgentChangeSet, AgentEvent, AgentMessageView, AgentSessionInfo, AgentSessionSummary, AgentStartRequest } from '../../shared/agent'
import { isInside } from '../../shared/paths'
import type { CodemapAccess } from '../codemap/service'
import { callModel, type Block, type Message } from './providers'
import { rewriteNodeFile } from './rewrite'
import { systemPrompt } from './prompts'
import { rawAgentSettings, resolveProvider } from './settings'
import { checkChangeSet, readLibrary, runTool, toolLabel, toolsFor, type ToolEnv } from './tools'

// The built-in agent: one loop per run (model → tools → model …), sessions saved per library,
// change sets kept until the user applies or rejects them, and parallel sub-agents in create mode.

interface Session extends AgentSessionInfo {
  library: string
  /** Full conversation sent to the model. */
  history: Message[]
}

const sessions = new Map<string, Session>()
const running = new Map<string, AbortController>()

function sessionsDir(library: string): string {
  const key = createHash('sha1').update(library).digest('hex').slice(0, 16)
  return path.join(app.getPath('userData'), 'agent-sessions', key)
}

async function persist(s: Session): Promise<void> {
  const dir = sessionsDir(s.library)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${s.id}.json`), JSON.stringify(s), 'utf8')
}

export async function listSessions(library: string): Promise<AgentSessionSummary[]> {
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

export async function startRun(library: string, access: CodemapAccess, req: AgentStartRequest, emit: Emit): Promise<string> {
  if (!['ask', 'adjust', 'create', 'require'].includes(req.mode)) throw new Error(`Unknown mode ${req.mode}`)
  if (!req.message?.trim()) throw new Error('Empty message')
  let s: Session
  if (req.sessionId) {
    s = await loadSession(library, req.sessionId)
    if (running.has(s.id)) throw new Error('This conversation is still running')
  } else {
    s = { id: randomUUID(), library, mode: req.mode, title: makeTitle(req.message), updatedAt: Date.now(), messages: [], changeSets: [], history: [], gate: null }
    sessions.set(s.id, s)
  }
  s.mode = req.mode
  s.gate = null
  s.messages.push({ role: 'user', text: req.message, at: Date.now() })
  s.history.push({ role: 'user', content: [{ type: 'text', text: req.message }] })
  s.updatedAt = Date.now()
  await persist(s)
  emit({ type: 'session', sessionId: s.id, mode: s.mode, title: s.title })

  const runId = randomUUID()
  const controller = new AbortController()
  running.set(s.id, controller)
  void runLoop(s, access, req, runId, controller, emit).finally(() => {
    running.delete(s.id)
    void persist(s)
  })
  return s.id
}

async function runLoop(s: Session, access: CodemapAccess, req: AgentStartRequest, runId: string, controller: AbortController, emit: Emit): Promise<void> {
  const settings = await rawAgentSettings()
  const reply: AgentMessageView = { role: 'assistant', text: '', steps: [], at: Date.now() }
  s.messages.push(reply)
  let reason: 'end' | 'gate' | 'stopped' | 'limit' | 'error' = 'end'
  try {
    const { provider, key } = await resolveProvider()
    const model = req.model || settings.modeModels[s.mode] || provider.model
    if (!model) throw new Error(`No model chosen for ${provider.name}: pick one in Settings → AI`)
    const env = makeEnv(s, access, runId, emit, settings.maxParallel, provider, key, model, controller.signal, undefined, settings.maxTurns)
    const defs = toolsFor(s.mode)
    const system = await systemPrompt(s.library, s.mode, req.context)
    let turns = 0
    for (;;) {
      if (controller.signal.aborted) {
        reason = 'stopped'
        break
      }
      if (++turns > settings.maxTurns) {
        reason = 'limit'
        emit({ type: 'error', sessionId: s.id, runId, message: `Stopped after ${settings.maxTurns} model turns. Send a message to continue.` })
        break
      }
      const answer = await callModel(provider, key, { model, system, messages: s.history, tools: defs.map((d) => d.spec), signal: controller.signal })
      emit({ type: 'usage', sessionId: s.id, runId, input: answer.usage.input, output: answer.usage.output })
      s.history.push({ role: 'assistant', content: answer.blocks })
      for (const b of answer.blocks) {
        if (b.type !== 'text') continue
        reply.text += (reply.text ? '\n\n' : '') + b.text
        emit({ type: 'text', sessionId: s.id, runId, text: b.text })
      }
      const calls = answer.blocks.filter((b) => b.type === 'tool_use') as Array<Extract<Block, { type: 'tool_use' }>>
      if (!calls.length) break
      const results: Block[] = []
      for (const call of calls) {
        const label = toolLabel(defs, call.name, call.input)
        emit({ type: 'tool', sessionId: s.id, runId, callId: call.id, name: call.name, label })
        const step = { name: call.name, label, summary: undefined as string | undefined, ok: undefined as boolean | undefined }
        reply.steps!.push(step)
        const result = await runTool(defs, env, call.name, call.input)
        step.summary = result.summary
        step.ok = result.ok
        emit({ type: 'tool-result', sessionId: s.id, runId, callId: call.id, ok: result.ok, summary: result.summary })
        results.push({ type: 'tool_result', id: call.id, content: result.content, isError: !result.ok })
      }
      s.history.push({ role: 'user', content: results })
      s.updatedAt = Date.now()
      void persist(s)
      if (s.gate) {
        reason = 'gate'
        break
      }
    }
  } catch (error) {
    if (controller.signal.aborted) reason = 'stopped'
    else {
      reason = 'error'
      const message = error instanceof Error ? error.message : String(error)
      reply.text += (reply.text ? '\n\n' : '') + `⚠️ ${message}`
      emit({ type: 'error', sessionId: s.id, runId, message })
    }
    // Keep the history valid for the next message: a trailing assistant tool call needs results.
    const last = s.history[s.history.length - 1]
    if (last?.role === 'assistant' && last.content.some((b) => b.type === 'tool_use')) {
      s.history.push({ role: 'user', content: last.content.filter((b) => b.type === 'tool_use').map((b) => ({ type: 'tool_result', id: (b as { id: string }).id, content: 'Interrupted.', isError: true })) })
    }
  }
  s.updatedAt = Date.now()
  emit({ type: 'done', sessionId: s.id, runId, reason })
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
  scope?: string,
  maxTurns = 1000
): ToolEnv {
  return {
    library: s.library,
    access,
    mode: s.mode,
    focus: (map, nodes, flow, note) => emit({ type: 'focus', sessionId: s.id, runId, map, nodes, flow, note }),
    propose: (input) => {
      if (scope) {
        for (const rel of Object.keys(input.files)) {
          if (!isInside(path.join(s.library, scope), path.join(s.library, rel))) throw new Error(`Sub-agent for ${scope} may only write files under ${scope}/: ${rel}`)
        }
      }
      const set: AgentChangeSet = { ...input, id: randomUUID().slice(0, 8), sessionId: s.id, problems: checkChangeSet(s.library, input), status: 'proposed' }
      s.changeSets.push(set)
      emit({ type: 'changeset', sessionId: s.id, runId, changeSet: set })
      return set
    },
    gate: (stage, summary) => {
      s.gate = { stage, summary }
      emit({ type: 'gate', sessionId: s.id, runId, stage, summary })
    },
    delegate: scope
      ? undefined
      : async (tasks) => {
          const queue = [...tasks]
          const reports: string[] = []
          const worker = async () => {
            for (let t = queue.shift(); t; t = queue.shift()) {
              const workerId = randomUUID().slice(0, 6)
              emit({ type: 'worker', sessionId: s.id, runId, workerId, node: t.node, state: 'running' })
              try {
                const report = await runSubAgent(s, access, t.node, t.instructions, runId, emit, provider, key, model, signal, maxTurns)
                reports.push(`## ${t.node}\n${report}`)
                emit({ type: 'worker', sessionId: s.id, runId, workerId, node: t.node, state: 'done' })
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                reports.push(`## ${t.node}\nFailed: ${message}`)
                emit({ type: 'worker', sessionId: s.id, runId, workerId, node: t.node, state: 'failed', note: message })
              }
            }
          }
          await Promise.all(Array.from({ length: Math.min(maxParallel, tasks.length) }, worker))
          return reports.join('\n\n')
        }
  }
}

/** A sub-agent breaks one node down; it may only propose files inside that node's folder. */
async function runSubAgent(
  s: Session,
  access: CodemapAccess,
  node: string,
  instructions: string,
  runId: string,
  emit: Emit,
  provider: Awaited<ReturnType<typeof resolveProvider>>['provider'],
  key: string,
  model: string,
  signal: AbortSignal,
  maxTurns = 1000
): Promise<string> {
  const lib = readLibrary(s.library, true)
  const entry = lib.model.nodes.get(node)
  const scope = entry ? path.dirname(entry.file) : node.split('.').join('/')
  const env = makeEnv(s, access, runId, emit, 1, provider, key, model, signal, scope)
  const defs = toolsFor('create', false).filter((d) => d.spec.name !== 'review_gate')
  const system = await systemPrompt(s.library, 'create', { stack: [], selected: [node], flow: null }, `You are a sub-agent. Break down only node ${node}; put new files under ${scope}/. Finish with a short report: what you drew and what still needs checking.`)
  const history: Message[] = [{ role: 'user', content: [{ type: 'text', text: instructions }] }]
  let report = ''
  for (let turn = 0; turn < maxTurns && !signal.aborted; turn++) {
    const answer = await callModel(provider, key, { model, system, messages: history, tools: defs.map((d) => d.spec), signal })
    emit({ type: 'usage', sessionId: s.id, runId, input: answer.usage.input, output: answer.usage.output })
    history.push({ role: 'assistant', content: answer.blocks })
    report = answer.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n') || report
    const calls = answer.blocks.filter((b) => b.type === 'tool_use') as Array<Extract<Block, { type: 'tool_use' }>>
    if (!calls.length) break
    const results: Block[] = []
    for (const call of calls) {
      const result = await runTool(defs, env, call.name, call.input)
      results.push({ type: 'tool_result', id: call.id, content: result.content, isError: !result.ok })
    }
    history.push({ role: 'user', content: results })
  }
  return report || 'No report.'
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
