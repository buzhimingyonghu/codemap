import { useSyncExternalStore } from 'react'
import yaml from 'js-yaml'
import type { AgentChangeSet, AgentContext, AgentEvent, AgentMessageView, AgentMode, AgentSessionSummary, AgentSettings } from '@shared/agent'
import { t } from '../lib/i18n'
import { createLibrary, getCodeMap, reloadCodeMap, setNavigation, setPreview, previewId, type PreviewSet } from './codeMap'
import { notify, reportError } from './ui'

// The assistant panel's state: the open conversation, its live run, change sets, and the
// map following the agent (which map is open, which nodes are lit).

export interface WorkerView {
  id: string
  node: string
  state: 'running' | 'done' | 'failed'
  note?: string
}

export interface AgentState {
  mode: AgentMode
  sessionId: string | null
  title: string
  messages: AgentMessageView[]
  changeSets: AgentChangeSet[]
  running: boolean
  gate: { stage: string; summary: string } | null
  workers: WorkerView[]
  /** Nodes the agent pointed at last (lit on the map until the next message). */
  lit: string[]
  note: string | null
  usage: { input: number; output: number }
  sessions: AgentSessionSummary[]
  settings: AgentSettings | null
  /** Model override for the next run (empty: the mode's default). */
  model: string
  /** Repositories and knowledge picked for this conversation. */
  repos: string[]
  docs: SourceDoc[]
  /** Build map: folder inside the node library the new map goes into. */
  output: string
  version: number
}

export interface SourceDoc {
  kind: 'file' | 'url'
  value: string
}

const EMPTY: AgentState = {
  mode: 'ask',
  sessionId: null,
  title: '',
  messages: [],
  changeSets: [],
  running: false,
  gate: null,
  workers: [],
  lit: [],
  note: null,
  usage: { input: 0, output: 0 },
  sessions: [],
  settings: null,
  model: '',
  repos: [],
  docs: [],
  output: '',
  version: 0
}

let state: AgentState = { ...EMPTY, mode: (localStorage.getItem('agent.mode') as AgentMode) || 'ask' }
const listeners = new Set<() => void>()
const litListeners = new Set<(ids: string[]) => void>()

function update(next: Partial<AgentState>): void {
  state = { ...state, ...next, version: state.version + 1 }
  for (const l of [...listeners]) l()
  if ('lit' in next) for (const l of [...litListeners]) l(state.lit)
}

