import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { applyLayoutPatch, applyNodePatch } from '../../src/main/codemap/writeLayout'

const changedLines = (a: string, b: string) => {
  const x = a.split('\n')
  const y = b.split('\n')
  return y.filter((line, i) => line !== x[i]).length
}

const SAMPLE = `schema: codemap/v1
id: shop   # the map
kind: component
name: Shop
contains:
  - a
  - id: b
    kind: function
    name: B
    contains:
      - { id: c, kind: function, name: C }
    edges:
      - { from: c, to: a }
lanes:
  - { id: main, name: Main, nodes: [a, b] }

# calls
edges:
  - { from: a, to: b, kind: call }   # inline edge
  - from: b
    to: a
    kind: return
  - { id: again, from: a, to: b, kind: next }
`

describe('applyLayoutPatch', () => {
  it('inserts layout before edges and keeps everything else byte for byte', () => {
    const out = applyLayoutPatch(SAMPLE, { map: 'shop', layout: { a: [100.4, 200], b: [300, 200] } })
    expect(out).toContain('lanes:\n  - { id: main, name: Main, nodes: [a, b] }\n\nlayout:\n  a: [100, 200]\n  b: [300, 200]\n\n# calls\nedges:')
    expect(out.replace(/layout:\n(  .*\n)+\n/, '')).toBe(SAMPLE)
    expect((yaml.load(out) as any).layout).toEqual({ a: [100, 200], b: [300, 200] })
  })

  it('replaces an existing layout and removes it on reset', () => {
    const once = applyLayoutPatch(SAMPLE, { map: 'shop', layout: { a: [1, 2] } })
    const twice = applyLayoutPatch(once, { map: 'shop', layout: { a: [10, 20], b: [30, 40] } })
    expect((yaml.load(twice) as any).layout).toEqual({ a: [10, 20], b: [30, 40] })
    expect(twice.match(/layout:/g)).toHaveLength(1)
    const reset = applyLayoutPatch(twice, { map: 'shop', layout: null })
    expect(reset).toBe(SAMPLE)
  })

  it('adds, changes, and removes ports on inline and block edges', () => {
    let out = applyLayoutPatch(SAMPLE, { map: 'shop', ports: { 'a->b': ['bottom', 'top'], 'b->a': ['right', null], again: ['left', 'left'] } })
    const doc = yaml.load(out) as any
    expect(doc.edges[0].ports).toEqual(['bottom', 'top'])
    expect(doc.edges[1].ports).toEqual(['right'])
    expect(doc.edges[2].ports).toEqual(['left', 'left'])
    expect(out).toContain('{ from: a, to: b, kind: call, ports: [bottom, top] }   # inline edge')
    expect(changedLines(SAMPLE, out)).toBeLessThanOrEqual(4)
    out = applyLayoutPatch(out, { map: 'shop', ports: { 'a->b': ['left', 'right'], 'b->a': null, again: null } })
    const doc2 = yaml.load(out) as any
    expect(doc2.edges[0].ports).toEqual(['left', 'right'])
    expect(doc2.edges[1].ports).toBeUndefined()
    expect(doc2.edges[2].ports).toBeUndefined()
    expect(applyLayoutPatch(out, { map: 'shop', ports: { 'a->b': null } })).toBe(SAMPLE)
  })

  it('writes into a map defined inline under contains', () => {
    const out = applyLayoutPatch(SAMPLE, { map: 'shop.b', layout: { c: [5, 6] }, ports: { 'c->a': ['top', 'bottom'] } })
    const doc = yaml.load(out) as any
    expect(doc.contains[1].layout).toEqual({ c: [5, 6] })
    expect(doc.contains[1].edges[0].ports).toEqual(['top', 'bottom'])
    expect(doc.layout).toBeUndefined()
  })

  it('keeps comments and layout of a real library file', () => {
    const file = path.join(__dirname, '../fixtures/codemap-demo/library/order-svc/order-svc.yaml')
    const text = fs.readFileSync(file, 'utf8')
    const out = applyLayoutPatch(text, { map: 'order-svc', layout: { validate: [10, 20] }, ports: { 'validate->lock-stock': ['right', 'left'] } })
    // Every original line survives in order; the only additions are the layout block and the ports.
    const before = yaml.load(text) as any
    const after = yaml.load(out) as any
    expect(after.layout).toEqual({ validate: [10, 20] })
    const edge = after.edges.find((e: any) => e.from === 'validate' && e.to === 'lock-stock')
    expect(edge.ports).toEqual(['right', 'left'])
    delete after.layout
    delete edge.ports
    expect(after).toEqual(before)
    const comments = (s: string) => s.split('\n').filter((l) => l.includes('#'))
    expect(comments(out).filter((l) => !l.includes('ports:'))).toEqual(comments(text))
    expect(applyLayoutPatch(out, { map: 'order-svc', layout: null, ports: { 'validate->lock-stock': null } })).toBe(text)
  })

  it('refuses a map that is not in the file', () => {
    expect(() => applyLayoutPatch(SAMPLE, { map: 'other', layout: { a: [1, 1] } })).toThrow()
  })
})

