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

async function startBridge(root: string, registry: string, hooks?: { shown?: unknown[]; proposed?: unknown[]; discarded?: unknown[] }): Promise<LoopbackMcpBridge> {
  const bridge = await LoopbackMcpBridge.start({
    registryDir: registry,
    workspaceRoot: root,
    library,
    knowledgeDir: knowledge,
    access: { allowed: (target) => target.startsWith(root) || target.startsWith(library) },
    agentLsp: createAgentLspTools(lspStub()),
    callbacks: {
      onShowOnMap: (request) => void hooks?.shown?.push(request),
      onExternalProposal: async (proposal) => void hooks?.proposed?.push(proposal),
      onDiscardProposal: async (id, reason) => void hooks?.discarded?.push({ id, reason })
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


test('merges an extended proposal, replaces changes, discards it, and scans entrypoints', async () => {
  const root = await tempDir()
  await writeFile(path.join(root, 'main.go'), 'package main\nfunc main() {\n\trouter.GET("/orders", listOrders)\n\tpb.RegisterOrderServer(server, svc)\n\tqueue.Watch(ctx)\n\tcron.New()\n\tdb.Query("select 1")\n}\n')
  await mkdir(path.join(root, '.git'), { recursive: true })
  await writeFile(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://example.invalid/orders.git\n')
  const proposed: Array<{ id: string; files: Record<string, string>; changes: unknown[]; replaceChanges?: boolean }> = []
  const discarded: unknown[] = []
  const bridge = await startBridge(root, path.join(root, 'registry'), { proposed, discarded })
  const server = new CodemapMcpServer({ registryDir: path.join(root, 'registry'), workspace: root, knowledgeDir: knowledge })

  const first = JSON.parse(textOf(await server.handle({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'propose_change_set', arguments: { title: 'orders', summary: 'first', files: { 'orders.yaml': 'id: orders\n' }, changes: [{ add: 'node', id: 'one' }] } } }))) as { content: Array<{ text: string }> }
  const created = JSON.parse(first.content[0].text) as { id: string }
  const extended = JSON.parse(textOf(await server.handle({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'propose_change_set', arguments: { title: 'orders', summary: 'more', extend: created.id, files: { 'pay.yaml': 'id: pay\n' }, changes: [{ add: 'node', id: 'two' }] } } }))) as { content: Array<{ text: string }> }
  const merged = JSON.parse(extended.content[0].text) as { id: string; changeCount: number; files: string[]; extended: boolean }
  expect(merged).toMatchObject({ id: created.id, extended: true, changeCount: 2 })
  expect(merged.files).toEqual(['orders.yaml', 'pay.yaml'])

  const replaced = JSON.parse(textOf(await server.handle({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'propose_change_set', arguments: { title: 'orders', summary: 'replaced', extend: created.id, replaceChanges: true, changes: [{ add: 'node', id: 'only' }] } } }))) as { content: Array<{ text: string }> }
  expect(JSON.parse(replaced.content[0].text)).toMatchObject({ id: created.id, replaceChanges: true, changeCount: 1 })
  expect(proposed.at(-1)?.changes).toEqual([{ add: 'node', id: 'only' }])
  expect(proposed.at(-1)?.files).toMatchObject({ 'orders.yaml': 'id: orders\n', 'pay.yaml': 'id: pay\n' })

  const dropped = JSON.parse(textOf(await server.handle({ jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'discard_change_set', arguments: { id: created.id, reason: 'wedged draft' } } }))) as { content: Array<{ text: string }> }
  expect(JSON.parse(dropped.content[0].text)).toEqual({ discarded: true, id: created.id, title: 'orders' })
  expect(discarded).toEqual([{ id: created.id, reason: 'wedged draft' }])

  const liveScan = JSON.parse(textOf(await server.handle({ jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: 'scan_repo_entrypoints', arguments: { path: root, targetFolder: 'orders' } } }))) as { content: Array<{ text: string }> }
  const scanned = JSON.parse(liveScan.content[0].text) as { remote: string; repoLocal: string; entrypoints: Array<{ kind: string; text: string }> }
  expect(scanned.remote).toBe('https://example.invalid/orders.git')
  expect(scanned.repoLocal).toContain('..')
  expect(scanned.entrypoints.map((item) => item.kind)).toEqual(expect.arrayContaining(['route', 'rpc', 'mq', 'cron', 'db', 'git']))

  await bridge.stop()
  const offline = JSON.parse(textOf(await server.handle({ jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 'scan_repo_entrypoints', arguments: { path: root } } }))) as { content: Array<{ text: string }> }
  expect(JSON.parse(offline.content[0].text).entrypoints).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'git', text: 'https://example.invalid/orders.git' })]))

  const prompts = await server.handle({ jsonrpc: '2.0', id: 27, method: 'prompts/get', params: { name: 'codemap-build', arguments: { tier: 'deep', lens: 'troubleshoot', scope: 'orders' } } })
  const promptText = JSON.stringify(prompts?.result)
  expect(promptText).toContain('scan_repo_entrypoints')
  expect(promptText).toContain('common/guide.md')
  expect(promptText).toContain('discard_change_set')
  expect(promptText).toContain('deep')
  expect(promptText).toContain('troubleshoot')
  const resources = await server.handle({ jsonrpc: '2.0', id: 28, method: 'resources/list' })
  expect(JSON.stringify(resources?.result)).toContain('codemap://knowledge/common/guide.md')
  expect(JSON.stringify(resources?.result)).toContain('codemap://knowledge/adjust/guide.md')
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
  expect(result.skillChanged).toBe(true)
  const skill = await readFile(result.skillFile, 'utf8')
  expect(skill).toContain('scan_repo_entrypoints')
  expect(skill).toContain('discard_change_set')
  expect(skill).toContain('replaceChanges')
  expect(skill).toContain('codemap/v1')
  expect(skill).not.toMatch(/token|secret|api[_-]?key/i)
  const again = setupExternalAgents({
    workspaceRoot: root,
    mcpScriptPath: path.join(root, 'codemapMcpServer.js'),
    registryDir: path.join(root, 'registry'),
    knowledgeDir: knowledge,
    command: 'node'
  })
  expect(again.skillChanged).toBe(false)
  expect(again.cursorChanged).toBe(false)
  expect(again.claudeChanged).toBe(false)
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