export function getAgent(): AgentState {
  return state
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useAgent(): AgentState {
  return useSyncExternalStore(subscribe, () => state)
}

/** The map stage subscribes to light up the nodes the agent points at. */
export function onAgentLit(listener: (ids: string[]) => void): () => void {
  litListeners.add(listener)
  return () => litListeners.delete(listener)
}

export function setMode(mode: AgentMode): void {
  localStorage.setItem('agent.mode', mode)
  update({ mode })
}

export function setModel(model: string): void {
  update({ model })
}

// ---------- Sources ----------

export async function addRepos(): Promise<void> {
  try {
    const picked = await window.codemap.agent.pickRepos()
    if (picked.length) update({ repos: [...new Set([...state.repos, ...picked])] })
  } catch (error) {
    reportError(error, t('Cannot add the repository'))
  }
}

export function removeRepo(path: string): void {
  update({ repos: state.repos.filter((r) => r !== path) })
}

export async function addLocalDocs(): Promise<void> {
  try {
    const picked = await window.codemap.agent.pickDocs()
    const docs = [...state.docs]
    for (const value of picked) if (!docs.some((d) => d.value === value)) docs.push({ kind: 'file', value })
    update({ docs })
  } catch (error) {
    reportError(error, t('Cannot add the document'))
  }
}

export function addLink(url: string): boolean {
  const value = url.trim()
  if (!/^https?:\/\/\S+$/.test(value)) return false
  if (!state.docs.some((d) => d.value === value)) update({ docs: [...state.docs, { kind: 'url', value }] })
  return true
}

export function removeDoc(value: string): void {
  update({ docs: state.docs.filter((d) => d.value !== value) })
}

export function setOutput(value: string): void {
  update({ output: value })
}

/** The folder name as typed, cleaned to a library-relative path (no leading slash, no ..). */
export function outputFolder(value = state.output): string {
  return value
    .trim()
    .split(/[\\/]+/)
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/')
}

export function clearLit(): void {
  if (state.lit.length || state.note) update({ lit: [], note: null })
}

function errorText(error: unknown): string {
  return '⚠️ ' + (error instanceof Error ? error.message : String(error))
}

// ---------- Sessions ----------

export async function refreshSessions(): Promise<void> {
  try {
    update({ sessions: await window.codemap.agent.sessions() })
  } catch {
    update({ sessions: [] })
  }
}

export function newSession(): void {
  if (state.running) return
  setPreview(null)
  update({ sessionId: null, title: '', messages: [], changeSets: [], gate: null, workers: [], lit: [], note: null, usage: { input: 0, output: 0 }, repos: [], docs: [], output: '' })
}

export async function openSession(id: string): Promise<void> {
  try {
    const s = await window.codemap.agent.session(id)
    setPreview(null)
    update({ sessionId: s.id, mode: s.mode, title: s.title, messages: s.messages, changeSets: s.changeSets, gate: s.gate ?? null, workers: [], lit: [], note: null, running: false })
  } catch (error) {
    reportError(error, t('Cannot open the conversation'))
  }
}

export async function deleteSession(id: string): Promise<void> {
  await window.codemap.agent.deleteSession(id)
  if (state.sessionId === id) newSession()
  await refreshSessions()
}

// ---------- Settings ----------

export async function loadAgentSettings(): Promise<AgentSettings | null> {
  try {
    const settings = await window.codemap.agent.settings()
    update({ settings })
    return settings
  } catch {
    return null
  }
}

// ---------- Sending ----------

function contextNow(selected: string[]): AgentContext {
  const map = getCodeMap()
  // Building a map starts from the picked repositories and knowledge, not from the open map's
  // selection; the other modes work on the open map and the selected nodes.
  const build = state.mode === 'create'
  if (build) return { stack: map.stack, selected: [], flow: null, repos: state.repos, docs: state.docs, output: outputFolder() }
  return { stack: map.stack, selected, flow: map.flowId }
}

export async function send(message: string, selected: string[] = []): Promise<void> {
  const text = message.trim()
  if (!text || state.running) return
  if (!getCodeMap().library) {
    // No node library yet: building a map asks where to keep it; the other modes need a map.
    if (state.mode !== 'create') {
      notify(t('Open or build a map first.'))
      return
    }
    await createLibrary()
    if (!getCodeMap().library) return
  }
  const assistant: AgentMessageView = { role: 'assistant', text: '', steps: [], at: Date.now() }
  update({ running: true, gate: null, workers: [], lit: [], note: null, messages: [...state.messages, { role: 'user', text, at: Date.now() }, assistant] })
  try {
    const sessionId = await window.codemap.agent.start({ mode: state.mode, message: text, context: contextNow(selected), sessionId: state.sessionId ?? undefined, model: state.model || undefined })
    if (!state.sessionId) update({ sessionId })
  } catch (error) {
    patchLast((m) => ({ ...m, text: errorText(error) }))
    update({ running: false })
  }
}

/** Create mode: approve the current review gate and let the agent go on. */
export function approveGate(): Promise<void> {
  return send(t('Approved. Continue with the next step.'))
}

export async function stop(): Promise<void> {
  if (state.sessionId) await window.codemap.agent.stop(state.sessionId)
}

function patchLast(fn: (m: AgentMessageView) => AgentMessageView): void {
  const messages = [...state.messages]
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      messages[i] = fn(messages[i])
      break
    }
  }
  update({ messages })
}

function joinText(a: string, b: string): string {
  return a ? a + '\n\n' + b : b
}

// ---------- Change sets ----------

function toPreview(set: AgentChangeSet): PreviewSet {
  const docs: PreviewSet['docs'] = []
  const links: PreviewSet['links'] = []
  for (const [file, text] of Object.entries(set.files)) {
    if (!/\.ya?ml$/.test(file)) continue
    try {
      const data = yaml.load(text) as Record<string, any> | null
      if (!data || typeof data !== 'object') continue
      if (data.owner && data.links) links.push({ file, data })
      else if (data.id) docs.push({ file, node: data })
    } catch {
      // the checker already reported the YAML error
    }
  }
  return { id: set.id, title: set.title, changes: set.changes, docs, links }
}

export function previewChangeSet(set: AgentChangeSet | null): void {
  setPreview(set ? toPreview(set) : null)
  update({})
}

export function previewing(): string | null {
  return previewId()
}

