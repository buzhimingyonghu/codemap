import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkLibrary } from '@shared/codemap/codemap.mjs'
import { loadLibrary } from '../../src/main/codemap/loadLibrary.mjs'
import { CodemapAccess, findLibraries, grantable, isLibrary } from '../../src/main/codemap/service'
import { computeLayout, edgeGeometry, fitText, loopFrameRect } from '../../src/renderer/src/codemap/layout'
import {
  buildView,
  changedCounts,
  collectTodos,
  containersOf,
  defaultRoot,
  filledFields,
  isMap,
  refinedFlowIn,
  refiningFlow,
  stepsOf,
  structCard,
  type MapContext
} from '../../src/renderer/src/codemap/model'

const FIXTURE = path.join(__dirname, '../fixtures/codemap-demo/library')
const lib = loadLibrary(FIXTURE)
const check = checkLibrary(lib.docs, lib.requirements, lib.links)
const ctx = (reqOn = false): MapContext => ({ check, reqIndex: 0, reqOn })

describe('code map view model', () => {
  it('opens the biggest top-level map first', () => {
    expect(defaultRoot(check)).toBe('order-system')
    expect(isMap(ctx(), 'order-svc')).toBe(true)
    expect(containersOf(ctx(), 'inventory-svc').sort()).toEqual(['order-system', 'warehouse-system'])
  })

  it('builds a map with edges and flows whose steps sit on edges', () => {
    const v = buildView(ctx(), 'order-svc')!
    expect(v.members.length).toBeGreaterThan(5)
    expect(v.flows.map((f) => f.id)).toContain('create-ok')
    const steps = stepsOf(v, 'create-ok')
    expect(steps.length).toBeGreaterThan(3)
    expect(steps.filter((s) => s.from).every((s) => s.edge)).toBe(true)
  })

  it('connects flows across levels', () => {
    const sub = refiningFlow(ctx(), 'order-svc', 'order-system.place-order')
    expect(sub?.id).toBe('create-ok')
    expect(refinedFlowIn(ctx(), 'order-system', 'order-svc', 'create-ok')).toBe('place-order')
  })

  it('fills the struct card as the function flow plays', () => {
    const v = buildView(ctx(), 'order-svc.build-order')!
    const flowId = v.flows[0].id
    const card = structCard(v, flowId)
    expect(card?.name).toBe('Order')
    const steps = stepsOf(v, flowId)
    expect(filledFields(v, steps, -1).size).toBe(0)
    expect(filledFields(v, steps, steps.length - 1).size).toBeGreaterThan(2)
  })

  it('overlays the requirement with marks and badge counts', () => {
    const off = buildView(ctx(false), 'order-svc.build-order')!
    const on = buildView(ctx(true), 'order-svc.build-order')!
    expect(on.members.length).toBe(off.members.length)
    expect([...on.status.values()]).toContain('add')
    expect(changedCounts(ctx(true)).get('order-svc')).toBeGreaterThan(0)
  })

  it('lays out every node inside the bounding box and chooses a direction', () => {
    for (const id of check.model.members.keys()) {
      const v = buildView(ctx(), id)!
      const layout = computeLayout(v, { width: 1000, height: 600 })
      for (const member of [...v.members, ...v.outside]) {
        const p = layout.pos.get(member)
        expect(p, `${id}: ${member}`).toBeTruthy()
        expect(p!.x - p!.w / 2).toBeGreaterThanOrEqual(layout.box.x)
        expect(p!.x + p!.w / 2).toBeLessThanOrEqual(layout.box.x + layout.box.w)
      }
    }
  })

  it('marks a business line whose via has a heartbeat link', () => {
    const v = buildView(ctx(), 'order-system')!
    const beat = v.edges.find((e) => e.from === 'inventory-svc' && e.to === 'order-system.registry')!
    expect(beat.beats).toEqual([{ api: 'inventory-svc.Beat', name: 'PUT /nacos/v1/ns/instance/beat', period: '5s' }])
    // Drawn as an ordinary line, not a heartbeat-only line.
    expect(beat.hb).toBe(false)
    expect(v.edges.filter((e) => e.beats.length).length).toBe(1)
  })

  it('finds a for loop from the cycle of ordinary lines, with its back lines', () => {
    const v = buildView(ctx(), 'order-svc.releaser')!
    expect(v.loops).toHaveLength(1)
    const loop = v.loops[0]
    expect(loop.id).toBe('order-svc.releaser.wait')
    expect([...loop.nodes].sort()).toEqual(['check', 'on-paid', 'on-tick', 'release', 'wait'].map((x) => `order-svc.releaser.${x}`).sort())
    // Lines back to the wait node; the exit to stop and the entry are not part of the loop.
    expect([...loop.back].sort()).toEqual(['order-svc.releaser.check->order-svc.releaser.wait', 'order-svc.releaser.on-paid->order-svc.releaser.wait', 'order-svc.releaser.release->order-svc.releaser.wait'])
    expect(loop.nodes).not.toContain('order-svc.releaser.stop')
    expect(loop.lines).toEqual([17, 29])
    // A map without a cycle has no loops.
    expect(buildView(ctx(), 'order-svc')!.loops).toEqual([])
  })

  it('makes room for the loop frame in the layout bounds', () => {
    const v = buildView(ctx(), 'order-svc.releaser')!
    const layout = computeLayout(v, { width: 1200, height: 700 })
    const boxes = v.loops[0].nodes.map((id) => layout.pos.get(id)!)
    const left = Math.min(...boxes.map((b) => b.x - b.w / 2))
    const top = Math.min(...boxes.map((b) => b.y - b.h / 2))
    expect(layout.box.x).toBeLessThan(left - 22 - v.loops[0].back.size * 10)
    expect(layout.box.y).toBeLessThan(top - 44)
    // Nodes outside the loop are kept off its frame.
    const frame = loopFrameRect(v.loops[0], layout.pos)!
    for (const [id, b] of layout.pos) {
      if (v.loops[0].nodes.includes(id)) continue
      const overlaps = b.x + b.w / 2 > frame.x && b.x - b.w / 2 < frame.x + frame.w && b.y + b.h / 2 > frame.y && b.y - b.h / 2 < frame.y + frame.h
      expect(overlaps, id).toBe(false)
    }
  })

  it('draws edges and truncates long labels', () => {
    const g = edgeGeometry({ x: 0, y: 0, w: 100, h: 40 }, { x: 300, y: 0, w: 100, h: 40 })
    expect(g.d.startsWith('M50,0')).toBe(true)
    expect(fitText('短', 100, 13)).toBe('短')
    expect(fitText('一个很长很长很长很长很长的名字', 60, 13).endsWith('…')).toBe(true)
  })

  it('docks a lane marked dock: bottom below the business area, under the nodes that use it', () => {
    const v = buildView(ctx(), 'order-system')!
    const layout = computeLayout(v, { width: 1200, height: 700 })
    const business = [...layout.pos.values()].filter((p) => !p.dock)
    const lowest = Math.max(...business.map((p) => p.y + p.h / 2))
    for (const id of ['order-system.mysql', 'order-system.redis', 'order-system.mq']) {
      const p = layout.pos.get(id)!
      expect(p.dock, id).toBe('bottom')
      expect(p.y - p.h / 2, id).toBeGreaterThan(lowest)
    }
    // No two boxes overlap in the band.
    const band = [...layout.pos.values()].filter((p) => p.dock).sort((a, b) => a.x - b.x)
    for (let i = 1; i < band.length; i++) expect(band[i].x - band[i - 1].x).toBeGreaterThanOrEqual(band[i].w)
  })

  it('places nodes by lane only: kind: resource in a plain lane stays a business column', () => {
    const lib2 = structuredClone({ docs: lib.docs, links: lib.links, requirements: lib.requirements })
    const sys = lib2.docs.find((d) => d.node.id === 'order-system')!.node
    delete sys.lanes.find((l: { id: string }) => l.id === 'storage').dock
    const check2 = checkLibrary(lib2.docs, lib2.requirements, lib2.links)
    const v = buildView({ check: check2, reqIndex: 0, reqOn: false }, 'order-system')!
    const layout = computeLayout(v, { width: 1200, height: 700 })
    expect(layout.pos.get('order-system.mysql')?.dock).toBeUndefined()
    expect([...layout.pos.values()].some((p) => p.dock)).toBe(false)
    // The drawn regions are `laneAreas`; there is still no property named `lanes`.
    expect('lanes' in layout).toBe(false)
    expect(layout.laneAreas.map((l) => l.id)).toEqual(expect.arrayContaining(['access', 'biz', 'infra']))
    expect(layout.laneAreas.some((l) => l.dock)).toBe(false)
    for (const area of layout.laneAreas) {
      const cards = sys.lanes.find((l: { id: string }) => l.id === area.id).nodes.map((ref: string) => layout.pos.get(v.resolve(ref)!)!)
      for (const card of cards) expect(card.y - card.h / 2).toBeGreaterThanOrEqual(area.y + 28)
    }
    // A resource left out of every lane is reported like any other node.
    sys.lanes = sys.lanes.filter((l: { id: string }) => l.id !== 'storage')
    const missing = checkLibrary(lib2.docs, lib2.requirements, lib2.links)
    expect(missing.base.issues.some((i) => i.rule === 'lane-missing' && i.msg.includes('order-system.mysql'))).toBe(true)
  })

  it('draws named business columns and docked bands, and drops them once a layout is saved', () => {
    const v = buildView(ctx(), 'order-system')!
    const layout = computeLayout(v, { width: 1200, height: 700 })
    expect('lanes' in layout).toBe(false)
    expect(layout.laneAreas.map((l) => [l.id, l.dock ?? ''])).toEqual([
      ['access', ''],
      ['biz', ''],
      ['infra', ''],
      ['bottom', 'bottom']
    ])
    const storage = layout.laneAreas.find((l) => l.dock === 'bottom')!
    expect(storage.name).toBe('存储 / 中间件')
    for (const area of layout.laneAreas) {
      expect(area.x).toBeGreaterThanOrEqual(layout.box.x)
      expect(area.y).toBeGreaterThanOrEqual(layout.box.y)
      expect(area.x + area.w).toBeLessThanOrEqual(layout.box.x + layout.box.w)
      expect(area.y + area.h).toBeLessThanOrEqual(layout.box.y + layout.box.h)
    }
    for (const id of v.members) {
      const card = layout.pos.get(id)!
      const area = layout.laneAreas.find((l) => (card.dock ? l.dock === card.dock : !l.dock && card.x >= l.x && card.x <= l.x + l.w))!
      expect(card.y - card.h / 2, id).toBeGreaterThanOrEqual(area.y + (area.dock ? 22 : 28))
    }
    const mysql = layout.pos.get('order-system.mysql')!
    const order = layout.pos.get('order-svc')!
    expect(mysql.y).toBeGreaterThan(order.y)
    for (const col of layout.laneAreas.filter((l) => !l.dock)) {
      expect(storage.y).toBeGreaterThan(col.y + col.h)
    }
    const savedLib = structuredClone({ docs: lib.docs, links: lib.links, requirements: lib.requirements })
    savedLib.docs.find((d) => d.node.id === 'order-system')!.node.layout = { 'order-svc': [40, 40] }
    const savedCheck = checkLibrary(savedLib.docs, savedLib.requirements, savedLib.links)
    const saved = buildView({ check: savedCheck, reqIndex: 0, reqOn: false }, 'order-system')!
    expect(computeLayout(saved, { width: 1200, height: 700 }).laneAreas).toEqual([])
  })

  it('widens structure cards for long Chinese titles without letting a docked band overlap', () => {
    const lib2 = structuredClone({ docs: lib.docs, links: lib.links, requirements: lib.requirements })
    const sys = lib2.docs.find((d) => d.node.id === 'order-system')!.node
    const gateway = sys.contains.find((n: { id?: string }) => n.id === 'gateway')
    gateway.name = '统一接入与鉴权限流网关'
    gateway.brief = '协议转换'
    const mq = sys.contains.find((n: { id?: string }) => n.id === 'mq')
    mq.name = '订单事件消息队列'
    mq.brief = 'order-events / pay-events'
    const check2 = checkLibrary(lib2.docs, lib2.requirements, lib2.links)
    const v = buildView({ check: check2, reqIndex: 0, reqOn: false }, 'order-system')!
    const layout = computeLayout(v, { width: 1400, height: 800 })
    const wide = layout.pos.get(v.members.find((member) => member.endsWith('.gateway'))!)!
    const plain = layout.pos.get('order-svc')!
    expect(wide.w).toBeGreaterThan(plain.w)
    expect(wide.w).toBeGreaterThanOrEqual(146)
    expect(wide.w).toBeLessThanOrEqual(204)
    expect(layout.pos.get(v.members.find((member) => member.endsWith('.user'))!)!.w).toBe(wide.w)
    expect(wide.w % 2).toBe(0)
    const band = [...layout.pos.values()].filter((p) => p.dock === 'bottom').sort((a, b) => a.x - b.x)
    for (let i = 1; i < band.length; i++) expect(band[i].x - band[i].w / 2).toBeGreaterThanOrEqual(band[i - 1].x + band[i - 1].w / 2)
    const lowest = Math.max(...[...layout.pos.values()].filter((p) => !p.dock).map((p) => p.y + p.h / 2))
    expect(Math.min(...band.map((p) => p.y - p.h / 2))).toBeGreaterThan(lowest)
  })

  it('orders a crossed two-column structure map by barycenter', () => {
    const doc = {
      schema: 'codemap/v1',
      id: 'cross',
      kind: 'component',
      name: 'cross',
      contains: [
        { id: 'A', kind: 'component', name: 'A' },
        { id: 'B', kind: 'component', name: 'B' },
        { id: 'C', kind: 'component', name: 'C' },
        { id: 'D', kind: 'component', name: 'D' }
      ],
      lanes: [
        { id: 'left', name: 'left', nodes: ['A', 'B'] },
        { id: 'right', name: 'right', nodes: ['C', 'D'] }
      ],
      edges: [
        { from: 'A', to: 'D' },
        { from: 'B', to: 'C' }
      ]
    }
    const check2 = checkLibrary([{ file: 'cross/cross.yaml', node: doc }], [], [])
    const v = buildView({ check: check2, reqIndex: 0, reqOn: false }, 'cross')!
    const layout = computeLayout(v, { width: 1000, height: 600 })
    expect(layout.pos.get('cross.A')!.x).toBeLessThan(layout.pos.get('cross.D')!.x)
    expect(layout.pos.get('cross.D')!.y).toBeLessThan(layout.pos.get('cross.C')!.y)
    expect(layout.pos.get('cross.A')!.y).toBeLessThan(layout.pos.get('cross.B')!.y)
    const boxes = [...layout.pos.values()]
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const overlaps = Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2
        expect(overlaps).toBe(false)
      }
      expect(boxes[i].x - boxes[i].w / 2).toBeGreaterThanOrEqual(layout.box.x)
      expect(boxes[i].y - boxes[i].h / 2).toBeGreaterThanOrEqual(layout.box.y)
    }
  })

  it('docks a lane marked dock: top above the business area', () => {
    const lib2 = structuredClone({ docs: lib.docs, links: lib.links, requirements: lib.requirements })
    const sys = lib2.docs.find((d) => d.node.id === 'order-system')!.node
    sys.lanes.find((l: { id: string }) => l.id === 'infra').dock = 'top'
    const check2 = checkLibrary(lib2.docs, lib2.requirements, lib2.links)
    expect(check2.base.issues.filter((i) => i.rule.startsWith('lane'))).toEqual([])
    const v = buildView({ check: check2, reqIndex: 0, reqOn: false }, 'order-system')!
    const layout = computeLayout(v, { width: 1200, height: 700 })
    const registry = layout.pos.get('order-system.registry')!
    const gateway = layout.pos.get('order-system.gateway')!
    expect(registry.dock).toBe('top')
    expect(registry.y).toBeLessThan(gateway.y)
    // A bad dock value is reported.
    sys.lanes.find((l: { id: string }) => l.id === 'infra').dock = 'middle'
    const bad = checkLibrary(lib2.docs, lib2.requirements, lib2.links)
    expect(bad.base.issues.some((i) => i.rule === 'lane-dock')).toBe(true)
  })

  it('docks lanes marked dock: left / right as the outermost business columns', () => {
    const lib2 = structuredClone({ docs: lib.docs, links: lib.links, requirements: lib.requirements })
    const sys = lib2.docs.find((d) => d.node.id === 'order-system')!.node
    sys.lanes.find((l: { id: string }) => l.id === 'access').dock = 'left'
    sys.lanes.find((l: { id: string }) => l.id === 'infra').dock = 'right'
    const check2 = checkLibrary(lib2.docs, lib2.requirements, lib2.links)
    expect(check2.base.issues.filter((i) => i.rule.startsWith('lane'))).toEqual([])
    const v = buildView({ check: check2, reqIndex: 0, reqOn: false }, 'order-system')!
    const layout = computeLayout(v, { width: 1200, height: 700 })
    const business = ['order-svc', 'inventory-svc', 'payment-svc', 'notify'].map((ref) => layout.pos.get(v.resolve(ref)!)!)
    const minX = Math.min(...business.map((p) => p.x - p.w / 2))
    const maxX = Math.max(...business.map((p) => p.x + p.w / 2))
    const leftArea = layout.laneAreas.find((l) => l.dock === 'left')!
    const rightArea = layout.laneAreas.find((l) => l.dock === 'right')!
    for (const col of layout.laneAreas.filter((l) => !l.dock)) {
      expect(leftArea.x + leftArea.w).toBeLessThan(col.x)
      expect(rightArea.x).toBeGreaterThan(col.x + col.w)
    }
    for (const ref of ['user', 'gateway', 'thirdpay']) {
      const id = v.members.find((member) => member === ref || member.endsWith(`.${ref}`))!
      const p = layout.pos.get(id)!
      expect(p.dock, id).toBe('left')
      expect(p.x + p.w / 2, id).toBeLessThan(minX)
      expect(p.y - p.h / 2, id).toBeGreaterThanOrEqual(leftArea.y + 22)
    }
    const registry = layout.pos.get(v.members.find((member) => member.endsWith('.registry'))!)!
    expect(registry.dock).toBe('right')
    expect(registry.x - registry.w / 2).toBeGreaterThan(maxX)
    expect(registry.y - registry.h / 2).toBeGreaterThanOrEqual(rightArea.y + 22)
    // A left band stacks top to bottom without overlaps.
    const band = [...layout.pos.values()].filter((p) => p.dock === 'left').sort((a, b) => a.y - b.y)
    for (let i = 1; i < band.length; i++) expect(band[i].y - band[i - 1].y).toBeGreaterThanOrEqual(band[i].h)
    // Lines to a side band leave from the facing side.
    const gateway = layout.pos.get(v.members.find((member) => member.endsWith('.gateway'))!)!
    const g = edgeGeometry(gateway, business[0])
    expect(g.d.startsWith(`M${gateway.x + gateway.w / 2},`)).toBe(true)
  })
})

