import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// The run loop against a scripted model: no network. Each test sets script to a function
// that answers one model call from the request it gets.
const userData = mkdtempSync(path.join(tmpdir(), 'codemap-loop-'))
vi.mock('electron', () => ({ app: { getPath: () => userData, isPackaged: false, getAppPath: () => process.cwd() }, safeStorage: { isEncryptionAvailable: () => false } }))

type Req = { system: string; messages: Array<{ role: string; content: any[] }> }
type Reply = { blocks: any[]; stop: string }
let script: (req: Req, n: number) => Promise<Reply> | Reply = () => ({ blocks: [], stop: 'end' })
let calls = 0
vi.mock('../../src/main/agent/providers', async (orig) => ({
  ...(await orig<typeof import('../../src/main/agent/providers')>()),
  callModel: async (_p: unknown, _k: unknown, req: Req) => ({ ...(await script(req, calls++)), usage: { input: 1, output: 1 } })
}))
vi.mock('../../src/main/agent/settings', () => ({
  rawAgentSettings: async () => ({ providers: [], activeProvider: 'x', modeModels: {}, maxParallel: 2 }),
  resolveProvider: async () => ({ provider: { id: 'x', name: 'x', kind: 'anthropic', baseUrl: 'http://x', keySource: 'stored', model: 'm' }, key: 'k' })
}))

const { getSession, startRun, stopRun } = await import('../../src/main/agent/runtime')

function library(): { library: string; access: never } {
  const dir = mkdtempSync(path.join(tmpdir(), 'codemap-loop-lib-'))
  cpSync(path.join(__dirname, '../fixtures/codemap-demo'), dir, { recursive: true })
  return { library: path.join(dir, 'library'), access: { allowed: (p: string) => p.startsWith(dir) } as never }
}

function run(mode: 'ask' | 'create', message: string, lib = library()) {
  const events: any[] = []
  let resolve!: (r: string) => void
  const done = new Promise<string>((r) => (resolve = r))
  const id = startRun(lib.library, lib.access, { mode, message, context: { stack: [], selected: [], flow: null } }, (e) => {
    events.push(e)
    if (e.type === 'done') resolve(e.reason)
  })
  return { events, done, id }
}

const text = (t: string) => ({ type: 'text', text: t })
const tool = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: 'c' + Math.random().toString(36).slice(2, 8), name, input })
const lastContent = (req: Req) => JSON.stringify(req.messages[req.messages.length - 1].content)
const has = (req: Req, f: (b: any) => boolean) => req.messages.some((m) => m.content.some(f))