export async function applyChangeSet(set: AgentChangeSet): Promise<void> {
  if (!state.sessionId) return
  try {
    const files = await window.codemap.agent.applyChangeSet(state.sessionId, set.id)
    if (previewId() === set.id) setPreview(null)
    update({ changeSets: state.changeSets.map((c) => (c.id === set.id ? { ...c, status: 'applied' as const } : c)) })
    notify(t('Applied: {n} files written', { n: files.length }), 'success')
    await reloadCodeMap()
  } catch (error) {
    reportError(error, t('Cannot apply the change set'))
  }
}

export async function rejectChangeSet(set: AgentChangeSet): Promise<void> {
  if (!state.sessionId) return
  await window.codemap.agent.rejectChangeSet(state.sessionId, set.id)
  if (previewId() === set.id) setPreview(null)
  update({ changeSets: state.changeSets.map((c) => (c.id === set.id ? { ...c, status: 'rejected' as const } : c)) })
}

// ---------- Events ----------

function onEvent(event: AgentEvent): void {
  if (event.type === 'session') {
    if (!state.sessionId || state.sessionId === event.sessionId) update({ sessionId: event.sessionId, title: event.title })
    void refreshSessions()
    return
  }
  if (event.sessionId !== state.sessionId) return
  switch (event.type) {
    case 'text':
      patchLast((m) => ({ ...m, text: joinText(m.text, event.text) }))
      break
    case 'tool':
      patchLast((m) => ({ ...m, steps: [...(m.steps ?? []), { name: event.name, label: event.label }] }))
      break
    case 'tool-result':
      patchLast((m) => {
        const steps = [...(m.steps ?? [])]
        for (let i = steps.length - 1; i >= 0; i--) {
          if (steps[i].ok === undefined) {
            steps[i] = { ...steps[i], ok: event.ok, summary: event.summary }
            break
          }
        }
        return { ...m, steps }
      })
      break
    case 'focus':
      followMap(event.map, event.nodes, event.flow ?? null)
      update({ lit: event.nodes, note: event.note ?? null })
      break
    case 'changeset':
      update({ changeSets: [...state.changeSets.filter((c) => c.id !== event.changeSet.id), event.changeSet] })
      // The newest proposal shows on the map right away.
      previewChangeSet(event.changeSet)
      break
    case 'gate':
      update({ gate: { stage: event.stage, summary: event.summary } })
      break
    case 'worker': {
      const workers = state.workers.filter((w) => w.id !== event.workerId)
      update({ workers: [...workers, { id: event.workerId, node: event.node, state: event.state, note: event.note }] })
      if (event.state === 'running') update({ lit: [...new Set([...state.lit, event.node])] })
      break
    }
    case 'usage':
      update({ usage: { input: state.usage.input + event.input, output: state.usage.output + event.output } })
      break
    case 'error':
      patchLast((m) => ({ ...m, text: joinText(m.text, '⚠️ ' + event.message) }))
      break
    case 'done':
      update({ running: false })
      void refreshSessions()
      break
  }
}

/** Opens the map the agent is looking at, keeping the user's path when the map is on it. */
function followMap(map: string | null, nodes: string[], flow: string | null): void {
  const data = getCodeMap()
  if (!data.check) return
  const model = data.check.model
  const target = map ?? mapOf(nodes[0]) ?? null
  if (!target || !model.members.has(target)) return
  const i = data.stack.indexOf(target)
  const stack = i >= 0 ? data.stack.slice(0, i + 1) : pathTo(target)
  const sameMap = target === data.stack[data.stack.length - 1]
  setNavigation(stack, flow ?? (sameMap ? data.flowId : null), nodes[0] ?? null)
}

function mapOf(id: string | undefined): string | null {
  if (!id) return null
  const model = getCodeMap().check?.model
  if (!model) return null
  const up = [...(model.containedBy.get(id) ?? [])]
  if (up.length) return up[0]
  for (const [m, members] of model.members) if (members.includes(id)) return m
  return null
}

/** A path from a top-level map down to the map, so the breadcrumbs show where it is. */
function pathTo(id: string): string[] {
  const model = getCodeMap().check?.model
  if (!model) return [id]
  const out = [id]
  const seen = new Set([id])
  for (let cur = id; ; ) {
    const up = [...(model.containedBy.get(cur) ?? [])].find((p) => !seen.has(p) && !model.refs.get(p)?.has(cur))
    if (!up) break
    out.unshift(up)
    seen.add(up)
    cur = up
  }
  return out
}

let initialized = false

export function initAgent(): void {
  if (initialized) return
  initialized = true
  window.codemap.agent.onEvent(onEvent)
  void loadAgentSettings()
}
