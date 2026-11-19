import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AgentProvider, ProviderKind } from '../../shared/agent'

// Talks to model providers. Two wire formats cover everything we need:
//   anthropic  POST {base}/v1/messages           (Claude, and Claude-compatible gateways)
//   openai     POST {base}/chat/completions      (OpenAI-compatible services and gateways)
// Both are mapped onto one neutral message / tool-call shape so the agent loop does not care.

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema of the input object. */
  schema: Record<string, unknown>
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean }

export interface Message {
  role: 'user' | 'assistant'
  content: Block[]
}

export interface ModelReply {
  blocks: Block[]
  stop: 'end' | 'tool' | 'length' | 'other'
  usage: { input: number; output: number }
}

export interface ModelRequest {
  model: string
  system: string
  messages: Message[]
  tools: ToolSpec[]
  maxTokens?: number
  signal?: AbortSignal
  /** When set, the request asks for SSE and reports text as it arrives. */
  onTextDelta?: (delta: string) => void
}

// ---------- Local gateway ----------
// Reuses a model gateway already set up for Claude Code (~/.claude/settings.json:
// ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN) or Codex (~/.codex/config.toml: the active
// model_provider's base_url, bearer token, and wire_api). We read it on demand; the token is
// never stored by us or sent to the renderer.

export interface LocalGateway {
  kind: ProviderKind
  source: 'claude' | 'codex'
  baseUrl: string
  token: string
  model: string
  /** Claude alias models that the gateway accepts even when /v1/models omits them. */
  extraModels?: string[]
}

export const LOCAL_GATEWAY_ID = 'local-gateway'
export const LOCAL_CLAUDE_ID = 'local-gateway'
export const LOCAL_CODEX_ID = 'local-codex'

export async function localGateways(home = homedir()): Promise<{ claude: LocalGateway | null; codex: LocalGateway | null }> {
  return { claude: await readClaudeGateway(home), codex: await readCodexGateway(home) }
}

/** Prefers Claude, then Codex. Kept for callers that still want one gateway. */
export async function localGateway(home = homedir()): Promise<LocalGateway | null> {
  const gateways = await localGateways(home)
  return gateways.claude ?? gateways.codex
}

async function readClaudeGateway(home: string): Promise<LocalGateway | null> {
  try {
    const settings = JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8'))
    const env = settings?.env ?? {}
    if (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL) {
      const extraModels = uniqueStrings([
        env.ANTHROPIC_MODEL,
        env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        env.ANTHROPIC_DEFAULT_OPUS_MODEL,
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL
      ])
      return {
        kind: 'anthropic',
        source: 'claude',
        baseUrl: env.ANTHROPIC_BASE_URL,
        token: env.ANTHROPIC_AUTH_TOKEN,
        model: extraModels[0] ?? '',
        ...(extraModels.length ? { extraModels } : {})
      }
    }
  } catch {
    // Claude Code is not configured
  }
  return null
}

async function readCodexGateway(home: string): Promise<LocalGateway | null> {
  try {
    const toml = await readFile(path.join(home, '.codex', 'config.toml'), 'utf8')
    const preamble = toml.split(/\n\[/)[0] ?? ''
    const model = quotedValue(preamble, 'model') ?? ''
    const named = quotedValue(preamble, 'model_provider')
    const blocks = codexProviderBlocks(toml)
    const chosen = chooseCodexBlock(blocks, named)
    const blockUrl = chosen ? quotedValue(chosen.body, 'base_url') : undefined
    const baseUrl = blockUrl || normalizeCodexBase(quotedValue(preamble, 'openai_base_url'))
    if (!baseUrl) return null
    const token = (chosen ? codexToken(chosen.body) : '') || (await codexAuthToken(home)) || loopbackToken(baseUrl)
    if (!token) return null
    const wireApi = chosen ? quotedValue(chosen.body, 'wire_api') : undefined
    return { kind: wireApi === 'anthropic' ? 'anthropic' : 'openai', source: 'codex', baseUrl, token, model }
  } catch {
    // not installed
  }
  return null
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) seen.add(trimmed)
  }
  return [...seen]
}

function quotedValue(text: string, key: string): string | undefined {
  const match = new RegExp('(?:^|\\n)\\s*' + key + '\\s*=\\s*"([^"]*)"').exec(text)
  const value = match?.[1]?.trim()
  return value || undefined
}

interface CodexBlock {
  id: string
  body: string
}

function codexProviderBlocks(toml: string): CodexBlock[] {
  const blocks: CodexBlock[] = []
  const source = toml.startsWith('[') ? '\n' + toml : toml
  const pattern = /(^|\n)\[model_providers\.([^\].]+)\][^\n]*/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    const start = match.index + match[0].length
    const rest = source.slice(start)
    const next = rest.search(/\n\[/)
    blocks.push({ id: match[2], body: next < 0 ? rest : rest.slice(0, next) })
  }
  return blocks
}

