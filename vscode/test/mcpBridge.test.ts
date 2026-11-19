import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createAgentLspTools } from '../src/host/agentLsp'
import { appendTomlSnippet, setupExternalAgents } from '../src/host/externalSetup'
import { LoopbackMcpBridge } from '../src/host/mcpBridge'
import { CodemapMcpServer, runStdioServer } from '../src/mcp/codemapMcpServer'
import type { VsCodeLspBridge } from '../src/host/lsp'

const created: string[] = []
const bridges: LoopbackMcpBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()))
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const library = path.resolve(__dirname, '../../tests/fixtures/codemap-demo/library')
const knowledge = path.resolve(__dirname, '../../agent')

function lspStub(): VsCodeLspBridge {
  return {
    symbols: async () => [{ name: 'CreateOrder', kind: 12, line: 19, column: 1, endLine: 32, endColumn: 1, children: [{ name: 'validate', kind: 12, line: 21, column: 3, endLine: 24, endColumn: 1 }] }],
    navigate: async () => [
      { path: path.join(library, 'order-svc/order-svc.yaml'), line: 1, column: 1, endLine: 1, endColumn: 8 },
      { path: path.join(library, 'order-svc/order-svc.yaml'), line: 1, column: 1, endLine: 1, endColumn: 8 }
    ],
    hover: async () => ({ contents: ['**CreateOrder**', 'creates an order'] })
  } as unknown as VsCodeLspBridge
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'codemap-mcp-'))
  created.push(dir)
  return dir
}

async function startBridge(root: string, registry: string, hooks?: { shown?: unknown[]; proposed?: unknown[] }): Promise<LoopbackMcpBridge> {
  const bridge = await LoopbackMcpBridge.start({
    registryDir: registry,
    workspaceRoot: root,
    library,
    knowledgeDir: knowledge,
    access: { allowed: (target) => target.startsWith(root) || target.startsWith(library) },
    agentLsp: createAgentLspTools(lspStub()),
    callbacks: {
      onShowOnMap: (request) => void hooks?.shown?.push(request),
      onExternalProposal: async (proposal) => void hooks?.proposed?.push(proposal)
    }
  })
  bridges.push(bridge)
  return bridge
}

test('binds only 127.0.0.1 and rejects a missing or wrong bearer', async () => {
  const root = await tempDir()
  const bridge = await startBridge(root, path.join(root, 'registry'))
  expect(bridge.address.host).toBe('127.0.0.1')
  expect(bridge.address.port).toBeGreaterThan(0)
  const info = await stat(bridge.registryFile)
  expect(info.mode & 0o777).toBe(0o600)
  const missing = await fetch(`http://127.0.0.1:${bridge.address.port}/rpc`, { method: 'POST', body: '{}' })
  const wrong = await fetch(`http://127.0.0.1:${bridge.address.port}/rpc`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })
  expect(missing.status).toBe(401)
  expect(wrong.status).toBe(401)
  const status = await bridgeRpc(bridge, 'status', {})
  expect(status).toMatchObject({ workspaceRoot: root, library, hasLibrary: true })
})

