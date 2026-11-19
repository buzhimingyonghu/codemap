import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false, getAppPath: () => process.cwd() }, safeStorage: { isEncryptionAvailable: () => false } }))

const providers = await import('../../src/main/agent/providers')
const settings = await import('../../src/main/agent/settings')
const host = await import('../../src/main/agent/hostAdapter')
const runtime = await import('../../src/main/agent/runtime')

function sse(chunks: string[]): Response {
  const stream = Readable.toWeb(Readable.from(chunks.map((chunk) => Buffer.from(chunk)))) as ReadableStream<Uint8Array>
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

const provider = {
  id: 'gateway',
  name: 'Gateway',
  kind: 'openai' as const,
  baseUrl: 'http://gateway.example/v1',
  keySource: 'stored' as const,
  model: 'demo'
}

afterEach(() => {
  vi.unstubAllGlobals()
  host.configureAgentHost(null)
  delete process.env.CODEX_TEST_TOKEN
  settings.resetAgentSettingsCache()
})

describe('local gateways', () => {
  it('reads a Codex provider as OpenAI unless wire_api says anthropic', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codemap-home-'))
    const dir = path.join(home, '.codex')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'config.toml'),
      [
        'model = "codex-model"',
        'model_provider = "local"',
        '',
        '[model_providers.local]',
        'base_url = "http://codex.example/v1"',
        'env_key = "CODEX_TEST_TOKEN"',
        'wire_api = "chat"'
      ].join('\n')
    )
    process.env.CODEX_TEST_TOKEN = 'codex-secret'
    const gateway = await providers.localGateway(home)
    expect(gateway).toMatchObject({ kind: 'openai', source: 'codex', baseUrl: 'http://codex.example/v1', token: 'codex-secret', model: 'codex-model' })
  })

  it('detects Claude aliases and a Magpie Codex gateway independently', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codemap-both-'))
    mkdirSync(path.join(home, '.claude'), { recursive: true })
    mkdirSync(path.join(home, '.codex'), { recursive: true })
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
          ANTHROPIC_AUTH_TOKEN: '{{SECRET_8x4v8v2j}}',
          ANTHROPIC_MODEL: 'ttsw-cc-balanced[1M]',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'ttsw-cc-main[1M]',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'ttsw-cc-balanced[1M]',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-5.5[1m]'
        }
      })
    )
    writeFileSync(
      path.join(home, '.codex', 'config.toml'),
      [
        'model = "magpie-model"',
        'openai_base_url = "http://127.0.0.1:3425/backend-api/codex"',
        '',
        '[model_providers.custom.capabilities]',
        'streaming = true'
      ].join('\n')
    )
    const found = await providers.localGateways(home)
    expect(found.claude).toMatchObject({
      kind: 'anthropic',
      source: 'claude',
      baseUrl: 'http://127.0.0.1:15721',
      token: '{{SECRET_8x4v8v2j}}',
      model: 'ttsw-cc-balanced[1M]',
      extraModels: ['ttsw-cc-balanced[1M]', 'ttsw-cc-main[1M]', 'claude-sonnet-5.5[1m]']
    })
    expect(found.codex).toMatchObject({
      kind: 'openai',
      source: 'codex',
      baseUrl: 'http://127.0.0.1:3425/v1',
      token: 'local-gateway',
      model: 'magpie-model'
    })
    expect(await providers.localGateway(home)).toMatchObject({ source: 'claude' })
  })
})

