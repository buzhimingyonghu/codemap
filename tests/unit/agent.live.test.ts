import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Live check against the local model gateway. Skipped unless CODEMAP_LIVE_AGENT=1.
const userData = mkdtempSync(path.join(tmpdir(), 'codemap-live-'))
vi.mock('electron', () => ({ app: { getPath: () => userData }, safeStorage: { isEncryptionAvailable: () => false } }))

const live = process.env.CODEMAP_LIVE_AGENT === '1'

describe.skipIf(!live)('agent against the local gateway', () => {
  it('answers a question and follows the map', async () => {
    const { startRun } = await import('../../src/main/agent/runtime')
    const fixture = path.join(__dirname, '../fixtures/codemap-demo')
    const dir = mkdtempSync(path.join(tmpdir(), 'codemap-live-lib-'))
    cpSync(fixture, dir, { recursive: true })
    const library = path.join(dir, 'library')
    const events: any[] = []
    const done = new Promise<void>((resolve) => {
      const access = { allowed: (p: string) => p.startsWith(dir) } as never
      void startRun(library, access, { mode: 'ask', message: '下单时库存不足会怎么样？用一两句话回答，并在地图上指出相关节点。', context: { stack: ['order-system'], selected: [], flow: null } }, (e) => {
        events.push(e)
        if (e.type === 'done') resolve()
      })
    })
    await done
    const kinds = events.map((e) => e.type)
    console.log(events.filter((e) => e.type === 'tool').map((e) => e.label).join(' | '))
    console.log(events.filter((e) => e.type === 'text').map((e) => e.text).join('\n'))
    console.log(JSON.stringify(events.filter((e) => e.type === 'focus')))
    expect(kinds).toContain('tool')
    expect(kinds).toContain('text')
    expect(events.find((e) => e.type === 'done').reason).toBe('end')
  }, 240_000)
  it('proposes a change set in adjust mode and applies it', async () => {
    const { startRun, applyChangeSet } = await import('../../src/main/agent/runtime')
    const { loadLibrary } = await import('../../src/main/codemap/loadLibrary.mjs')
    const fixture = path.join(__dirname, '../fixtures/codemap-demo')
    const dir = mkdtempSync(path.join(tmpdir(), 'codemap-live-lib-'))
    cpSync(fixture, dir, { recursive: true })
    const library = path.join(dir, 'library')
    const events: any[] = []
    let sessionId = ''
    await new Promise<void>((resolve) => {
      const access = { allowed: (p: string) => p.startsWith(dir) } as never
      void startRun(library, access, { mode: 'adjust', message: '把 order-svc 里「落库」这个节点改名为「保存订单」，其他不动。', context: { stack: ['order-system', 'order-svc'], selected: ['order-svc.save'], flow: null } }, (e) => {
        events.push(e)
        if (e.type === 'session') sessionId = e.sessionId
        if (e.type === 'done') resolve()
      })
    })
    console.log(events.filter((e) => e.type === 'tool').map((e) => e.label).join(' | '))
    const sets = events.filter((e) => e.type === 'changeset').map((e) => e.changeSet)
    console.log(JSON.stringify(sets.map((s) => ({ changes: s.changes, files: Object.keys(s.files), problems: s.problems }))))
    expect(sets.length).toBeGreaterThan(0)
    const last = sets[sets.length - 1]
    const written = await applyChangeSet(library, dir, sessionId, last.id)
    console.log('written', written)
    const after = loadLibrary(library)
    const svc = after.docs.find((d: any) => d.node.id === 'order-svc')!.node
    expect(JSON.stringify(svc)).toContain('保存订单')
  }, 240_000)
})
