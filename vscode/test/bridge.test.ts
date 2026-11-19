import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Script } from 'node:vm'
import { afterEach, expect, test } from 'vitest'
import { translate } from '../src/webview/wrappers/i18n'
import { pathToFileURL } from 'node:url'
import { CodeMapBridge } from '../src/host/bridge'
import { issuesToDiagnostics } from '../src/host/diagnostics'
import { dispatch, request } from '../src/host/rpc'
import { isHostRequest } from '../src/host/protocol'
import { buildWebviewCsp, consumeReady, createWebviewSession, flushReady, queueHostAction, queueReveal, resetWebviewSession, rootElement } from '../src/host/session'
import { checkLibrary } from '../../src/shared/codemap/codemap.mjs'
import { loadLibrary } from '../../src/main/codemap/loadLibrary.mjs'
import { applyNodePatch } from '../../src/main/codemap/writeLayout'

const fixture = path.resolve(__dirname, '../../tests/fixtures/codemap-demo')
const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function prompts(picked: string | null = null, allow = true) {
  return {
    pickFolder: async () => picked,
    confirm: async () => 0,
    quickPick: async (items: { id?: string }[]) => items.find((item) => item.id)?.id ?? null,
    warning: async () => allow
  }
}

test('loads the demo library with nodes, links, flows, todos and diagnostics', async () => {
  const bridge = new CodeMapBridge(fixture, [], prompts())
  const load = await bridge.load(null)
  expect(load.status).toBe('ready')
  expect(load.library).toBe(path.join(fixture, 'library'))
  expect(load.docs.length).toBeGreaterThan(0)
  expect(load.links.length).toBeGreaterThan(0)
  expect(load.requirements.length).toBeGreaterThan(0)
  expect(load.todos.length).toBeGreaterThan(0)
  const checked = checkLibrary(load.docs, load.requirements, load.links)
  expect(checked.model.nodes.size).toBeGreaterThan(0)
  expect(checked.model.flows.size).toBeGreaterThan(0)
  const diagnostics = bridge.diagnostics(load)
  expect(diagnostics.length).toBeGreaterThan(0)
  expect(diagnostics.every((item) => item.file.startsWith(load.library!))).toBe(true)
  expect(new Set(diagnostics.map((item) => item.severity))).toEqual(new Set(['information']))
  expect(new Set(diagnostics.map((item) => item.code)).size).toBeGreaterThan(1)
})

test('writeNode and writeLayout round-trip on a temporary copy', async () => {
  const copy = await mkdtemp(path.join(tmpdir(), 'lumen-codemap-'))
  created.push(copy)
  const { cp } = await import('node:fs/promises')
  await cp(path.join(fixture, 'library'), path.join(copy, 'library'), { recursive: true })
  const bridge = new CodeMapBridge(copy, [], prompts())
  const load = await bridge.load(null)
  const file = 'order-svc/order-svc.yaml'
  const absolute = path.join(load.library!, file)
  const before = await readFile(absolute, 'utf8')
  await bridge.writeNode(file, { node: 'order-svc', fields: { brief: 'temporary brief' } })
  const written = await readFile(absolute, 'utf8')
  expect(written).toContain('temporary brief')
  expect(written).not.toBe(before)
  await bridge.writeLayout(file, { map: 'order-svc', layout: { validate: [12, 34] } })
  const laid = await readFile(absolute, 'utf8')
  expect(laid).toContain('validate: [12, 34]')
  await writeFile(absolute, before, 'utf8')
})

test('external reads stay blocked until a grant, and root or home cannot be granted', async () => {
  const bridge = new CodeMapBridge(path.join(fixture, 'library'), [], prompts(null, true))
  const outside = path.join(fixture, 'demo-repos/order-svc/handler/order.go')
  const denied = await bridge.read(outside)
  expect(denied.ok).toBe(false)
  if (!denied.ok) expect(denied.reason).toBe('access')
  const granted = await bridge.requestAccess(path.join(fixture, 'demo-repos/order-svc'), 'code')
  expect(granted).toBe(true)
  const allowed = await bridge.read(outside)
  expect(allowed.ok).toBe(true)
  const rootGrant = await bridge.requestAccess('/', 'code')
  const homeGrant = await bridge.requestAccess(process.env.HOME || '/tmp', 'code')
  expect(rootGrant).toBe(false)
  expect(homeGrant).toBe(false)
  expect(bridge.access.list().some((grant) => grant === '/' || grant === (process.env.HOME || ''))).toBe(false)
})

test('rpc request and response carry the same request id', async () => {
  const message = request('fs:read', ['order.go'])
  expect(isHostRequest(message)).toBe(true)
  const response = await dispatch(message, {
    'fs:read': async ([file]) => `read:${String(file)}`
  })
  expect(response).toEqual({ type: 'response', requestId: message.requestId, ok: true, value: 'read:order.go' })
  const missing = await dispatch(request('nope'), {})
  expect(missing.ok).toBe(false)
})

test('yaml issues keep the file and the line from the parser', () => {
  const loaded = loadLibrary(path.join(fixture, 'library'))
  const broken = [...loaded.errors, { level: 'error' as const, rule: 'yaml', where: 'order-svc/order-svc.yaml node', msg: 'bad indent (12:4)' }]
  const diagnostics = issuesToDiagnostics(path.join(fixture, 'library'), broken, (...parts) => path.join(...parts))
  const hit = diagnostics.find((item) => item.message.includes('(12:4)'))
  expect(hit?.line).toBe(12)
  expect(hit?.column).toBe(4)
  expect(hit?.file.endsWith('order-svc/order-svc.yaml')).toBe(true)
  expect(hit?.source).toBe('codemap')
  expect(applyNodePatch('id: order-svc\nkind: component\nname: Order\n', { node: 'order-svc', fields: { brief: 'x' } })).toContain('brief: x')
})

