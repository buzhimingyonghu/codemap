import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentProvider, AgentSettings, ProviderKind } from '../../shared/agent'
import { electronSafeStorage, ensureElectronHost, getAgentHost, userDataDir } from './hostAdapter'
import { LOCAL_CLAUDE_ID, LOCAL_CODEX_ID, callModel, codexRoute, defaultProviders, listModels, localGateways, type LocalGateway } from './providers'

// Agent settings live next to the app state; API keys are encrypted with the macOS keychain
// (safeStorage) and only decrypted when a request is made. A host adapter can supply its own
// secret store and settings overrides. electron is loaded lazily, never at evaluation time.

interface Stored extends AgentSettings {
  /** Provider id → base64 of the encrypted key. */
  keys: Record<string, string>
}

const DEFAULTS: Stored = { providers: defaultProviders(), activeProvider: LOCAL_CLAUDE_ID, modeModels: {}, maxParallel: 3, keys: {} }

let cached: Stored | null = null

/** Test hook: settings are cached for the process, so a new user-data dir needs a fresh read. */
export function resetAgentSettingsCache(): void {
  cached = null
}

function file(): string {
  return path.join(userDataDir(), 'agent.json')
}

async function load(): Promise<Stored> {
  if (cached) return cached
  await ensureElectronHost()
  try {
    const parsed = JSON.parse(await readFile(file(), 'utf8')) as Partial<Stored>
    // Older files named the local gateway differently: map an unnamed local gateway onto Claude.
    const legacy = (p: { id: string; keySource: string }) => p.keySource !== 'stored' && p.id !== LOCAL_CLAUDE_ID && p.id !== LOCAL_CODEX_ID
    const saved = Array.isArray(parsed.providers) && parsed.providers.length ? parsed.providers : DEFAULTS.providers
    const providers = saved.map((p) => (legacy(p) ? { ...builtinLocal(LOCAL_CLAUDE_ID), model: p.model ?? '' } : p))
    ensureBuiltinLocals(providers)
    const activeProvider = saved.find((p) => p.id === parsed.activeProvider && legacy(p)) ? LOCAL_CLAUDE_ID : (parsed.activeProvider ?? LOCAL_CLAUDE_ID)
    // Older files carry maxTurns; runs have no turn limit any more, so it is dropped.
    const { maxTurns: _old, ...rest } = parsed as Partial<Stored> & { maxTurns?: number }
    cached = { ...DEFAULTS, ...rest, providers, activeProvider, modeModels: { ...(parsed.modeModels ?? {}) }, keys: { ...(parsed.keys ?? {}) } }
  } catch {
    cached = structuredClone(DEFAULTS)
  }
  return cached
}

function builtinLocal(id: string): AgentProvider {
  const found = defaultProviders().find((provider) => provider.id === id)
  if (!found) throw new Error(`Missing built-in provider ${id}`)
  return { ...found }
}

/** Keeps both built-in local gateways, inserting only the ones an older file does not have. */
function ensureBuiltinLocals(providers: AgentProvider[]): void {
  const builtins = defaultProviders()
  const existing = new Map(providers.filter((provider) => builtins.some((builtin) => builtin.id === provider.id)).map((provider) => [provider.id, provider]))
  const custom = providers.filter((provider) => !builtins.some((builtin) => builtin.id === provider.id))
  providers.splice(0, providers.length, ...builtins.map((builtin) => existing.get(builtin.id) ?? { ...builtin }), ...custom)
}

function bindLocal(provider: AgentProvider, gateway: LocalGateway | null): AgentProvider {
  if (!gateway) return { ...provider, hasKey: false, baseUrl: '', extraModels: undefined }
  return {
    ...provider,
    hasKey: true,
    baseUrl: gateway.baseUrl,
    kind: gateway.kind,
    localSource: gateway.source,
    model: provider.model || gateway.model || '',
    ...(gateway.extraModels?.length ? { extraModels: gateway.extraModels } : { extraModels: undefined })
  }
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
  const stored = await withOverride(await load())
  const s = publicView(stored)
  // Tell the panel whether a local gateway is set up, and which wire protocol it speaks.
  const gws = await localGateways()
  s.providers = s.providers.map((provider) => (provider.keySource === 'local' ? bindLocal(provider, gatewayFor(provider, gws)) : provider))
  if (stored.activeProvider === LOCAL_CLAUDE_ID && !gws.claude && gws.codex) s.activeProvider = LOCAL_CODEX_ID
  for (const provider of s.providers) {
    if (provider.keySource === 'stored' && (await getAgentHost()?.hasSecret?.(provider.id))) provider.hasKey = true
  }
  return s
}

function gatewayFor(provider: AgentProvider, gws: { claude: LocalGateway | null; codex: LocalGateway | null }): LocalGateway | null {
  if (provider.id === LOCAL_CODEX_ID || provider.localSource === 'codex') return gws.codex
  return gws.claude
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
      const builtin = p.id === LOCAL_CODEX_ID || p.localSource === 'codex' ? builtinLocal(LOCAL_CODEX_ID) : builtinLocal(LOCAL_CLAUDE_ID)
      providers.push({ ...builtin, model: String(p.model || '') })
      continue
    }
    if (!/^https?:\/\//.test(String(p.baseUrl))) throw new Error(`Base URL must start with http(s)://: ${p.baseUrl}`)
    providers.push({ id: p.id, name: String(p.name || p.id), kind: p.kind, baseUrl: String(p.baseUrl), keySource: 'stored', model: String(p.model || '') })
  }
  ensureBuiltinLocals(providers)
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
  const gws = await localGateways()
  let requested = id ?? s.activeProvider
  if (!id && requested === LOCAL_CLAUDE_ID && !gws.claude && gws.codex) requested = LOCAL_CODEX_ID
  let provider = s.providers.find((p) => p.id === requested) ?? s.providers[0]
  if (!provider) throw new Error('No model provider is configured')
  let key: string | null = null
  if (provider.keySource === 'local') {
    const gw = gatewayFor(provider, gws)
    if (!gw) {
      const where = provider.id === LOCAL_CODEX_ID ? '~/.codex/config.toml' : '~/.claude/settings.json'
      throw new Error(`No local gateway detected (${where}). Configure Claude Code / Codex or add a provider in AI Settings.`)
    }
    key = gw.token
    provider = {
      ...provider,
      kind: gw.kind,
      baseUrl: gw.baseUrl,
      model: provider.model || gw.model,
      localSource: gw.source,
      ...(gw.extraModels?.length ? { extraModels: gw.extraModels } : {})
    }
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
  const route = codexRoute(provider, model)
  const rerouted = route.kind !== provider.kind || route.baseUrl !== provider.baseUrl
  const latency = () => Date.now() - started
  if (!rerouted) {
    try {
      const models = await listModels(provider, key)
      if (models.length) {
        if (models.includes(model)) return { ok: true, model, kind: route.kind, latencyMs: latency(), message: `Listed ${models.length} models` }
        // Alias models can be accepted by the gateway without appearing in /v1/models.
      }
    } catch {
      // Some gateways have no model list; a short completion is the fallback.
    }
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
    return { ok: true, model, kind: route.kind, latencyMs: latency(), message: text?.text.trim() ? 'Model replied' : 'Model accepted the request' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, model, kind: route.kind, latencyMs: latency(), message: message.split(key).join('[redacted]') }
  }
}
