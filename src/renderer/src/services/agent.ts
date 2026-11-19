import { useSyncExternalStore } from 'react'
import yaml from 'js-yaml'
import type { AgentChangeSet, AgentContext, AgentEndReason, AgentEvent, AgentMessageView, AgentMode, AgentPhase, AgentSessionInfo, AgentSessionSummary, AgentSettings, AgentStartRequest, AgentStepView, AgentUsageSummary, BuildLens, BuildTier } from '@shared/agent'
import { t } from '../lib/i18n'
import { createLibrary, getCodeMap, reloadCodeMap, setNavigation, setPreview, previewId, type PreviewSet } from './codeMap'
import { notify, reportError } from './ui'

// The assistant panel's state: the open conversation, its live run, change sets, and the
// map following the agent (which map is open, which nodes are lit).

export interface WorkerView {
  id: string
  node: string
  state: 'running' | 'done' | 'failed' | 'stopped'
  note?: string
  /** What it is doing: its tool steps and the lines it wrote, newest last. */
  steps: AgentStepView[]
}

export interface AgentState {
  mode: AgentMode
  sessionId: string | null
  title: string
  messages: AgentMessageView[]
  changeSets: AgentChangeSet[]
  running: boolean
  /** While running: what the run is doing, its model call count, and when it started. */
  progress: { phase: AgentPhase; turn: number; since: number; workers?: number } | null
  /** How the last run ended, until the next one starts. */
  ended: AgentEndReason | null
  gate: { stage: string; summary: string } | null
  workers: WorkerView[]
  /** Nodes the agent pointed at last (lit on the map until the next message). */
  lit: string[]
  /** Nodes it pointed at earlier in this answer: the path it took to get here. */
  trail: string[]
  note: string | null
  usage: AgentUsageSummary
  sessions: AgentSessionSummary[]
  settings: AgentSettings | null
  /** Provider override for the next run (empty: follow settings.activeProvider). */
  providerId: string
  /** Model override for the next run (empty: the mode's default). */
  model: string
  /** Build map speed/depth and the lens used to group the new map. */
  buildTier: BuildTier
  buildLens: BuildLens
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
  progress: null,
  ended: null,
  gate: null,
  workers: [],
  lit: [],
  trail: [],
  note: null,
  usage: emptyUsage(),
  sessions: [],
  settings: null,
  providerId: '',
  model: '',
  buildTier: 'balanced',
  buildLens: 'service',
  repos: [],
  docs: [],
  output: '',
  version: 0
}

function emptyUsage(): AgentUsageSummary {
  return { contextTokens: 0, totalInput: 0, totalOutput: 0, workerInput: 0, workerOutput: 0 }
}

function storedTier(): BuildTier {
  const value = localStorage.getItem('agent.buildTier')
  return value === 'fast' || value === 'balanced' || value === 'deep' ? value : 'balanced'
}

function storedLens(): BuildLens {
  const value = localStorage.getItem('agent.buildLens')
  return value === 'service' || value === 'business' || value === 'troubleshoot' ? value : 'service'
}

let state: AgentState = {
  ...EMPTY,
  mode: (localStorage.getItem('agent.mode') as AgentMode) || 'ask',
  providerId: localStorage.getItem('agent.providerId') || '',
  model: localStorage.getItem('agent.model') || '',
  buildTier: storedTier(),
  buildLens: storedLens()
}

// Each mode keeps its own conversation: switching modes goes back to that mode's last one.
const LAST_KEY = 'agent.lastSession'
function lastSessions(): Partial<Record<AgentMode, string>> {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}')
  } catch {
    return {}
  }
}
function rememberSession(mode: AgentMode, id: string | null): void {
  const all = lastSessions()
  if (id) all[mode] = id
  else delete all[mode]
  localStorage.setItem(LAST_KEY, JSON.stringify(all))
}
const listeners = new Set<() => void>()
export interface AgentMarks {
  lit: string[]
  trail: string[]
  note: string | null
}
const litListeners = new Set<(marks: AgentMarks) => void>()

function update(next: Partial<AgentState>): void {
  state = { ...state, ...next, version: state.version + 1 }
  for (const l of [...listeners]) l()
  if ('lit' in next || 'trail' in next || 'note' in next) for (const l of [...litListeners]) l(agentMarks())
}