test('workspace markup escapes attributes and a cold reveal waits for webview:ready', () => {
  const markup = rootElement('/work/"a&b<c>"', 'map "one"')
  expect(markup).toContain('data-workspace-root="/work/&quot;a&amp;b&lt;c&gt;&quot;"')
  expect(markup).toContain('data-workspace-name="map &quot;one&quot;"')
  expect(markup).not.toContain('data-workspace-root="/work/"a')

  const session = createWebviewSession()
  expect(queueReveal(session, { path: '/repo/src/app.ts', line: 12 })).toBeNull()
  expect(session.pending).toEqual([{ kind: 'revealCode', path: '/repo/src/app.ts', line: 12 }])
  expect(consumeReady(session)).toEqual({ path: '/repo/src/app.ts', line: 12 })
  expect(session.ready).toBe(true)
  expect(session.pending).toEqual([])
  expect(queueReveal(session, { path: '/repo/src/next.ts', line: 4 })).toEqual({ path: '/repo/src/next.ts', line: 4 })
  resetWebviewSession(session)
  expect(session).toEqual({ ready: false, pending: [] })
})

test('cold host actions stay queued until webview:ready, then flush in order', () => {
  const session = createWebviewSession()
  expect(queueHostAction(session, { kind: 'mode', mode: 'map' })).toBeNull()
  expect(queueHostAction(session, { kind: 'revealProject', path: '/repo/src/map.ts' })).toBeNull()
  expect(queueReveal(session, { path: '/repo/src/app.ts', line: 8 })).toBeNull()
  expect(flushReady(session)).toEqual([
    { channel: 'host:mode', payload: { mode: 'map' } },
    { channel: 'host:revealProject', payload: { path: '/repo/src/map.ts' } },
    { channel: 'host:revealCode', payload: { path: '/repo/src/app.ts', line: 8 } }
  ])
  expect(session.pending).toEqual([])
  expect(queueHostAction(session, { kind: 'mode', mode: 'codemap' })).toEqual({ channel: 'host:mode', payload: { mode: 'codemap' } })
  expect(queueHostAction(session, { kind: 'revealProject', path: '/repo/src/town.ts' })).toEqual({
    channel: 'host:revealProject',
    payload: { path: '/repo/src/town.ts' }
  })
  expect(queueReveal(session, { path: '/repo/src/next.ts', line: 3 })).toEqual({ path: '/repo/src/next.ts', line: 3 })
  resetWebviewSession(session)
  expect(consumeReady(session)).toBeNull()
  expect(session).toEqual({ ready: true, pending: [] })
})

test('the packaged webview splits classic workers and loads them lazily', async () => {
  const bundlePath = path.resolve(__dirname, '../dist/webview/assets/webview.js')
  expect(existsSync(bundlePath)).toBe(true)
  const source = readFileSync(bundlePath, 'utf8')
  expect(source).toContain('function __lumenLazyWorker')
  expect(source.length).toBeLessThan(16 * 1024 * 1024)
  expect(source).not.toMatch(/new Worker\(\s*(?:new URL\(\s*["'`]\/assets\/|["'`]\/assets\/)/)
  const checker = await import(pathToFileURL(path.resolve(__dirname, '../scripts/workerCheck.mjs')).href)
  const workers = checker.assertBundledWorkers(path.resolve(__dirname, '..')) as { name: string; code: string }[]
  expect(workers).toHaveLength(6)
  const kinds = ['editor.worker', 'ts.worker', 'json.worker', 'css.worker', 'html.worker', 'layout.worker']
  for (const kind of kinds) expect(workers.some((file) => file.name.includes(kind))).toBe(true)
  for (const file of workers) {
    expect(() => new Script(file.code)).not.toThrow()
    expect(file.code.trimStart().startsWith('import ') || file.code.trimStart().startsWith('export ')).toBe(false)
  }
})

test('webview CSP can fetch lazy workers and the root names its surface', () => {
  const csp = buildWebviewCsp('vscode-webview:', 'abc123')
  expect(csp).toContain("connect-src vscode-webview:")
  expect(csp).toContain('worker-src blob:')
  expect(csp).toContain("default-src 'none'")
  expect(rootElement('/repo', 'side', 'sidebar')).toContain('data-surface="sidebar"')
  expect(rootElement('/repo', 'main', 'panel')).toContain('data-surface="panel"')
})

test('vscode i18n renames Code Map to Architecture Map without touching shared strings', () => {
  expect(translate('zh', 'Code Map')).toBe('架构图')
  expect(translate('en', 'Code Map')).toBe('Architecture Map')
  expect(translate('zh', 'Code Map (⇧⌘Y)')).toBe('架构图 (⇧⌘Y)')
  expect(translate('zh', 'Reading the code map')).toBe('正在读取架构图')
  expect(translate('zh', 'No code map loaded')).toBe('还没有读取架构图')
  expect(translate('zh', 'Code map of {name}', { name: 'checkout' })).toBe('checkout 的架构图')
  expect(translate('zh', 'Architecture')).toBe('架构')
  expect(translate('en', 'Architecture')).toBe('Arch')
  expect(translate('zh', 'Map')).toBe('地图')
  expect(translate('en', 'Project Map')).toBe('Project Map')
  expect(translate('zh', 'Save')).toBe('保存')
})