function chooseCodexBlock(blocks: CodexBlock[], named: string | undefined): CodexBlock | undefined {
  if (named) {
    const exact = blocks.find((block) => block.id === named)
    if (exact) return exact
  }
  for (const id of ['magpie', 'custom', 'tencent_codebuddy']) {
    const found = blocks.find((block) => block.id === id && quotedValue(block.body, 'base_url'))
    if (found) return found
  }
  return blocks.find((block) => quotedValue(block.body, 'base_url'))
}

function normalizeCodexBase(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.replace(/\/+$/, '')
  if (/\/backend-api\/codex$/.test(trimmed)) {
    try {
      return new URL(trimmed).origin + '/v1'
    } catch {
      return trimmed.replace(/\/backend-api\/codex$/, '/v1')
    }
  }
  return trimmed
}

function codexToken(block: string): string {
  const bearer = quotedValue(block, 'experimental_bearer_token')
  if (bearer) return bearer
  const envKey = /env_key\s*=\s*"([^"]+)"/.exec(block)?.[1]
  return envKey ? (process.env[envKey] ?? '') : ''
}

async function codexAuthToken(home: string): Promise<string> {
  try {
    const auth = JSON.parse(await readFile(path.join(home, '.codex', 'auth.json'), 'utf8')) as { OPENAI_API_KEY?: unknown }
    return typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY.trim() : ''
  } catch {
    return ''
  }
}

function loopbackToken(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' ? 'local-gateway' : ''
  } catch {
    return /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/.test(baseUrl) ? 'local-gateway' : ''
  }
}

export function defaultProviders(): AgentProvider[] {
  return [
    { id: LOCAL_CLAUDE_ID, name: 'Claude Code Gateway', kind: 'anthropic', baseUrl: '', keySource: 'local', localSource: 'claude', model: '' },
    { id: LOCAL_CODEX_ID, name: 'Codex / Magpie Gateway', kind: 'openai', baseUrl: '', keySource: 'local', localSource: 'codex', model: '' }
  ]
}

// ---------- Requests ----------

const TIMEOUT_MS = 10 * 60 * 1000

export class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`Model request failed (${status}): ${body.slice(0, 400)}`)
  }
}

interface ModelResponse {
  json: any
  streamed: boolean
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal | undefined, onEvent?: (event: string, data: string) => void): Promise<ModelResponse> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!response.ok) throw new ModelHttpError(response.status, await response.text())
  const type = response.headers.get('content-type') ?? ''
  if (type.includes('text/event-stream')) return { json: await readSSE(response, onEvent ?? (() => undefined)), streamed: true }
  const text = await response.text()
  try {
    return { json: JSON.parse(text), streamed: false }
  } catch {
    throw new Error(`Model returned something that is not JSON: ${text.slice(0, 200)}`)
  }
}

/** Reads an SSE body and returns the assembled JSON events in order. */
async function readSSE(response: Response, onEvent: (event: string, data: string) => void): Promise<Array<{ event: string; data: any }>> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Model stream has no body')
  let buffer = ''
  const events: Array<{ event: string; data: any }> = []
  const flush = (raw: string) => {
    let event = 'message'
    const data: string[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
      if (!trimmed || trimmed.startsWith(':')) continue
      if (trimmed.startsWith('event:')) event = trimmed.slice(6).trim()
      else if (trimmed.startsWith('data:')) data.push(trimmed.slice(5).replace(/^ /, ''))
    }
    if (!data.length) return
    const payload = data.join('\n')
    if (payload === '[DONE]') {
      events.push({ event: 'done', data: '[DONE]' })
      return
    }
    let parsed: any = payload
    try {
      parsed = JSON.parse(payload)
    } catch {
      // keep the raw payload; the caller decides whether it is usable
    }
    onEvent(event, payload)
    events.push({ event, data: parsed })
  }
  const sep = '\n\n'
  for (;;) {
    const { value, done } = await reader.read()
    buffer += decodeChunk(value)
    const parts = buffer.split(sep)
    buffer = parts.pop() ?? ''
    for (const part of parts) flush(part)
    if (done) break
  }
  if (buffer.trim()) flush(buffer)
  return events
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, '')
}

function decodeChunk(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value))
  return String(value)
}

