import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import type { AgentProvider, AgentSettings } from '../../shared/agent'
import { LOCAL_GATEWAY_ID, defaultProviders, localGateway } from './providers'

// Agent settings live next to the app state; API keys are encrypted with the macOS keychain
// (safeStorage) and only decrypted in the main process when a request is made.

interface Stored extends AgentSettings {
  /** Provider id → base64 of the encrypted key. */
  keys: Record<string, string>
}

const DEFAULT_TURNS = 1000
const MAX_TURNS = 5000
const DEFAULTS: Stored = { providers: defaultProviders(), activeProvider: LOCAL_GATEWAY_ID, modeModels: {}, maxParallel: 3, maxTurns: DEFAULT_TURNS, keys: {} }

let cached: Stored | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'agent.json')
}

async function load(): Promise<Stored> {
  if (cached) return cached
  try {
    const parsed = JSON.parse(await readFile(file(), 'utf8')) as Partial<Stored>
    // Older files named the local gateway differently: map it onto the current one.
    const legacy = (p: { id: string; keySource: string }) => p.keySource !== 'stored'
    const saved = Array.isArray(parsed.providers) && parsed.providers.length ? parsed.providers : DEFAULTS.providers
    const providers = saved.map((p) => (legacy(p) ? { ...defaultProviders()[0], model: p.model ?? '' } : p))
    // The local gateway is always offered, even if an older file removed it.
    if (!providers.some((p) => p.id === LOCAL_GATEWAY_ID)) providers.unshift(defaultProviders()[0])
    const activeProvider = saved.find((p) => p.id === parsed.activeProvider && legacy(p)) ? LOCAL_GATEWAY_ID : (parsed.activeProvider ?? LOCAL_GATEWAY_ID)
    // 40 was the old default; a map build needs far more turns, so lift files that kept it.
    const maxTurns = !parsed.maxTurns || parsed.maxTurns === 40 ? DEFAULT_TURNS : parsed.maxTurns
    cached = { ...DEFAULTS, ...parsed, maxTurns, providers, activeProvider, modeModels: { ...(parsed.modeModels ?? {}) }, keys: { ...(parsed.keys ?? {}) } }
  } catch {
    cached = structuredClone(DEFAULTS)
  }
  return cached
}

async function save(next: Stored): Promise<void> {
  cached = next
  await mkdir(path.dirname(file()), { recursive: true })
  await writeFile(file(), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
}

function publicView(s: Stored): AgentSettings {
  return {
    providers: s.providers.map((p) => ({ ...p, hasKey: p.keySource === 'local' ? undefined : Boolean(s.keys[p.id]) })),
    activeProvider: s.activeProvider,
    modeModels: s.modeModels,
    maxParallel: s.maxParallel,
    maxTurns: s.maxTurns
  }
}

export async function getAgentSettings(): Promise<AgentSettings> {
  const s = publicView(await load())
  // Tell the panel whether a local gateway is set up on this Mac, and where it points.
  const local = s.providers.find((p) => p.keySource === 'local')
  if (local) {
    const gw = await localGateway()
    local.hasKey = Boolean(gw)
    local.baseUrl = gw?.baseUrl ?? ''
  }
  return s
}

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/

/** Saves providers and options. Keys are set separately with setProviderKey. */
export async function saveAgentSettings(next: AgentSettings): Promise<AgentSettings> {
  const current = await load()
  const providers: AgentProvider[] = []
  for (const p of next.providers ?? []) {
    if (!SAFE_ID.test(String(p.id))) throw new Error(`Bad provider id: ${p.id}`)
    if (p.kind !== 'anthropic' && p.kind !== 'openai') throw new Error(`Unknown provider type: ${p.kind}`)
    if (p.keySource === 'local') {
      providers.push({ ...defaultProviders()[0], model: String(p.model || '') })
      continue
    }
    if (!/^https?:\/\//.test(String(p.baseUrl))) throw new Error(`Base URL must start with http(s)://: ${p.baseUrl}`)
    providers.push({ id: p.id, name: String(p.name || p.id), kind: p.kind, baseUrl: String(p.baseUrl), keySource: 'stored', model: String(p.model || '') })
  }
  if (!providers.some((p) => p.id === LOCAL_GATEWAY_ID)) providers.unshift(defaultProviders()[0])
  const keys = Object.fromEntries(Object.entries(current.keys).filter(([id]) => providers.some((p) => p.id === id)))
  await save({
    providers,
    activeProvider: providers.some((p) => p.id === next.activeProvider) ? next.activeProvider : providers[0].id,
    modeModels: Object.fromEntries(Object.entries(next.modeModels ?? {}).filter(([, v]) => typeof v === 'string' && v)) as AgentSettings['modeModels'],
    maxParallel: Math.max(1, Math.min(8, Math.round(Number(next.maxParallel) || 3))),
    maxTurns: Math.max(5, Math.min(MAX_TURNS, Math.round(Number(next.maxTurns) || DEFAULT_TURNS))),
    keys
  })
  return getAgentSettings()
}

export async function setProviderKey(id: string, key: string | null): Promise<AgentSettings> {
  const current = await load()
  if (!current.providers.some((p) => p.id === id)) throw new Error(`No provider ${id}`)
  const keys = { ...current.keys }
  if (!key) delete keys[id]
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The system keychain is not available to store the key')
    keys[id] = safeStorage.encryptString(key).toString('base64')
  }
  await save({ ...current, keys })
  return getAgentSettings()
}

/** The provider to use and its key (main process only). */
export async function resolveProvider(id?: string | null): Promise<{ provider: AgentProvider; key: string }> {
  const s = await load()
  let provider = s.providers.find((p) => p.id === (id ?? s.activeProvider)) ?? s.providers[0]
  if (!provider) throw new Error('No model provider is configured')
  let key: string | null = null
  if (provider.keySource === 'local') {
    const gw = await localGateway()
    if (!gw) throw new Error('No local gateway on this Mac: set one up for Claude Code or Codex, or add another provider in Settings')
    key = gw.token
    provider = { ...provider, baseUrl: gw.baseUrl, model: provider.model || gw.model }
  } else if (s.keys[provider.id]) {
    key = safeStorage.decryptString(Buffer.from(s.keys[provider.id], 'base64'))
  }
  if (!key) throw new Error(`No API key for ${provider.name}: add it in Settings → AI`)
  return { provider, key }
}

export async function rawAgentSettings(): Promise<AgentSettings> {
  return publicView(await load())
}