export function agentMarks(): AgentMarks {
  return { lit: state.lit, trail: state.trail, note: state.note }
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
export function onAgentLit(listener: (marks: AgentMarks) => void): () => void {
  litListeners.add(listener)
  return () => litListeners.delete(listener)
}

export async function setMode(mode: AgentMode): Promise<void> {
  if (state.running || mode === state.mode) return
  localStorage.setItem('agent.mode', mode)
  const last = lastSessions()[mode]
  if (last && state.sessions.some((s) => s.id === last && s.mode === mode)) {
    if (await openSession(last)) return
  }
  clearSession(mode)
}

/** Opens the mode's last conversation when the panel first shows (after a restart too). */
export async function restoreSession(): Promise<void> {
  await refreshSessions()
  if (state.sessionId || state.running) return
  const last = lastSessions()[state.mode]
  if (last && state.sessions.some((s) => s.id === last && s.mode === state.mode)) await openSession(last)
}

export function setModel(model: string): void {
  if (model) localStorage.setItem('agent.model', model)
  else localStorage.removeItem('agent.model')
  update({ model })
}

export function setBuildTier(tier: BuildTier): void {
  localStorage.setItem('agent.buildTier', tier)
  update({ buildTier: tier })
}

export function setBuildLens(lens: BuildLens): void {
  localStorage.setItem('agent.buildLens', lens)
  update({ buildLens: lens })
}

/** Switches the chat-bar provider and clears a model chosen for the previous one. */
export async function selectProvider(providerId: string, options?: { keepModel?: boolean }): Promise<void> {
  localStorage.setItem('agent.providerId', providerId)
  if (!options?.keepModel) localStorage.removeItem('agent.model')
  update(options?.keepModel ? { providerId } : { providerId, model: '' })
  const settings = state.settings
  if (!settings || !providerId || !settings.providers.some((provider) => provider.id === providerId)) return
  if (settings.activeProvider === providerId) return
  try {
    const saved = await window.codemap.agent.saveSettings({ ...settings, activeProvider: providerId })
    update({ settings: saved })
  } catch (error) {
    reportError(error, t('Cannot save AI settings'))
  }
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
  if (state.lit.length || state.trail.length || state.note) update({ lit: [], trail: [], note: null })
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

function clearSession(mode: AgentMode): void {
  setPreview(null)
  update({ mode, sessionId: null, title: '', messages: [], changeSets: [], gate: null, workers: [], lit: [], trail: [], note: null, usage: emptyUsage(), repos: [], docs: [], output: '', progress: null, ended: null })
}

export function newSession(): void {
  if (state.running) return
  rememberSession(state.mode, null)
  clearSession(state.mode)
}

/** Opens a saved conversation in its own mode, with the sources it was built from. */
export async function openSession(id: string): Promise<boolean> {
  if (state.running) return false
  try {
    const s: AgentSessionInfo = await window.codemap.agent.session(id)
    setPreview(null)
    localStorage.setItem('agent.mode', s.mode)
    rememberSession(s.mode, s.id)
    const lastReply = [...s.messages].reverse().find((m) => m.role === 'assistant')
    if (s.sources?.buildTier) localStorage.setItem('agent.buildTier', s.sources.buildTier)
    if (s.sources?.buildLens) localStorage.setItem('agent.buildLens', s.sources.buildLens)
    update({
      sessionId: s.id,
      mode: s.mode,
      title: s.title,
      messages: s.messages,
      changeSets: s.changeSets,
      gate: s.gate ?? null,
      workers: [],
      lit: [],
      trail: [],
      note: null,
      running: false,
      progress: null,
      ended: lastReply?.end ?? null,
      usage: s.usage ?? emptyUsage(),
      buildTier: s.sources?.buildTier ?? state.buildTier,
      buildLens: s.sources?.buildLens ?? state.buildLens,
      repos: s.sources?.repos ?? [],
      docs: s.sources?.docs ?? [],
      output: s.sources?.output ?? ''
    })
    return true
  } catch (error) {
    reportError(error, t('Cannot open the conversation'))
    return false
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
    const providerId = state.providerId && settings.providers.some((provider) => provider.id === state.providerId) ? state.providerId : ''
    if (providerId !== state.providerId) localStorage.setItem('agent.providerId', providerId)
    update({ settings, providerId })
    return settings
  } catch {
    return null
  }
}

function startRequest(message: string, selected: string[]): AgentStartRequest {
  return {
    mode: state.mode,
    message,
    context: contextNow(selected),
    sessionId: state.sessionId ?? undefined,
    model: state.model || undefined,
    providerId: state.providerId || state.settings?.activeProvider || undefined
  }
}

// ---------- Sending ----------

function contextNow(selected: string[]): AgentContext {
  const map = getCodeMap()
  // Building a map starts from the picked repositories and knowledge, not from the open map's
  // selection; the other modes work on the open map and the selected nodes.
  const build = state.mode === 'create'
  if (build) return { stack: map.stack, selected: [], flow: null, repos: state.repos, docs: state.docs, output: outputFolder(), buildTier: state.buildTier, buildLens: state.buildLens }
  return { stack: map.stack, selected, flow: map.flowId }
}

export async function send(message: string, selected: string[] = []): Promise<void> {
  const text = message.trim()
  if (!text) return
  if (state.running && state.sessionId) {
    // While the agent works the message is queued; the run reads it before its next step.
    const at = state.messages.length - 1
    const messages = [...state.messages]
    messages.splice(at, 0, { role: 'user', text, at: Date.now() })
    update({ messages })
    try {
      await window.codemap.agent.start(startRequest(text, selected))
    } catch (error) {
      reportError(error, t('Cannot send the message'))
    }
    return
  }
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
  const mode = state.mode
  update({
    running: true,
    progress: { phase: 'thinking', turn: 0, since: Date.now() },
    ended: null,
    gate: null,
    workers: [],
    lit: [],
    trail: [],
    note: null,
    messages: [...state.messages, { role: 'user', text, at: Date.now() }, assistant]
  })
  try {
    const sessionId = await window.codemap.agent.start({ ...startRequest(text, selected), mode })
    if (!state.sessionId) update({ sessionId })
    rememberSession(mode, sessionId)
  } catch (error) {
    patchLast((m) => ({ ...m, text: errorText(error), end: 'error' }))
    update({ running: false, progress: null, ended: 'error' })
  }
}

/** Create mode: approve the current review gate and let the agent go on. */
export function approveGate(): Promise<void> {
  return send(t('Approved. Continue with the next step.'))
}

/** Adjust mode: ask for a child map of one node, switching mode first when needed. */
export async function drillDownNode(nodeId: string): Promise<void> {
  if (state.running || !nodeId) return
  if (state.mode !== 'adjust') await setMode('adjust')
  if (state.running || state.mode !== 'adjust') return
  const shortId = nodeId.split('.').pop() || nodeId
  await send(t('Break down node `{id}` into its child map based on the source code: cover all entrypoints, branches, storage/RPC calls, flows (refining parent flows), links.yaml, and docs/{shortId}.md.', { id: nodeId, shortId }), [nodeId])
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

function dropChangeSet(id: string): AgentChangeSet[] {
  return state.changeSets.filter((c) => c.id !== id).map((c) => (c.replaces === id ? { ...c, replaces: undefined } : c))
}

function isStaleDraft(set: AgentChangeSet): boolean {
  return set.status !== 'applied' && (set.status === 'rejected' || set.problems.some((problem) => problem.level === 'error'))
}

/** Removes one unapplied draft from the conversation. Applied history cannot be discarded. */
export async function discardChangeSet(set: AgentChangeSet): Promise<boolean> {
  if (set.status === 'applied' || !state.sessionId) return false
  const result = await window.codemap.app.confirm({
    message: t('Discard draft “{title}” (#{id})?', { title: set.title, id: set.id }),
    detail: t('This only removes the unapplied draft. Files already written to the node library will not be changed.'),
    buttons: [t('Discard'), t('Cancel')],
    cancelId: 1
  })
  if (result !== 0) return false
  try {
    await window.codemap.agent.discardChangeSet(state.sessionId, set.id)
  } catch (error) {
    reportError(error, t('Cannot discard the draft'))
    return false
  }
  if (previewId() === set.id) setPreview(null)
  update({ changeSets: dropChangeSet(set.id) })
  notify(t('Draft discarded'))
  return true
}

/** Confirms, then permanently removes rejected drafts and proposals that still have checker errors. */
export async function discardStaleDrafts(): Promise<void> {
  if (!state.sessionId) return
  const sessionId = state.sessionId
  const stale = state.changeSets.filter(isStaleDraft)
  if (!stale.length) return
  const result = await window.codemap.app.confirm({
    message: t('Discard {n} unapplied stale drafts?', { n: stale.length }),
    detail: t('This only removes the unapplied draft. Files already written to the node library will not be changed.'),
    buttons: [t('Discard'), t('Cancel')],
    cancelId: 1
  })
  if (result !== 0) return
  let removed = 0
  for (const set of stale) {
    try {
      await window.codemap.agent.discardChangeSet(sessionId, set.id)
    } catch (error) {
      reportError(error, t('Cannot discard the draft'))
      continue
    }
    if (previewId() === set.id) setPreview(null)
    update({ changeSets: dropChangeSet(set.id) })
    removed++
  }
  if (removed) notify(t('Discarded {n} drafts', { n: removed }))
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
      patchLast((m) => ({ ...m, text: event.append ? m.text + event.text : joinText(m.text, event.text) }))
      break
    case 'tool':
      patchLast((m) => ({ ...m, steps: [...(m.steps ?? []), { name: event.name, label: event.label }] }))
      if (state.progress && state.progress.phase !== 'workers') update({ progress: { ...state.progress, phase: 'tools' } })
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
      // What was lit before stays as a faint trail, so the path down the levels shows.
      update({ lit: event.nodes, trail: [...new Set([...state.trail, ...state.lit])].filter((id) => !event.nodes.includes(id)), note: event.note ?? null })
      break
    case 'changeset':
      update({ changeSets: [...state.changeSets.filter((c) => c.id !== event.changeSet.id), event.changeSet] })
      // The newest proposal shows on the map right away.
      previewChangeSet(event.changeSet)
      break
    case 'changeset-discarded':
      if (previewId() === event.changeSetId) setPreview(null)
      update({ changeSets: dropChangeSet(event.changeSetId) })
      break
    case 'gate':
      update({ gate: { stage: event.stage, summary: event.summary } })
      break
    case 'worker': {
      const old = state.workers.find((w) => w.id === event.workerId)
      const view: WorkerView = { id: event.workerId, node: event.node, state: event.state, note: event.note, steps: old?.steps ?? [] }
      update({ workers: old ? state.workers.map((w) => (w.id === event.workerId ? view : w)) : [...state.workers, view] })
      if (event.state === 'running') update({ lit: [...new Set([...state.lit, event.node])] })
      break
    }
    case 'worker-step': {
      const workers = state.workers.map((w) => {
        if (w.id !== event.workerId) return w
        const steps = [...w.steps]
        if (event.ok !== undefined) {
          // The result of the last step with this label that has not finished yet.
          for (let i = steps.length - 1; i >= 0; i--) {
            if (steps[i].ok === undefined && steps[i].label === event.label) {
              steps[i] = { ...steps[i], ok: event.ok, summary: event.summary }
              break
            }
          }
        } else if (event.label) steps.push(event.note ? { name: 'note', label: event.label, ok: true } : { name: 'step', label: event.label })
        return { ...w, steps }
      })
      update({ workers })
      if (event.lit?.length) update({ lit: [...new Set([...state.lit, ...event.lit])] })
      break
    }
    case 'usage':
      if (event.isWorker) {
        update({
          usage: {
            ...state.usage,
            workerInput: (state.usage.workerInput ?? 0) + event.input,
            workerOutput: (state.usage.workerOutput ?? 0) + event.output,
            contextTokens: event.contextTokens ?? state.usage.contextTokens
          }
        })
      } else {
        update({
          usage: {
            ...state.usage,
            contextTokens: event.contextTokens ?? event.input,
            totalInput: state.usage.totalInput + event.input,
            totalOutput: state.usage.totalOutput + event.output
          }
        })
      }
      break
    case 'phase': {
      const since = state.progress?.since ?? Date.now()
      if (event.phase === 'workers') update({ progress: { phase: 'workers', turn: state.progress?.turn ?? 0, since, workers: Number(event.label) || state.workers.length } })
      else update({ progress: { phase: event.phase, turn: event.turn, since } })
      break
    }
    case 'error':
      patchLast((m) => ({ ...m, text: joinText(m.text, '⚠️ ' + event.message) }))
      break
    case 'done': {
      const reason = event.reason
      const cut = reason === 'stopped' || reason === 'error'
      patchLast((m) => ({ ...m, end: reason, steps: cut ? m.steps?.map((s) => (s.ok === undefined ? { ...s, stopped: true } : s)) : m.steps }))
      const workers = cut ? state.workers.map((w) => (w.state === 'running' ? { ...w, state: 'stopped' as const, steps: w.steps.map((s) => (s.ok === undefined ? { ...s, stopped: true } : s)) } : w)) : state.workers
      update({ running: false, progress: null, ended: reason, workers })
      void refreshSessions()
      break
    }
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