async function callAnthropic(p: AgentProvider, key: string, req: ModelRequest): Promise<ModelReply> {
  const base = trimBase(p.baseUrl).replace(/\/v1$/, '')
  const messages = req.messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) =>
      b.type === 'text'
        ? { type: 'text', text: b.text }
        : b.type === 'tool_use'
          ? { type: 'tool_use', id: b.id, name: b.name, input: b.input }
          : { type: 'tool_result', tool_use_id: b.id, content: b.content, ...(b.isError ? { is_error: true } : {}) }
    )
  }))
  const streaming = Boolean(req.onTextDelta)
  const blocks: Block[] = []
  const tools = new Map<number, { id: string; name: string; json: string }>()
  let stop: ModelReply['stop'] = 'other'
  let usage = { input: 0, output: 0 }
  const take = (data: any) => {
    if (data?.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
      tools.set(data.index ?? tools.size, { id: data.content_block.id ?? '', name: data.content_block.name ?? '', json: '' })
    } else if (data?.type === 'content_block_delta') {
      if (data.delta?.type === 'text_delta' && data.delta.text && req.onTextDelta) req.onTextDelta(data.delta.text)
      if (data.delta?.type === 'input_json_delta' && data.delta.partial_json) {
        const tool = tools.get(data.index ?? 0)
        if (tool) tool.json += data.delta.partial_json
      }
    } else if (data?.type === 'message_delta') {
      stop = anthropicStop(data.delta?.stop_reason)
      usage.output = data.usage?.output_tokens ?? usage.output
    } else if (data?.type === 'message_start') {
      usage.input = data.message?.usage?.input_tokens ?? usage.input
    }
  }
  const { json, streamed } = await post(
    `${base}/v1/messages`,
    { 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
    {
      model: req.model,
      max_tokens: req.maxTokens ?? OUTPUT_TOKENS[0],
      system: req.system,
      messages,
      ...(streaming ? { stream: true } : {}),
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }))
    },
    req.signal,
    (_event, payload) => {
      try {
        take(JSON.parse(payload))
      } catch {
        // ignore a partial frame
      }
    }
  )
  if (!streamed) {
    for (const c of json.content ?? []) {
      if (c.type === 'text' && c.text) blocks.push({ type: 'text', text: c.text })
      else if (c.type === 'tool_use') blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} })
    }
    stop = anthropicStop(json.stop_reason)
    usage = { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 }
  } else {
    let text = ''
    for (const event of json as Array<{ data: any }>) {
      const data = event.data
      if (data?.type === 'content_block_start' && data.content_block?.type === 'text') text = data.content_block.text ?? ''
      else if (data?.type === 'content_block_delta' && data.delta?.type === 'text_delta') text += data.delta.text ?? ''
      else if (data?.type === 'content_block_stop' && text) {
        blocks.push({ type: 'text', text })
        text = ''
      }
    }
    if (text) blocks.push({ type: 'text', text })
    for (const tool of tools.values()) blocks.push({ type: 'tool_use', id: tool.id, name: tool.name, input: parseToolInput(tool.json) })
    if (stop === 'other' && tools.size) stop = 'tool'
  }
  return { blocks, stop, usage }
}

function anthropicStop(reason: unknown): ModelReply['stop'] {
  return reason === 'tool_use' ? 'tool' : reason === 'max_tokens' ? 'length' : reason === 'end_turn' ? 'end' : 'other'
}

async function callOpenAI(p: AgentProvider, key: string, req: ModelRequest): Promise<ModelReply> {
  const base = trimBase(p.baseUrl)
  const messages: any[] = [{ role: 'system', content: req.system }]
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n')
      const calls = m.content.filter((b) => b.type === 'tool_use') as Array<Extract<Block, { type: 'tool_use' }>>
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {})
      })
      continue
    }
    const results = m.content.filter((b) => b.type === 'tool_result') as Array<Extract<Block, { type: 'tool_result' }>>
    for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content })
    const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n')
    if (text) messages.push({ role: 'user', content: text })
  }
  const streaming = Boolean(req.onTextDelta)
  const calls = new Map<number, { id: string; name: string; json: string }>()
  let text = ''
  let finish: string | undefined
  let usage = { input: 0, output: 0 }
  const take = (data: any) => {
    const choice = data.choices?.[0] ?? {}
    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content
      if (req.onTextDelta) req.onTextDelta(delta.content)
    }
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? calls.size
      const current = calls.get(index) ?? { id: '', name: '', json: '' }
      if (call.id) current.id = call.id
      if (call.function?.name) current.name += call.function.name
      if (call.function?.arguments) current.json += call.function.arguments
      calls.set(index, current)
    }
    if (choice.finish_reason) finish = choice.finish_reason
    if (data.usage) usage = { input: data.usage.prompt_tokens ?? usage.input, output: data.usage.completion_tokens ?? usage.output }
  }
  const { json, streamed } = await post(
    `${base}/chat/completions`,
    { authorization: `Bearer ${key}` },
    {
      model: req.model,
      ...(streaming ? { stream: true, stream_options: { include_usage: true } } : { stream: false }),
      max_tokens: req.maxTokens ?? OUTPUT_TOKENS[0],
      messages,
      tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }))
    },
    req.signal,
    (_event, payload) => {
      if (payload === '[DONE]') return
      try {
        take(JSON.parse(payload))
      } catch {
        // ignore a partial frame
      }
    }
  )
  const blocks: Block[] = []
  if (!streamed) {
    const choice = json.choices?.[0] ?? {}
    const msg = choice.message ?? {}
    if (typeof msg.content === 'string' && msg.content.trim()) blocks.push({ type: 'text', text: msg.content })
    for (const c of msg.tool_calls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.function?.name, input: parseToolInput(c.function?.arguments) })
    const reason = choice.finish_reason
    const stop = reason === 'tool_calls' || (msg.tool_calls?.length ?? 0) > 0 ? 'tool' : reason === 'length' ? 'length' : reason === 'stop' ? 'end' : 'other'
    return { blocks, stop, usage: { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0 } }
  }
  if (text.trim()) blocks.push({ type: 'text', text })
  for (const call of calls.values()) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: parseToolInput(call.json) })
  const stop = finish === 'tool_calls' || calls.size > 0 ? 'tool' : finish === 'length' ? 'length' : finish === 'stop' ? 'end' : 'other'
  return { blocks, stop, usage }
}