describe('code map to-dos', () => {
  it('attaches issues to their node and todo/ notes to the node of their folder, and rolls counts up', () => {
    const todos = collectTodos(check, lib.todos)
    expect(todos.items.map((x) => [x.kind, x.node, x.title])).toEqual([
      ['issue', 'order-svc.validate', '没校验 SkuId：传 0 也能过，到锁库存才报错'],
      ['note', null, '拆出优惠券服务'],
      ['note', 'order-svc', '超时取消订单']
    ])
    // The issue's line-only code is in the node's own file.
    expect(todos.items[0].code).toBe('handler/validate.go:22-26')
    // Counts: own to-dos plus those inside, up through every container.
    expect(todos.counts.get('order-svc.validate')).toBe(1)
    expect(todos.counts.get('order-svc')).toBe(2)
    expect(todos.counts.get('order-system')).toBe(2)
    expect(todos.counts.get('warehouse-system')).toBeUndefined()
    // A folder with no node yet keeps its note in the summary only.
    expect([...todos.byNode.values()].flat().some((x) => x.dir === 'coupon-svc')).toBe(false)
  })
})

describe('code map library and access', () => {
  it('detects a node library in the folder or one level below', async () => {
    expect(await isLibrary(FIXTURE)).toBe(true)
    expect(await findLibraries(path.join(__dirname, '../fixtures/codemap-demo'))).toEqual([FIXTURE])
    expect(await findLibraries(path.join(__dirname, '../fixtures'))).toEqual([FIXTURE])
  })

  it('finds nothing in an ordinary folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-none-'))
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src', 'src.yaml'), 'name: not a node\n')
    expect(await findLibraries(dir)).toEqual([])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('allows the open folder and granted folders only', () => {
    const access = new CodemapAccess(() => '/work/shop', ['/Users/me/go/pkg/mod/sdk@v1'])
    expect(access.allowed('/work/shop/order-svc/a.go')).toBe(true)
    expect(access.allowed('/Users/me/go/pkg/mod/sdk@v1/x.go')).toBe(true)
    expect(access.allowed('/Users/me/.ssh/id_rsa')).toBe(false)
    expect(access.allowed('/work/shop-other/a.go')).toBe(false)
    expect(grantable('/')).toBe(false)
    expect(grantable(os.homedir())).toBe(false)
    expect(grantable(path.join(os.homedir(), 'go/pkg/mod'))).toBe(true)
  })
})