describe('model streaming', () => {
  it('assembles OpenAI SSE text and tool calls while emitting deltas', async () => {
    const deltas: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
          'data: [DONE]\n\n'
        ])
      )
    )
    const reply = await providers.callModel(provider, 'secret-key', {
      model: 'demo',
      system: 's',
      messages: [],
      tools: [],
      maxTokens: 16,
      onTextDelta: (delta) => deltas.push(delta)
    })
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(reply.blocks).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a' } }
    ])
    expect(reply.stop).toBe('tool')
    expect(reply.usage).toEqual({ input: 3, output: 2 })
  })

  it('assembles Anthropic SSE and falls back to a JSON body', async () => {
    const deltas: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":1}"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n'
        ])
      )
      .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'plain' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    vi.stubGlobal('fetch', fetchMock)
    const anthropic = { ...provider, kind: 'anthropic' as const, baseUrl: 'http://claude.example' }
    const streamed = await providers.callModel(anthropic, 'secret-key', {
      model: 'demo',
      system: 's',
      messages: [],
      tools: [],
      maxTokens: 16,
      onTextDelta: (delta) => deltas.push(delta)
    })
    expect(deltas).toEqual(['OK'])
    expect(streamed.stop).toBe('tool')
    expect(streamed.usage).toEqual({ input: 4, output: 5 })
    const plain = await providers.callModel(anthropic, 'secret-key', { model: 'demo', system: 's', messages: [], tools: [], maxTokens: 16, onTextDelta: () => undefined })
    expect(plain.blocks).toEqual([{ type: 'text', text: 'plain' }])
    expect(plain.stop).toBe('end')
    expect(String((fetchMock.mock.calls[0][1] as RequestInit).body)).toContain('"stream":true')
  })

  it('adds Anthropic cache tokens into the prompt total and estimates only a zero report', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":4000,"cache_creation_input_tokens":30}}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n'
        ])
      )
    )
    const anthropic = { ...provider, kind: 'anthropic' as const, baseUrl: 'http://claude.example' }
    const streamed = await providers.callModel(anthropic, 'secret-key', {
      model: 'demo',
      system: 's',
      messages: [],
      tools: [],
      maxTokens: 16,
      onTextDelta: () => undefined
    })
    expect(streamed.usage).toEqual({ input: 4050, output: 7 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ content: [{ type: 'text', text: 'plain' }], stop_reason: 'end_turn', usage: { input_tokens: 0, cache_read_input_tokens: 10, output_tokens: 2 } }))
    )
    const cached = await providers.callModel(anthropic, 'secret-key', { model: 'demo', system: 'system text', messages: [], tools: [], maxTokens: 16 })
    expect(cached.usage.input).toBe(10)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ content: [{ type: 'text', text: 'plain' }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 2 } }))
    )
    const empty = await providers.callModel(anthropic, 'secret-key', { model: 'demo', system: 'abcd', messages: [{ role: 'user', content: [{ type: 'text', text: 'efgh' }] }], tools: [], maxTokens: 16 })
    expect(empty.usage.input).toBe(Math.ceil(8 / 3.8))
  })

  it('routes ttsw-codex models through the OpenAI Codex endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'routed' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    vi.stubGlobal('fetch', fetchMock)
    const anthropic = { ...provider, kind: 'anthropic' as const, baseUrl: 'http://127.0.0.1:15721' }
    const reply = await providers.callModel(anthropic, 'secret-key', {
      model: 'ttsw-codex-deepseek-v4.1-flash',
      system: 's',
      messages: [],
      tools: [],
      maxTokens: 16
    })
    expect(reply.blocks).toEqual([{ type: 'text', text: 'routed' }])
    const urls = fetchMock.mock.calls.map((call) => String(call.at(0)))
    expect(urls[0]).toBe('http://127.0.0.1:15721/codex/v1/chat/completions')
    const claude = await providers.callModel(anthropic, 'secret-key', {
      model: 'ttsw-cc-balanced[1M]',
      system: 's',
      messages: [],
      tools: [],
      maxTokens: 16
    })
    expect(claude.stop).toBe('other')
    urls.push(...fetchMock.mock.calls.slice(urls.length).map((call) => String(call.at(0))))
    expect(urls[1]).toBe('http://127.0.0.1:15721/v1/messages')
  })

  it('reads an SSE body when no text callback was requested', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
          'data: [DONE]\n\n'
        ])
      )
    )
    const reply = await providers.callModel(provider, 'secret-key', { model: 'demo', system: 's', messages: [], tools: [], maxTokens: 16 })
    expect(reply.blocks).toEqual([{ type: 'text', text: 'OK' }])
    expect(reply.stop).toBe('end')
    expect(reply.usage).toEqual({ input: 2, output: 1 })
  })
})

