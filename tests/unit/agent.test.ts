import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, safeStorage: { isEncryptionAvailable: () => false } }))

const { checkChangeSet, runTool, toolsFor } = await import('../../src/main/agent/tools')
const { knowledgeFor, systemPrompt } = await import('../../src/main/agent/prompts')

const fixture = path.join(__dirname, '../fixtures/codemap-demo/library')

function copyLibrary(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'codemap-agent-'))
  cpSync(fixture, dir, { recursive: true })
  cpSync(path.join(fixture, '../demo-repos'), path.join(dir, '../demo-repos'), { recursive: true })
  return dir
}

const env = (library: string, mode: 'ask' | 'adjust' = 'ask') => {
  const focus: unknown[] = []
  const proposals: unknown[] = []
  return {
    focus,
    proposals,
    env: {
      library,
      mode,
      access: { allowed: (p: string) => p.startsWith(path.dirname(library)) } as never,
      focus: (map: string | null, nodes: string[]) => focus.push({ map, nodes }),
      propose: (input: Record<string, unknown>) => {
        const set = { ...input, id: 'x', sessionId: 's', status: 'proposed', problems: checkChangeSet(library, input as never) }
        proposals.push(set)
        return set as never
      },
      gate: () => undefined
    }
  }
}

describe('agent tools', () => {
  it('reads the library: overview, nodes, code', async () => {
    const lib = copyLibrary()
    const { env: e } = env(lib)
    const defs = toolsFor('ask')
    expect(defs.some((d) => d.spec.name === 'propose_change_set')).toBe(false)
    const overview = await runTool(defs, e, 'map_overview', {})
    expect(overview.ok).toBe(true)
    expect(overview.content).toContain('order-system')
    const node = await runTool(defs, e, 'read_node', { id: 'order-svc' })
    expect(node.content).toContain('## edges')
    expect(node.content).toContain('create-order')
    const code = await runTool(defs, e, 'read_node_code', { id: 'order-svc.build-order' })
    expect(code.ok).toBe(true)
    expect(code.content).toMatch(/\d+  /)
    const found = await runTool(defs, e, 'find_nodes', { query: 'releaser' })
    expect(found.content).toContain('order-svc.releaser')
  })

  it('refuses to read outside allowed folders', async () => {
    const lib = copyLibrary()
    const { env: e } = env(lib)
    const res = await runTool(toolsFor('ask'), e, 'read_file', { path: '/etc/hosts' })
    expect(res.ok).toBe(false)
  })

  it('show_on_map only accepts maps and known nodes', async () => {
    const lib = copyLibrary()
    const { env: e, focus } = env(lib)
    const bad = await runTool(toolsFor('ask'), e, 'show_on_map', { map: 'order-svc.save' })
    expect(bad.ok).toBe(false)
    await runTool(toolsFor('ask'), e, 'show_on_map', { map: 'order-svc', nodes: ['order-svc.save', 'nope'] })
    expect(focus).toEqual([{ map: 'order-svc', nodes: ['order-svc.save'] }])
  })

  it('checks a change set: a clean rename passes, a broken edge is reported', async () => {
    const lib = copyLibrary()
    const clean = checkChangeSet(lib, { changes: [{ modify: 'node', id: 'order-svc.save', set: { name: '保存订单' } }], files: {} })
    expect(clean.filter((p) => p.level === 'error')).toEqual([])
    const broken = checkChangeSet(lib, { changes: [{ add: 'edge', at: 'order-svc', value: { from: 'save', to: 'no-such-node' } }], files: {} })
    expect(broken.some((p) => p.level === 'error')).toBe(true)
  })

  it('checks whole new files too', async () => {
    const lib = copyLibrary()
    const problems = checkChangeSet(lib, { changes: [], files: { 'x/x.yaml': 'schema: codemap/v1\nid: x\nkind: component\n' } })
    expect(problems.some((p) => p.rule === 'node-name')).toBe(true)
    const yamlError = checkChangeSet(lib, { changes: [], files: { 'y/y.yaml': 'id: [' } })
    expect(yamlError[0].rule).toBe('yaml')
  })
})

describe('agent prompts', () => {
  it('reads the knowledge folder, skipping empty files', async () => {
    const lib = copyLibrary()
    const kdir = mkdtempSync(path.join(tmpdir(), 'codemap-knowledge-'))
    mkdirSync(path.join(kdir, 'ask'), { recursive: true })
    mkdirSync(path.join(kdir, 'domain'), { recursive: true })
    writeFileSync(path.join(kdir, 'ask/guide.md'), '回答时先说结论。')
    writeFileSync(path.join(kdir, 'domain/README.md'), '')
    process.env.CODEMAP_AGENT_DIR = kdir
    const k = await knowledgeFor('ask')
    expect(k).toContain('回答时先说结论')
    expect(k).not.toContain('domain/README.md')
    expect(await knowledgeFor('adjust')).toBe('')
    const sys = await systemPrompt(lib, 'ask', { stack: ['order-system', 'order-svc'], selected: ['order-svc.save'], flow: null })
    expect(sys).toContain('Mode: Ask')
    expect(sys).toContain('order-svc.save')
    expect(sys).toContain('回答时先说结论')
  })
})

describe('merge into base', () => {
  it('applyRequirement returns the edited docs', async () => {
    const { applyRequirement } = await import('../../src/shared/codemap/codemap.mjs')
    const { loadLibrary } = await import('../../src/main/codemap/loadLibrary.mjs')
    const lib = copyLibrary()
    const loaded = loadLibrary(lib)
    const out = applyRequirement(loaded.docs, { file: 'x', changes: [{ modify: 'node', id: 'order-svc.save', set: { name: '保存订单' } }] }, loaded.links)
    const doc = out.docs!.find((d) => d.node.id === 'order-svc')!
    expect(JSON.stringify(doc.node)).toContain('保存订单')
    expect(JSON.stringify(loaded.docs.find((d) => d.node.id === 'order-svc')!.node)).not.toContain('保存订单')
    void readFileSync
  })
})

describe('rewriteNodeFile', () => {
  it('keeps comments and only changes what changed', async () => {
    const { rewriteNodeFile } = await import('../../src/main/agent/rewrite')
    const yaml = await import('js-yaml')
    const text = readFileSync(path.join(fixture, 'order-svc/order-svc.yaml'), 'utf8')
    const node = yaml.load(text) as any
    const save = node.contains.find((c: any) => c.id === 'save')
    save.name = '保存订单'
    node.contains.push({ id: 'audit', kind: 'function', name: '审计' })
    const out = rewriteNodeFile(text, node)
    expect(out).toContain('保存订单')
    expect(out).toContain('# ---------- 作为地图 ----------')
    expect(out).toContain('# 第二个入口：消费支付成功事件')
    expect(yaml.load(out)).toEqual(node)
    const before = text.split('\n').length
    expect(Math.abs(out.split('\n').length - before)).toBeLessThan(8)
  })
})