describe('agent run loop', () => {
  it('has no turn limit', async () => {
    calls = 0
    script = (_req, n) => (n < 60 ? { blocks: [tool('map_overview', {})], stop: 'tool' } : { blocks: [text('done')], stop: 'end' })
    const r = run('ask', 'walk around')
    expect(await r.done).toBe('end')
    expect(calls).toBe(61)
  })

  it('continues after a reply cut off by the output limit', async () => {
    calls = 0
    const seen: string[] = []
    script = (req, n) => {
      seen.push(lastContent(req))
      if (n === 0) return { blocks: [text('Now I propose the whole map'), tool('propose_change_set', { title: 'half' })], stop: 'length' }
      return { blocks: [text('finished')], stop: 'end' }
    }
    const r = run('ask', 'build it')
    expect(await r.done).toBe('end')
    expect(calls).toBe(2)
    expect(seen[1]).toContain('cut off')
    // The half-written tool call was dropped, not run.
    expect(r.events.some((e) => e.type === 'tool')).toBe(false)
  })

  it('reads a message the user sends while the run goes', async () => {
    calls = 0
    let release!: () => void
    const wait = new Promise<void>((r) => (release = r))
    const seen: string[] = []
    script = async (req, n) => {
      seen.push(lastContent(req))
      if (n === 0) {
        await wait
        return { blocks: [tool('map_overview', {})], stop: 'tool' }
      }
      return { blocks: [text('ok')], stop: 'end' }
    }
    const lib = library()
    const r = run('ask', 'first', lib)
    const id = await r.id
    await startRun(lib.library, lib.access, { mode: 'ask', message: 'also look at stock', context: { stack: [], selected: [], flow: null }, sessionId: id }, () => undefined)
    release()
    expect(await r.done).toBe('end')
    // Picked up before the next model call (whichever call comes after it was sent).
    expect(seen.join('\n')).toContain('also look at stock')
  })

  it('nudges a sub-agent that only talks until it proposes files', async () => {
    calls = 0
    script = (req) => {
      if (!req.system.includes('You are a sub-agent')) {
        if (!has(req, (b) => b.type === 'tool_use' && b.name === 'delegate_nodes')) return { blocks: [tool('delegate_nodes', { tasks: [{ node: 'order-svc', instructions: 'break down order-svc' }] })], stop: 'tool' }
        return { blocks: [text('main done')], stop: 'end' }
      }
      if (!has(req, (b) => b.type === 'text' && /not proposed any file/.test(b.text))) return { blocks: [text("I'll start by reading the context.")], stop: 'end' }
      if (!has(req, (b) => b.type === 'tool_use' && b.name === 'propose_change_set'))
        return { blocks: [tool('propose_change_set', { title: 'order-svc map', summary: 's', files: { 'order-svc/notes.md': '# x' } })], stop: 'tool' }
      return { blocks: [text('drew order-svc')], stop: 'end' }
    }
    const r = run('create', 'break down order-svc')
    expect(await r.done).toBe('end')
    expect(r.events.filter((e) => e.type === 'changeset')).toHaveLength(1)
    expect(r.events.filter((e) => e.type === 'worker-step').map((e) => e.label).join(' | ')).toContain('order-svc map')
    expect(r.events.find((e) => e.type === 'worker' && e.state === 'done')).toBeTruthy()
  })

  it('tells the model when delegate_nodes gets no tasks', async () => {
    calls = 0
    const seen: string[] = []
    script = (req, n) => {
      seen.push(lastContent(req))
      return n === 0 ? { blocks: [tool('delegate_nodes', {})], stop: 'tool' } : { blocks: [text('ok')], stop: 'end' }
    }
    const r = run('create', 'go')
    expect(await r.done).toBe('end')
    expect(seen[1]).toContain('No tasks given')
  })

  it('grows one proposal with extend until a split node and its parent pass together', async () => {
    calls = 0
    const child = ['schema: codemap/v1', 'id: warehouse-system.wms', 'kind: component', 'name: 仓储服务', 'repo: git@git.example.com:shop/wms-svc.git', 'contains:', '  - { id: inbound, kind: component, name: 入库 }'].join('\n')
    const parent = [
      'schema: codemap/v1', 'id: warehouse-system', 'kind: component', 'name: 仓储系统', 'review: { status: draft }',
      'contains:', '  - warehouse-system.wms', '  - inventory-svc',
      'edges:', '  - { from: warehouse-system.wms, to: inventory-svc, kind: call, name: 入库加库存, via: inventory-svc.AddStock }'
    ].join('\n')
    const replies: string[] = []
    script = (req, n) => {
      if (n > 0) replies.push(lastContent(req))
      if (n === 0) return { blocks: [tool('propose_change_set', { title: 'split wms', summary: 'child map', files: { 'warehouse-system/wms/wms.yaml': child } })], stop: 'tool' }
      if (n === 1) {
        const id = /Proposal (\w+)/.exec(replies[0])![1]
        return { blocks: [tool('propose_change_set', { title: 'parent', summary: 'parent refers to it', extend: id, files: { 'warehouse-system/warehouse-system.yaml': parent } })], stop: 'tool' }
      }
      return { blocks: [text('done')], stop: 'end' }
    }
    const r = run('create', 'split wms')
    expect(await r.done).toBe('end')
    // Alone, the child map clashes with the inline node on the parent.
    expect(replies[0]).toContain('id-unique')
    // Together they pass, and it is still one proposal.
    expect(replies[1]).toContain('found no problems')
    const sets = r.events.filter((e) => e.type === 'changeset').map((e) => e.changeSet)
    expect(new Set(sets.map((s) => s.id)).size).toBe(1)
    expect(Object.keys(sets[sets.length - 1].files)).toHaveLength(2)
  })

  it('sends the agent back while its own proposal still fails the checker', async () => {
    calls = 0
    const bad = ['schema: codemap/v1', 'id: warehouse-system.wms', 'kind: component', 'name: 仓储服务', 'contains:', '  - { id: a, kind: function, name: A }'].join('\n')
    const good = ['schema: codemap/v1', 'id: warehouse-system.wms', 'kind: component', 'name: 仓储服务', 'contains:', '  - { id: a, kind: component, name: A }'].join('\n')
    const parent = ['schema: codemap/v1', 'id: warehouse-system', 'kind: component', 'name: 仓储系统', 'review: { status: draft }', 'contains:', '  - warehouse-system.wms', '  - inventory-svc', 'edges:', '  - { from: warehouse-system.wms, to: inventory-svc, kind: call, name: 入库加库存, via: inventory-svc.AddStock }'].join('\n')
    let id = ''
    const seen: string[] = []
    script = (req, n) => {
      seen.push(lastContent(req))
      if (n === 0) return { blocks: [tool('propose_change_set', { title: 'wms', summary: 's', files: { 'warehouse-system/wms/wms.yaml': bad, 'warehouse-system/warehouse-system.yaml': parent } })], stop: 'tool' }
      if (n === 1) {
        id = /Proposal (\w+)/.exec(seen[1])![1]
        return { blocks: [text('Done, please review.')], stop: 'end' }
      }
      if (n === 2) return { blocks: [tool('propose_change_set', { title: 'wms', summary: 'fixed', extend: id, files: { 'warehouse-system/wms/wms.yaml': good } })], stop: 'tool' }
      return { blocks: [text('fixed')], stop: 'end' }
    }
    const r = run('create', 'split wms')
    expect(await r.done).toBe('end')
    expect(seen[2]).toContain('still have checker errors')
    const last = r.events.filter((e) => e.type === 'changeset').pop().changeSet
    expect(last.problems.filter((p: any) => p.level === 'error')).toHaveLength(0)
  })

  it('refuses a review gate while a proposal still has checker errors', async () => {
    calls = 0
    const bad = ['schema: codemap/v1', 'id: warehouse-system.wms', 'kind: component', 'name: 仓储服务', 'contains:', '  - { id: a, kind: function, name: A }'].join('\n')
    const seen: string[] = []
    script = (req, n) => {
      seen.push(lastContent(req))
      if (n === 0) return { blocks: [tool('propose_change_set', { title: 'wms', summary: 's', files: { 'warehouse-system/wms/wms.yaml': bad } })], stop: 'tool' }
      if (n === 1) return { blocks: [tool('review_gate', { stage: 'L1', summary: 'please review' })], stop: 'tool' }
      return { blocks: [text('ok')], stop: 'end' }
    }
    const r = run('create', 'go')
    await r.done
    expect(seen[2]).toContain('still have checker errors')
    expect(r.events.some((e) => e.type === 'gate')).toBe(false)
  })

  it('keeps a conversation in the mode it was started in', async () => {
    calls = 0
    script = () => ({ blocks: [text('ok')], stop: 'end' })
    const lib = library()
    const r = run('create', 'build it', lib)
    const id = await r.id
    await r.done
    await expect(startRun(lib.library, lib.access, { mode: 'ask', message: 'a question', context: { stack: [], selected: [], flow: null }, sessionId: id }, () => undefined)).rejects.toThrow(/belongs to the create mode/)
    expect((await getSession(lib.library, id)).mode).toBe('create')
  })

  it('saves the build sources with the conversation and reuses them', async () => {
    calls = 0
    const systems: string[] = []
    script = (req) => {
      systems.push(req.system)
      return { blocks: [text('ok')], stop: 'end' }
    }
    const lib = library()
    const events: any[] = []
    let done!: () => void
    let finished = new Promise<void>((r) => (done = r))
    const emit = (e: any) => {
      events.push(e)
      if (e.type === 'done') done()
    }
    const context = { stack: [], selected: [], flow: null, repos: ['/repo/order-svc'], docs: [{ kind: 'url' as const, value: 'https://wiki/x' }], output: 'shop' }
    const id = await startRun(lib.library, lib.access, { mode: 'create', message: 'build', context }, emit)
    await finished
    expect((await getSession(lib.library, id)).sources).toEqual({ repos: ['/repo/order-svc'], docs: [{ kind: 'url', value: 'https://wiki/x' }], output: 'shop' })
    // A later message without sources (e.g. "Approved") still works from them.
    finished = new Promise<void>((r) => (done = r))
    await startRun(lib.library, lib.access, { mode: 'create', message: 'Approved', context: { stack: [], selected: [], flow: null }, sessionId: id }, emit)
    await finished
    expect(systems[1]).toContain('/repo/order-svc')
  })

  it('ends a stopped run with reason stopped and marks unfinished steps', async () => {
    calls = 0
    let entered!: () => void
    const inCall = new Promise<void>((r) => (entered = r))
    script = (req, n) => {
      if (n === 0) return { blocks: [tool('map_overview', {})], stop: 'tool' }
      entered()
      // Like a real request: hangs until the run is stopped, then rejects.
      const signal = (req as unknown as { signal: AbortSignal }).signal
      return new Promise((_res, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }
    const lib = library()
    const r = run('ask', 'look around', lib)
    const id = await r.id
    await inCall
    stopRun(id)
    expect(await r.done).toBe('stopped')
    expect(r.events.some((e) => e.type === 'phase')).toBe(true)
    const s = await getSession(lib.library, id)
    expect(s.messages[s.messages.length - 1].end).toBe('stopped')
  })
})