test('serves the MCP roundtrip against the live bridge and falls back offline', async () => {
  const root = await tempDir()
  const registry = path.join(root, 'registry')
  const shown: unknown[] = []
  const proposed: unknown[] = []
  const bridge = await startBridge(root, registry, { shown, proposed })
  const server = new CodemapMcpServer({ registryDir: registry, workspace: root, knowledgeDir: knowledge })

  const initialized = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  expect(initialized?.result).toMatchObject({ protocolVersion: '2024-11-05', serverInfo: { name: 'codemap' } })
  expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
  const tools = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  expect(JSON.stringify(tools?.result)).toContain('propose_change_set')
  const prompt = await server.handle({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'codemap-ask', arguments: { question: 'where is save?' } } })
  expect(JSON.stringify(prompt?.result)).toContain('where is save?')
  const resource = await server.handle({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'codemap://knowledge/create/SOP.md' } })
  expect(JSON.stringify(resource?.result)).toContain('propose_change_set')

  const overview = textOf(await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'map_overview', arguments: {} } }))
  expect(overview).toContain('order-system')
  const shownResult = await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'show_on_map', arguments: { map: 'order-svc', nodes: ['order-svc.save', 'missing'], flow: 'create-ok', note: 'look here' } } })
  expect(textOf(shownResult)).toContain('shown')
  expect(shown).toEqual([{ map: 'order-svc', nodes: ['order-svc.save'], flow: 'create-ok', note: 'look here' }])

  const valid = textOf(await server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'propose_change_set', arguments: { title: 'rename', summary: 'clearer name', changes: [{ modify: 'node', id: 'order-svc.save', set: { name: '保存订单' } }] } } }))
  expect(valid).toContain('no new problems')
  const invalid = textOf(await server.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'propose_change_set', arguments: { title: 'broken', summary: 'bad edge', changes: [{ add: 'edge', at: 'order-svc', value: { from: 'save', to: 'no-such-node' } }] } } }))
  expect(invalid).toContain('error')
  expect(invalid).toContain('fixes')
  expect(proposed).toHaveLength(2)

  const symbols = textOf(await server.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'lsp_symbols', arguments: { file: path.join(library, 'order-svc/order-svc.yaml') } } }))
  expect(symbols).toContain('function CreateOrder [L19-L32]')
  expect(symbols).toContain('  function validate [L21-L24]')

  await bridge.stop()
  const offline = textOf(await server.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'map_overview', arguments: {} } }))
  expect(offline).toContain('order-system')
  const blocked = await server.handle({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'show_on_map', arguments: { map: 'order-svc' } } })
  expect(textOf(blocked)).toContain('not running')
})

test('importing the stdio server does not read stdin until it is started', () => {
  expect(runStdioServer).toBeTypeOf('function')
  expect(process.stdin.listenerCount('data')).toBe(0)
})

test('merges external MCP config without dropping existing servers', async () => {
  const root = await tempDir()
  await mkdir(path.join(root, '.cursor'), { recursive: true })
  await writeFile(path.join(root, '.cursor/mcp.json'), `${JSON.stringify({ mcpServers: { other: { command: 'other', args: ['--secret', 'keep-me'] }, codemap: { command: 'old' } } }, null, 2)}\n`)
  await writeFile(path.join(root, '.mcp.json'), `${JSON.stringify({ mcpServers: { claude: { command: 'claude', env: { TOKEN: 'keep' } } } }, null, 2)}\n`)
  const result = setupExternalAgents({
    workspaceRoot: root,
    mcpScriptPath: path.join(root, 'codemapMcpServer.js'),
    registryDir: path.join(root, 'registry'),
    knowledgeDir: knowledge,
    command: 'node'
  })
  const cursor = JSON.parse(await readFile(result.cursorFile, 'utf8')) as { mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> }
  const claude = JSON.parse(await readFile(result.claudeFile, 'utf8')) as { mcpServers: Record<string, { command: string; env?: Record<string, string>; args?: string[] }> }
  expect(cursor.mcpServers.other.args).toEqual(['--secret', 'keep-me'])
  expect(cursor.mcpServers.codemap.command).toBe('node')
  expect(cursor.mcpServers.codemap.args).toContain('--registry-dir')
  expect(claude.mcpServers.claude.env).toEqual({ TOKEN: 'keep' })
  expect(claude.mcpServers.codemap.args).toContain(root)
  expect(result.jsonSnippet).toContain('"mcpServers"')
  expect(result.tomlSnippet).toContain('[mcp_servers.codemap]')
  const toml = path.join(root, 'config.toml')
  await writeFile(toml, 'model = "keep"\n[mcp_servers.other]\ncommand = "other"\n')
  expect(appendTomlSnippet(toml, result.tomlSnippet)).toBe(true)
  expect(appendTomlSnippet(toml, result.tomlSnippet)).toBe(false)
  expect(await readFile(toml, 'utf8')).toContain('model = "keep"')
  expect(await readFile(toml, 'utf8')).toContain('[mcp_servers.codemap]')
})

function bridgeRpc(bridge: LoopbackMcpBridge, method: string, params: unknown): Promise<unknown> {
  return fetch(`http://127.0.0.1:${bridge.address.port}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params })
  }).then(async (response) => {
    const body = await response.json() as { result: unknown }
    return body.result
  })
}

function textOf(message: { result?: unknown } | null): string {
  return JSON.stringify(message?.result ?? {})
}