describe('provider connection and history', () => {
  it('pings with a short completion when the model list is empty and redacts the key', async () => {
    const userData = mkdtempSync(path.join(tmpdir(), 'codemap-settings-'))
    host.configureAgentHost({
      userDataDir: () => userData,
      knowledgeDir: () => path.join(userData, 'knowledge'),
      getSecret: async () => 'super-secret',
      loadSettingsOverride: () => ({ maxParallel: 5 })
    })
    const saved = await settings.saveAgentSettings({
      providers: [{ id: 'custom-1', name: 'Custom', kind: 'openai', baseUrl: 'http://example.test/v1', keySource: 'stored', model: 'demo' }],
      activeProvider: 'custom-1',
      modeModels: {},
      maxParallel: 2
    })
    expect(saved.maxParallel).toBe(5)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/models')) return jsonResponse({ data: [] })
        throw new Error('failed for key super-secret')
      })
    )
    const result = await settings.testProviderConnection('custom-1')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('[redacted]')
    expect(result.message).not.toContain('super-secret')
    expect(result.kind).toBe('openai')
  })

  it('compacts only old oversized tool results', () => {
    const big = 'x'.repeat(1500)
    const history = Array.from({ length: 7 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: index < 3 ? [{ type: 'tool_result' as const, id: 'old' + index, content: big }] : [{ type: 'text' as const, text: 'short' }]
    }))
    const compact = runtime.compactHistory(history)
    expect(compact[0].content[0]).toMatchObject({ type: 'tool_result' })
    expect((compact[0].content[0] as { content: string }).content).toContain('earlier tool output compacted')
    expect(history[0].content[0]).toMatchObject({ content: big })
    expect(compact[6]).toBe(history[6])
    expect((compact[3].content[0] as { text?: string }).text).toBe('short')
  })

  it('resolves the requested local gateway when both exist', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codemap-settings-home-'))
    const userData = mkdtempSync(path.join(tmpdir(), 'codemap-settings-'))
    mkdirSync(path.join(home, '.claude'), { recursive: true })
    mkdirSync(path.join(home, '.codex'), { recursive: true })
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721', ANTHROPIC_AUTH_TOKEN: '{{SECRET_8x4v8v2j}}', ANTHROPIC_MODEL: 'claude-sonnet' } })
    )
    writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "codex-model"\nopenai_base_url = "http://127.0.0.1:3425/backend-api/codex/"\n')
    writeFileSync(
      path.join(userData, 'agent.json'),
      JSON.stringify({
        providers: [{ id: 'local-gateway', name: 'Old', kind: 'anthropic', baseUrl: '', keySource: 'local', model: 'ttsw-codex-deepseek-v4.1-flash' }],
        activeProvider: 'local-gateway',
        modeModels: { ask: 'mode-sonnet' },
        maxParallel: 3,
        keys: {}
      })
    )
    const realHome = process.env.HOME
    process.env.HOME = home
    host.configureAgentHost({ userDataDir: () => userData, knowledgeDir: () => path.join(userData, 'knowledge') })
    try {
      const view = await settings.getAgentSettings()
      expect(view.providers.map((item) => item.id)).toEqual(['local-gateway', 'local-codex'])
      const claude = view.providers.find((item) => item.id === 'local-gateway')
      const codex = view.providers.find((item) => item.id === 'local-codex')
      expect(claude).toMatchObject({ hasKey: true, baseUrl: 'http://127.0.0.1:15721', localSource: 'claude', kind: 'anthropic', model: 'ttsw-codex-deepseek-v4.1-flash' })
      expect(codex).toMatchObject({ hasKey: true, baseUrl: 'http://127.0.0.1:3425/v1', localSource: 'codex', kind: 'openai', model: 'codex-model' })
      expect(view.activeProvider).toBe('local-gateway')
      const claudeResolved = await settings.resolveProvider('local-gateway')
      const codexResolved = await settings.resolveProvider('local-codex')
      expect(claudeResolved.provider).toMatchObject({ id: 'local-gateway', baseUrl: 'http://127.0.0.1:15721', kind: 'anthropic' })
      expect(codexResolved.provider).toMatchObject({ id: 'local-codex', baseUrl: 'http://127.0.0.1:3425/v1', kind: 'openai' })
      expect(claudeResolved.key).toBe('{{SECRET_8x4v8v2j}}')
      expect(codexResolved.key).toBe('local-gateway')
    } finally {
      if (realHome === undefined) delete process.env.HOME
      else process.env.HOME = realHome
    }
  })
})
