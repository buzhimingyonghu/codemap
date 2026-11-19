import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CodeMapBridge } from '../src/host/bridge'
import { flushReady, queueHostAction, SurfaceHub, type HostPostEvent } from '../src/host/session'
import { resolveAgentKnowledgeDir } from '../src/host/knowledge'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function prompts(picked: string | null = null) {
  return {
    pickFolder: async () => picked,
    confirm: async () => 0,
    quickPick: async () => null,
    warning: async () => true
  }
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'codemap-wire-'))
  created.push(dir)
  return dir
}

test('initDefaultLibrary creates codemap once and createLibrary appends its ignore file', async () => {
  const root = await tempDir()
  const bridge = new CodeMapBridge(root, [], prompts())
  const createdLibrary = await bridge.initDefaultLibrary()
  expect(createdLibrary.status).toBe('ready')
  expect(createdLibrary.library).toBe(path.join(root, 'codemap'))
  const ignore = await readFile(path.join(root, 'codemap', '.codemapignore'), 'utf8')
  expect(ignore).toContain('node_modules/')
  expect(ignore).toContain('todo/')

  const again = await bridge.initDefaultLibrary()
  const doubled = await readFile(path.join(root, 'codemap', '.codemapignore'), 'utf8')
  expect(again.library).toBe(createdLibrary.library)
  expect(doubled).toBe(ignore)

  const picked = path.join(root, 'picked-library')
  const custom = new CodeMapBridge(root, [], prompts(picked))
  const loaded = await custom.createLibrary()
  await custom.createLibrary(picked)
  expect(loaded?.library).toBe(picked)
  const customIgnore = await readFile(path.join(picked, '.codemapignore'), 'utf8')
  expect(existsSync(path.join(picked, '.codemapignore'))).toBe(true)
  expect(customIgnore.split('node_modules/').length - 1).toBe(2)
})

test('configured libraryPath is the fallback before auto-detect when nothing is saved', async () => {
  const root = await tempDir()
  const library = path.join(root, 'shared-map')
  const writer = new CodeMapBridge(root, [], prompts(library))
  await writer.createLibrary()
  const reader = new CodeMapBridge(root, [], { ...prompts(), libraryPath: () => 'shared-map' })
  const load = await reader.load(null)
  expect(load.source).toBe('saved')
  expect(load.library).toBe(library)
})

test('cold-start AI and MCP actions stay queued until the webview is ready', () => {
  const hub = new SurfaceHub()
  const events: HostPostEvent[] = []
  expect(hub.send('panel', { kind: 'openAiSettings' })).toBe(false)
  expect(hub.send('panel', { kind: 'askSelection', path: '/repo/src/app.ts', startLine: 4, endLine: 9, mode: 'ask' })).toBe(false)
  expect(hub.send('panel', { kind: 'externalFocus', map: 'checkout', nodes: ['pay'], flow: 'happy', note: 'from mcp' })).toBe(false)
  expect(hub.send('panel', { kind: 'externalProposal', sessionId: 'session-1', changeSetId: 'change-1' })).toBe(false)
  hub.attach('panel', (event) => events.push(event))
  expect(hub.markReady('panel')).toEqual([
    { channel: 'host:openAiSettings', payload: {} },
    { channel: 'host:askSelection', payload: { path: '/repo/src/app.ts', startLine: 4, endLine: 9, mode: 'ask' } },
    { channel: 'host:externalFocus', payload: { map: 'checkout', nodes: ['pay'], flow: 'happy', note: 'from mcp' } },
    { channel: 'host:externalProposal', payload: { sessionId: 'session-1', changeSetId: 'change-1' } }
  ])
  expect(events.map((event) => event.channel)).toEqual(['host:openAiSettings', 'host:askSelection', 'host:externalFocus', 'host:externalProposal'])
  expect(flushReady({ ready: false, pending: [] })).toEqual([])
  expect(
    queueHostAction({ ready: true, pending: [] }, { kind: 'externalProposal', sessionId: 'session-2' })
  ).toEqual({ channel: 'host:externalProposal', payload: { sessionId: 'session-2', changeSetId: undefined } })
})

test('knowledge resolves to the packaged dist folder before the repository folder', async () => {
  const extension = path.resolve(__dirname, '..')
  const packaged = path.join(extension, 'dist', 'agent')
  const fallback = await mkdtemp(path.join(tmpdir(), 'codemap-knowledge-'))
  created.push(fallback)
  expect(resolveAgentKnowledgeDir(extension)).toBe(packaged)
  expect(resolveAgentKnowledgeDir(fallback)).toBe(path.resolve(fallback, '..', 'agent'))
})

test('codemap-mcp.cjs answers initialize over stdio', async () => {
  const script = path.resolve(__dirname, '../dist/codemap-mcp.cjs')
  expect(existsSync(script), 'run the extension build before this smoke test').toBe(true)
  const child = spawn(process.execPath, [script, '--registry-dir', path.join(tmpdir(), 'codemap-mcp-missing'), '--knowledge-dir', path.resolve(__dirname, '../../agent')], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const request = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
  const output = await new Promise<string>((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`MCP CLI timed out: ${text}`))
    }, 8000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      text += chunk
      if (text.includes('"id":7') || text.includes('"id": 7')) {
        clearTimeout(timer)
        child.kill()
        resolve(text)
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdin.end(request + '\n')
  })
  expect(output).toContain('codemap')
  expect(output).toContain('2025-03-26')
})