describe('node field edits', () => {
  const WAIT = `schema: codemap/v1
id: order-svc.create.wait
kind: component
name: 挂起等结果
brief: waitResult · buildCreateOrderResponse
review: { status: draft }

# 节点
contains:
  - id: wait
    kind: function
    name: 挂起，等这一轮结束
    brief: responseV2
    desc: "四路等待：加入完成通知、本节点回调。"
    fn: { repo: { remote: "git@x:y.git", local: ../y }, code: a.go:1-9, trigger: func }
  - { id: renew, kind: function, name: 续闹钟, fn: { code: a.go:3, outcome: success } }   # 收尾
`
  const read = (text: string, id: string) => {
    const doc = yaml.load(text) as any
    return id === doc.id ? doc : doc.contains.find((c: any) => c.id === id.split('.').pop())
  }

  it('edits block fields in place and keeps every other line', () => {
    const out = applyNodePatch(WAIT, { node: 'order-svc.create.wait.wait', fields: { name: '挂起：等这一轮结束', desc: '三路等待: 通知 # 回调', 'fn.trigger': 'grpc' } })
    const n = read(out, 'order-svc.create.wait.wait')
    expect(n.name).toBe('挂起：等这一轮结束')
    expect(n.desc).toBe('三路等待: 通知 # 回调')
    expect(n.fn.trigger).toBe('grpc')
    expect(n.fn.code).toBe('a.go:1-9')
    expect(changedLines(WAIT, out)).toBe(3)
    expect(out).toContain('# 节点')
  })

  it('adds and removes keys, in block and flow maps', () => {
    let out = applyNodePatch(WAIT, { node: 'order-svc.create.wait.renew', fields: { brief: 'Renew()', 'fn.outcome': null, desc: '多行\n说明' } })
    let n = read(out, 'order-svc.create.wait.renew')
    expect(n.brief).toBe('Renew()')
    expect(n.desc).toBe('多行\n说明')
    expect(n.fn.outcome).toBeUndefined()
    expect(out).toContain('# 收尾')
    out = applyNodePatch(WAIT, { node: 'order-svc.create.wait.wait', fields: { brief: '', 'fn.outcome': 'error' } })
    n = read(out, 'order-svc.create.wait.wait')
    expect(n.brief).toBeUndefined()
    expect(n.fn.outcome).toBe('error')
    // The top-level node.
    out = applyNodePatch(WAIT, { node: 'order-svc.create.wait', fields: { desc: '下单挂起' } })
    expect(read(out, 'order-svc.create.wait').desc).toBe('下单挂起')
    expect(out.split('\n')[4]).toBe('brief: waitResult · buildCreateOrderResponse')
  })

  it('refuses unknown fields and nodes defined elsewhere', () => {
    expect(() => applyNodePatch(WAIT, { node: 'order-svc.create.wait.wait', fields: { kind: 'x' } })).toThrow()
    expect(() => applyNodePatch(WAIT, { node: 'order-svc.other', fields: { name: 'x' } })).toThrow()
  })
})
