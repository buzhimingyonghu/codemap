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

const home = mkdtempSync(path.join(tmpdir(), 'codemap-home-'))

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
})

describe('local gateways', () => {
  it('reads a Codex provider as OpenAI unless wire_api says anthropic', async () => {
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
})
