import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AgentProvider } from '../../shared/agent'

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
}

// ---------- Local gateway ----------
// Reuses a model gateway already set up on this Mac for Claude Code (~/.claude/settings.json:
// ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN) or Codex (~/.codex/config.toml: the active
// model_provider's base_url + experimental_bearer_token). We read it on demand; the token is
// never stored by us or sent to the renderer.

export interface LocalGateway {
  baseUrl: string
  token: string
  model: string
}

export async function localGateway(): Promise<LocalGateway | null> {
  try {
    const settings = JSON.parse(await readFile(path.join(homedir(), '.claude', 'settings.json'), 'utf8'))
    const env = settings?.env ?? {}
    if (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL) {
      const model = String(env.ANTHROPIC_MODEL ?? env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '')
      return { baseUrl: env.ANTHROPIC_BASE_URL, token: env.ANTHROPIC_AUTH_TOKEN, model }
    }
  } catch {
    // fall through to the Codex config
  }
  try {
    const toml = await readFile(path.join(homedir(), '.codex', 'config.toml'), 'utf8')
    const active = /^model_provider\s*=\s*"([^"]+)"/m.exec(toml)?.[1]
    if (!active) return null
    const header = '[model_providers.' + active + ']'
    const at = toml.indexOf(header)
    if (at < 0) return null
    const rest = toml.slice(at + header.length)
    const block = rest.slice(0, rest.search(/\n\[|$/))
    const baseUrl = /base_url\s*=\s*"([^"]+)"/.exec(block)?.[1]
    const token = /experimental_bearer_token\s*=\s*"([^"]+)"/.exec(block)?.[1]
    if (baseUrl && token) return { baseUrl, token, model: '' }
  } catch {
    // not installed
  }
  return null
}

export const LOCAL_GATEWAY_ID = 'local-gateway'

export function defaultProviders(): AgentProvider[] {
  return [{ id: LOCAL_GATEWAY_ID, name: 'Local gateway', kind: 'anthropic', baseUrl: '', keySource: 'local', model: '' }]
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

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<any> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  const text = await response.text()
  if (!response.ok) throw new ModelHttpError(response.status, text)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Model returned something that is not JSON: ${text.slice(0, 200)}`)
  }
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, '')
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
  const data = await post(
    `${base}/v1/messages`,
    { 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
    {
      model: req.model,
      max_tokens: req.maxTokens ?? OUTPUT_TOKENS[0],
      system: req.system,
      messages,
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }))
    },
    req.signal
  )
  const blocks: Block[] = []
  for (const c of data.content ?? []) {
    if (c.type === 'text' && c.text) blocks.push({ type: 'text', text: c.text })
    else if (c.type === 'tool_use') blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} })
  }
  const stop = data.stop_reason === 'tool_use' ? 'tool' : data.stop_reason === 'max_tokens' ? 'length' : data.stop_reason === 'end_turn' ? 'end' : 'other'
  return { blocks, stop, usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 } }
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
  const data = await post(
    `${base}/chat/completions`,
    { authorization: `Bearer ${key}` },
    {
      model: req.model,
      stream: false,
      max_tokens: req.maxTokens ?? OUTPUT_TOKENS[0],
      messages,
      tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }))
    },
    req.signal
  )
  const choice = data.choices?.[0] ?? {}
  const msg = choice.message ?? {}
  const blocks: Block[] = []
  if (typeof msg.content === 'string' && msg.content.trim()) blocks.push({ type: 'text', text: msg.content })
  for (const c of msg.tool_calls ?? []) {
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(c.function?.arguments || '{}')
    } catch {
      input = { _raw: c.function?.arguments }
    }
    blocks.push({ type: 'tool_use', id: c.id, name: c.function?.name, input })
  }
  const reason = choice.finish_reason
  const stop = reason === 'tool_calls' || (msg.tool_calls?.length ?? 0) > 0 ? 'tool' : reason === 'length' ? 'length' : reason === 'stop' ? 'end' : 'other'
  return { blocks, stop, usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 } }
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
  const call = (r: ModelRequest) => withRetry(() => (p.kind === 'anthropic' ? callAnthropic(p, key, r) : callOpenAI(p, key, r)), r.signal)
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
  return ((data.data ?? data.models ?? []) as Array<{ id?: string; name?: string }>).map((m) => m.id ?? m.name ?? '').filter(Boolean)
}
