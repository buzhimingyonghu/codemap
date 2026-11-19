import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentProvider, AgentSettings, ProviderKind } from '../../shared/agent'
import { electronSafeStorage, ensureElectronHost, getAgentHost, userDataDir } from './hostAdapter'
import { LOCAL_GATEWAY_ID, callModel, defaultProviders, listModels, localGateway } from './providers'

// Agent settings live next to the app state; API keys are encrypted with the macOS keychain
// (safeStorage) and only decrypted when a request is made. A host adapter can supply its own
// secret store and settings overrides. electron is loaded lazily, never at evaluation time.

interface Stored extends AgentSettings {
  /** Provider id → base64 of the encrypted key. */
  keys: Record<string, string>
}

const DEFAULTS: Stored = { providers: defaultProviders(), activeProvider: LOCAL_GATEWAY_ID, modeModels: {}, maxParallel: 3, keys: {} }

let cached: Stored | null = null

function file(): string {
  return path.join(userDataDir(), 'agent.json')
}

async function load(): Promise<Stored> {
  if (cached) return cached
  await ensureElectronHost()
  try {
    const parsed = JSON.parse(await readFile(file(), 'utf8')) as Partial<Stored>
    // Older files named the local gateway differently: map it onto the current one.
    const legacy = (p: { id: string; keySource: string }) => p.keySource !== 'stored'
    const saved = Array.isArray(parsed.providers) && parsed.providers.length ? parsed.providers : DEFAULTS.providers
    const providers = saved.map((p) => (legacy(p) ? { ...defaultProviders()[0], model: p.model ?? '' } : p))
    // The local gateway is always offered, even if an older file removed it.
    if (!providers.some((p) => p.id === LOCAL_GATEWAY_ID)) providers.unshift(defaultProviders()[0])
    const activeProvider = saved.find((p) => p.id === parsed.activeProvider && legacy(p)) ? LOCAL_GATEWAY_ID : (parsed.activeProvider ?? LOCAL_GATEWAY_ID)
    // Older files carry maxTurns; runs have no turn limit any more, so it is dropped.
    const { maxTurns: _old, ...rest } = parsed as Partial<Stored> & { maxTurns?: number }
    cached = { ...DEFAULTS, ...rest, providers, activeProvider, modeModels: { ...(parsed.modeModels ?? {}) }, keys: { ...(parsed.keys ?? {}) } }
  } catch {
    cached = structuredClone(DEFAULTS)
  }
  return cached
}

/** Applies a host override for readers without writing it back into the cached file. */
async function withOverride(stored: Stored): Promise<Stored> {
  const override = await getAgentHost()?.loadSettingsOverride?.()
  if (!override) return stored
  return { ...stored, ...override, providers: stored.providers, keys: stored.keys, modeModels: { ...stored.modeModels, ...(override.modeModels ?? {}) } }
}

async function save(next: Stored): Promise<void> {
  cached = next
  await mkdir(path.dirname(file()), { recursive: true })
  await writeFile(file(), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  await getAgentHost()?.saveSettingsOverride?.(publicView(next))
}

function publicView(s: Stored): AgentSettings {
  return {
    providers: s.providers.map((p) => ({ ...p, hasKey: p.keySource === 'local' ? undefined : Boolean(s.keys[p.id]) })),
    activeProvider: s.activeProvider,
    modeModels: s.modeModels,
    maxParallel: s.maxParallel
  }
}

export async function getAgentSettings(): Promise<AgentSettings> {
  const s = publicView(await withOverride(await load()))
  // Tell the panel whether a local gateway is set up, and which wire protocol it speaks.
  const local = s.providers.find((p) => p.keySource === 'local')
  if (local) {
    const gw = await localGateway()
    local.hasKey = Boolean(gw)
    local.baseUrl = gw?.baseUrl ?? ''
    local.kind = gw?.kind ?? local.kind
    local.localSource = gw?.source
    if (!local.model && gw?.model) local.model = gw.model
  }
  for (const provider of s.providers) {
    if (provider.keySource === 'stored' && (await getAgentHost()?.hasSecret?.(provider.id))) provider.hasKey = true
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
    keys
  })
  return getAgentSettings()
}

export async function setProviderKey(id: string, key: string | null): Promise<AgentSettings> {
  const current = await load()
  if (!current.providers.some((p) => p.id === id)) throw new Error(`No provider ${id}`)
  const host = getAgentHost()
  if (host?.setSecret) {
    await host.setSecret(id, key)
    return getAgentSettings()
  }
  const keys = { ...current.keys }
  if (!key) delete keys[id]
  else {
    const safeStorage = await electronSafeStorage()
    if (!safeStorage?.isEncryptionAvailable()) throw new Error('The system keychain is not available to store the key')
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
    if (!gw) throw new Error('No local gateway detected (~/.claude/settings.json or ~/.codex/config.toml). Configure Claude Code / Codex or add a provider in AI Settings.')
    key = gw.token
    provider = { ...provider, kind: gw.kind, baseUrl: gw.baseUrl, model: provider.model || gw.model, localSource: gw.source }
  } else {
    key = (await getAgentHost()?.getSecret?.(provider.id)) ?? null
    if (!key && s.keys[provider.id]) {
      const safeStorage = await electronSafeStorage()
      if (!safeStorage) throw new Error('The system keychain is not available to read the key')
      key = safeStorage.decryptString(Buffer.from(s.keys[provider.id], 'base64'))
    }
  }
  if (!key) throw new Error(`No API key for ${provider.name}: add it in Settings → AI`)
  return { provider, key }
}

export async function rawAgentSettings(): Promise<AgentSettings> {
  return publicView(await withOverride(await load()))
}

export interface ProviderConnection {
  ok: boolean
  model: string
  kind: ProviderKind
  latencyMs: number
  message: string
}

/** Checks that the chosen provider answers, without returning the key. */
export async function testProviderConnection(providerId?: string | null, modelOverride?: string): Promise<ProviderConnection> {
  const started = Date.now()
  const { provider, key } = await resolveProvider(providerId)
  const model = modelOverride || provider.model
  if (!model) throw new Error(`No model chosen for ${provider.name}`)
  const latency = () => Date.now() - started
  try {
    const models = await listModels(provider, key)
    if (models.length) {
      const known = models.includes(model)
      return { ok: known, model, kind: provider.kind, latencyMs: latency(), message: known ? `Listed ${models.length} models` : `Connected, but ${model} is not in the model list` }
    }
  } catch {
    // Some gateways have no model list; a short completion is the fallback.
  }
  try {
    const reply = await callModel(provider, key, {
      model,
      system: 'Reply with exactly OK.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK' }] }],
      tools: [],
      maxTokens: 16
    })
    const text = reply.blocks.find((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    return { ok: true, model, kind: provider.kind, latencyMs: latency(), message: text?.text.trim() ? 'Model replied' : 'Model accepted the request' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, model, kind: provider.kind, latencyMs: latency(), message: message.split(key).join('[redacted]') }
  }
}