function parseToolInput(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed }
  } catch {
    return { _raw: raw }
  }
}

// Output budget per reply: as large as the model allows. A map build writes whole YAML files
// in one tool call, so a small budget cuts the call off. Gateways reject a budget above the
// model's limit with a 400; we then step down and remember what worked for that model.
const OUTPUT_TOKENS = [128000, 64000, 32000, 16000, 8192]
const outputBudget = new Map<string, number>()

function budgetError(error: unknown): boolean {
  return error instanceof ModelHttpError && error.status === 400 && /max_tokens|max_completion_tokens|maximum|too large|exceed|output/i.test(error.body)
}

// Network hiccups (fetch failed, a gateway 5xx / 429, a dropped connection) are retried with a
// growing wait instead of ending the run.
function transient(error: unknown): boolean {
  if (error instanceof ModelHttpError) return error.status === 429 || error.status >= 500
  const msg = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error)
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|terminated|other side closed/i.test(msg)
}

/** Waits, but gives up as soon as the run is stopped. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    function abort() {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const waits = [2000, 5000, 10000, 20000, 30000]
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (error) {
      if (signal?.aborted || i >= waits.length || !transient(error)) throw error
      await sleep(waits[i], signal)
    }
  }
}

export async function callModel(p: AgentProvider, key: string, req: ModelRequest): Promise<ModelReply> {
  const route = codexRoute(p, req.model)
  const call = (r: ModelRequest) => withRetry(() => (route.kind === 'anthropic' ? callAnthropic(route, key, r) : callOpenAI(route, key, r)), r.signal)
  if (req.maxTokens) return call(req)
  const id = `${p.id}/${req.model}`
  const known = outputBudget.get(id)
  const tries = known ? OUTPUT_TOKENS.filter((n) => n <= known) : OUTPUT_TOKENS
  for (let i = 0; ; i++) {
    try {
      const reply = await call({ ...req, maxTokens: tries[i] })
      outputBudget.set(id, tries[i])
      return reply
    } catch (error) {
      if (i + 1 >= tries.length || !budgetError(error)) throw error
    }
  }
}

/** TT Switch serves ttsw-codex-* models on /codex/v1, not on its Anthropic /v1/messages route. */
export function codexRoute(p: AgentProvider, model: string): AgentProvider {
  if (p.kind !== 'anthropic' || !model.startsWith('ttsw-codex-')) return p
  const base = trimBase(p.baseUrl).replace(/\/v1$/, '')
  if (base.endsWith('/codex/v1')) return { ...p, kind: 'openai' }
  return { ...p, kind: 'openai', baseUrl: `${base}/codex/v1` }
}

/** Model ids the provider lists (GET {base}/v1/models or {base}/models). */
export async function listModels(p: AgentProvider, key: string): Promise<string[]> {
  const base = trimBase(p.baseUrl)
  const url = p.kind === 'anthropic' ? `${base.replace(/\/v1$/, '')}/v1/models` : `${base}/models`
  const response = await fetch(url, {
    headers: { 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw new Error(`Cannot list models (${response.status})`)
  const data = (await response.json()) as { data?: unknown[]; models?: unknown[] }
  const fetched = ((data.data ?? data.models ?? []) as Array<{ id?: string; name?: string }>).map((m) => m.id ?? m.name ?? '').filter(Boolean)
  return uniqueStrings([...(p.extraModels ?? []), ...fetched])
}
