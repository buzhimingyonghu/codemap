// 校验规则的测试：示例节点库应当全部通过；每个用例把示例改坏一处，检查能报出对应的规则。
// 运行：npm test（或 npx vitest run tests/unit/codemap.test.ts）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it as test } from 'vitest'
import { checkLibrary, isIgnored, kbPath, parseIgnore, resolveCode, type Issue, type LinkDoc, type NodeDoc, type RequirementDoc } from '@shared/codemap/codemap.mjs'
import { loadLibrary } from '../../src/main/codemap/loadLibrary.mjs'

// 示例节点库（订单系统 + 仓储系统 + “下单支持优惠券”需求），按节点分文件夹
const LIB = loadLibrary(path.join(__dirname, '../fixtures/codemap-demo/library'))

// 用例要随手改 YAML 里的任意字段，所以这里按宽松类型处理
type Lib = { docs: NodeDoc[]; links: LinkDoc[]; requirements: RequirementDoc[] }
type Any = any

// ---------- 工具 ----------

const fresh = (): Lib => structuredClone({ docs: LIB.docs, links: LIB.links, requirements: LIB.requirements })
const run = (lib: Lib) => checkLibrary(lib.docs, lib.requirements, lib.links)
const baseIssues = (r: ReturnType<typeof run>) => r.base.issues
const reqIssues = (r: ReturnType<typeof run>) => r.reqs.flatMap((x) => x.issues)
const errorsOf = (issues: Issue[]) => issues.filter((i) => i.level === 'error')
const rules = (issues: Issue[]) => [...new Set(issues.map((i) => i.rule))]

const node = (lib: Lib, id: string): Any => lib.docs.find((d) => d.node.id === id)!.node
const inner = (lib: Lib, mapId: string, shortId: string): Any => node(lib, mapId).contains.find((x: Any) => typeof x === 'object' && x.id === shortId)
const edge = (lib: Lib, mapId: string, from: string, to: string): Any => node(lib, mapId).edges.find((e: Any) => e.from === from && e.to === to)
const flow = (lib: Lib, mapId: string, flowId: string): Any => node(lib, mapId).flows.find((f: Any) => f.id === flowId)
const step = (lib: Lib, mapId: string, flowId: string, from: string, to: string): Any =>
  flow(lib, mapId, flowId).steps.find((s: Any) => s.from === from && s.to === to)
const linkFile = (lib: Lib, owner: string): Any => lib.links.find((d) => d.data.owner === owner)!.data
const link = (lib: Lib, owner: string, id: string): Any => linkFile(lib, owner).links.find((l: Any) => l.id === id)
const req = (lib: Lib): Any => lib.requirements[0]
const change = (lib: Lib, pred: (c: Any) => boolean): Any => req(lib).changes.find(pred)

// 断言：改坏之后报出了 rule；level 不写时要求是错误
function expectRule(issues: Issue[], rule: string, level = 'error') {
  const hit = issues.filter((i) => i.rule === rule && i.level === level)
  assert.ok(hit.length, `应该报 ${level} [${rule}]，实际报了：\n${issues.map((i) => `  ${i.level} [${i.rule}] ${i.where}：${i.msg}`).join('\n') || '  （没有）'}`)
}

// ---------- 示例本身 ----------

test('示例节点库：没有错误和警告', () => {
  assert.deepEqual(LIB.errors, [])
  const r = run(fresh())
  const bad = [...baseIssues(r), ...reqIssues(r)].filter((i) => i.level !== 'info')
  assert.deepEqual(bad, [])
})

test('示例节点库：链路和数据都建进了索引', () => {
  const { model } = run(fresh())
  assert.equal(model.nodes.get('order-svc.CreateOrder')?.node.kind, 'api')
  assert.equal(model.nodes.get('order-svc.CreateOrderReq')?.node.kind, 'type')
  assert.equal(model.nodes.get('order-system.gateway.PlaceOrderBody')?.node.kind, 'type')
})

test('示例需求：角标沿包含关系往上汇总', () => {
  const r = run(fresh())
  const impact = r.reqs[0].impact
  assert.equal(impact.get('order-system'), 27)
  assert.equal(impact.get('order-svc'), 27)
  assert.equal(impact.get('order-svc.build-order'), 16)
})

test('知识库：url 可以是链接，也可以是文件路径', () => {
  const lib = fresh()
  inner(lib, 'order-svc', 'lock-stock').kb = [
    { title: '链接', url: 'https://wiki.example.com/p/1' },
    { title: '相对路径', url: 'docs/order-svc/状态机.md' },
    { title: '绝对路径', url: '/Users/me/notes/锁库存.md' }
  ]
  const issues = baseIssues(run(lib)).filter((i) => i.rule.startsWith('kb'))
  assert.deepEqual(issues, [])
})

// ---------- 改坏一处，应该被查出来 ----------
// [名字, 改法, 期望的规则, 级别（默认错误）, 看底图还是看需求（默认底图）]

const cases: Array<[string, (l: Lib) => void, string, string?, string?]> = [
  // 字段
  ['函数层漏写字段赋值', (l: Lib) => {
    const n = inner(l, 'order-svc.build-order', 'gen-id')
    delete n.fn.writes
  }, 'field-missing'],
  ['先读后写：需求把核销挪到算金额之前', (l: Lib) => {
    change(l, (c: Any) => c.add === 'edge' && c.value?.from === 'calc-items' && c.value?.to === 'apply-coupon').value.from = 'gate-items'
  }, 'field-read-before-write', 'error', 'req'],
  ['字段引用写错', (l: Lib) => {
    inner(l, 'order-svc.build-order', 'get-user').fn.reads = ['CreateOrderReq.UserIdx']
  }, 'ref-missing'],
  ['字段引用指向的不是数据', (l: Lib) => {
    inner(l, 'order-svc.build-order', 'get-user').fn.reads = ['get-user.UserId']
  }, 'not-type'],
  ['函数字段写在 fn 外面', (l: Lib) => {
    const n = inner(l, 'order-svc.build-order', 'get-user')
    n.writes = n.fn.writes
    delete n.fn.writes
  }, 'unknown-key', 'warn'],
  ['fn 里写了不认识的字段', (l: Lib) => {
    inner(l, 'order-svc', 'validate').fn.symbol = 'validate'
  }, 'unknown-key', 'warn'],
  ['outcome 写错', (l: Lib) => {
    inner(l, 'order-svc', 'resp').fn.outcome = 'ok'
  }, 'fn-outcome'],
  ['trigger 写错', (l: Lib) => {
    inner(l, 'order-svc', 'create-order').fn.trigger = 'rpc'
  }, 'fn-trigger', 'warn'],
  ['函数层没有入口', (l: Lib) => {
    delete inner(l, 'order-svc.build-order', 'params').fn
  }, 'exec-entry'],

  // 执行图
  ['闸门缺不通过分支', (l: Lib) => {
    const n = node(l, 'order-svc')
    n.edges = n.edges.filter((e: Any) => !(e.from === 'validate' && e.to === 'fail-resp'))
  }, 'gate-branches'],
  ['错误分支走到成功结束', (l: Lib) => {
    edge(l, 'order-svc', 'lock-stock', 'fail-resp').to = 'resp'
  }, 'error-swallowed', 'warn'],

  // 流程
  ['流程步骤不在连线上', (l: Lib) => {
    step(l, 'order-svc', 'create-ok', 'save', 'publish').to = 'resp'
  }, 'step-edge'],
  ['跨层流程和上层对不上', (l: Lib) => {
    const f = flow(l, 'order-system', 'place-order')
    f.steps = f.steps.filter((s: Any) => !(s.from === 'order-svc' && s.to === 'mysql') && !(s.from === 'mysql' && s.to === 'order-svc'))
  }, 'flow-refines'],
  ['示例里的字段在数据里不存在', (l: Lib) => {
    step(l, 'order-system', 'place-order', 'order-svc', 'inventory-svc').sample = 'LockStockReq{ Itms: [{1001, 2}], TTL: 900 }'
  }, 'sample-field'],

  // 连线跨层
  ['外部连线在上一层对不上', (l: Lib) => {
    // publish 也引用进 build-order 的图，但 order-svc 里没有 build-order → publish 这条线
    node(l, 'order-svc.build-order').contains.push({ ref: 'order-svc.publish', path: '..' })
    edge(l, 'order-svc.build-order', 'ret', 'save').to = 'publish'
  }, 'edge-lift'],
  ['连线连到 contains 里没有的节点', (l: Lib) => {
    edge(l, 'order-svc.build-order', 'ret', 'save').to = 'publish'
  }, 'edge-endpoint'],
  ['数据没写 repo 也没写 missing', (l: Lib) => {
    delete linkFile(l, 'order-svc').links.find((x: Any) => x.id === 'CreateOrder').data[0].repo
  }, 'data-repo'],
  ['引用的节点读不到', (l: Lib) => {
    node(l, 'order-svc').contains.push({ ref: 'no-such-node', path: '../no-such-node' })
  }, 'ref-path', 'warn'],
  ['下游没有对应的入口', (l: Lib) => {
    edge(l, 'order-svc', 'lock-stock', 'inventory-svc').via = 'order-svc.BuildOrder'
  }, 'edge-unmatched', 'warn'],
  ['上下两层走的链路不一致', (l: Lib) => {
    edge(l, 'order-svc', 'order-system.gateway', 'create-order').via = 'inventory-svc.LockStock'
  }, 'edge-lift'],
  ['被调方的地图没说明调用从哪来', (l: Lib) => {
    // order-system 里 gateway → order-svc，order-svc 自己的图里删掉从 gateway 进来的线
    const n = node(l, 'order-svc')
    n.edges = n.edges.filter((e: Any) => !(e.from === 'order-system.gateway' && e.to === 'create-order'))
  }, 'edge-mutual'],
  ['调用方的地图没画出这条调用', (l: Lib) => {
    // order-system 里 order-svc → inventory-svc，order-svc 自己的图里删掉锁库存那条线
    const n = node(l, 'order-svc')
    n.edges = n.edges.filter((e: Any) => !(e.from === 'lock-stock' && e.to === 'inventory-svc'))
  }, 'edge-mutual'],
  ['被调方那边的连线没带上数据', (l: Lib) => {
    // order-system 里 gateway → order-svc 走 CreateOrder；order-svc 那边的线改成只走 BuildOrder
    edge(l, 'order-svc', 'order-system.gateway', 'create-order').via = 'BuildOrder'
  }, 'edge-mutual'],

  // 链路和数据
  ['via 指向的不是链路', (l: Lib) => {
    edge(l, 'order-system', 'gateway', 'order-svc').via = 'order-svc.CreateOrderReq'
  }, 'not-api'],
  ['via 写成了对象', (l: Lib) => {
    edge(l, 'order-system', 'user', 'gateway').via = { protocol: 'http', name: 'POST /api/orders' }
  }, 'via-format'],
  ['步骤的 data 不在这条线的数据里', (l: Lib) => {
    step(l, 'order-svc', 'create-ok', 'publish', 'order-system.mq').data = 'StockResult'
  }, 'step-data'],
  ['一条线上有多种数据，步骤没指明', (l: Lib) => {
    delete step(l, 'order-svc', 'create-ok', 'publish', 'order-system.mq').data
  }, 'step-data', 'warn'],
  ['数据 id 重复', (l: Lib) => {
    link(l, 'order-svc', 'order-events').data[1].id = 'CreateOrderReq'
  }, 'id-unique'],
  ['data 条目写了 ref 又写 fields', (l: Lib) => {
    link(l, 'order-svc', 'ValidateReq').data[0].fields = [{ name: 'x', type: 'int' }]
  }, 'api-data'],
  ['链路文件没写 owner', (l: Lib) => {
    delete linkFile(l, 'payment-svc').owner
  }, 'link-owner'],
  ['链路文件的 owner 不存在', (l: Lib) => {
    linkFile(l, 'payment-svc').owner = 'pay-svc'
  }, 'link-owner'],
  ['topic 有人发没人收', (l: Lib) => {
    const n = node(l, 'order-system')
    n.edges = n.edges.filter((e: Any) => !(e.from === 'mq' && e.to === 'notify'))
    for (const f of n.flows) f.steps = f.steps.filter((s: Any) => !(s.from === 'mq' && s.to === 'notify'))
  }, 'mq-no-consumer', 'warn'],
  ['节点文件里还写数据类型', (l: Lib) => {
    node(l, 'payment-svc').contains = [{ id: 'X', kind: 'type', name: 'X' }]
  }, 'node-kind'],

  // 标识与引用
  ['contains 引用不存在的节点', (l: Lib) => {
    const n = node(l, 'order-system')
    n.contains = n.contains.map((x: Any) => (x === 'payment-svc' ? 'payment-service' : x))
  }, 'ref-missing'],
  ['两个文件定义了同一个 id', (l: Lib) => {
    node(l, 'warehouse-system').id = 'order-system'
  }, 'id-unique'],
  ['知识库不是完整链接', (l: Lib) => {
    inner(l, 'order-svc', 'lock-stock').kb = [{ url: 'wiki:2003', title: '库存预扣' }]
  }, 'kb-url'],
  ['知识库写了 title、url 以外的字段', (l: Lib) => {
    inner(l, 'order-svc', 'lock-stock').kb = [{ url: 'https://wiki.example.com/p/1', title: '库存预扣', note: '为什么锁 900 秒' }]
  }, 'unknown-key', 'warn'],
  ['节点还写着 see', (l: Lib) => {
    inner(l, 'order-svc', 'mark-paid').see = ['save']
  }, 'unknown-key', 'warn'],

  // 代码与仓库
  ['锚点用了绝对路径', (l: Lib) => {
    inner(l, 'order-svc', 'save').fn.code = '/Users/me/order-svc/repo/order.go:15-17'
  }, 'code-path'],
  ['行号写错', (l: Lib) => {
    inner(l, 'order-svc', 'save').fn.code = 'repo/order.go:17-15'
  }, 'code-lines'],
  ['代码位置还写成对象', (l: Lib) => {
    inner(l, 'order-svc', 'save').fn.code = { file: 'repo/order.go', lines: '15-17' }
  }, 'code-format'],
  ['code 写在 fn 外面', (l: Lib) => {
    const n = inner(l, 'order-svc', 'save')
    n.code = n.fn.code
    delete n.fn.code
  }, 'unknown-key', 'warn'],
  ['只写行号但外层没有文件', (l: Lib) => {
    node(l, 'order-svc.build-order').fn.code = '13-41'
  }, 'code-format'],
  ['review.status 写错', (l: Lib) => {
    node(l, 'order-svc').review = { status: 'done' }
  }, 'review-format'],
  ['节点还写着 verified', (l: Lib) => {
    inner(l, 'order-svc', 'lock-stock').verified = { commit: '3f2a91c', shape: '51c7aa' }
  }, 'unknown-key', 'warn'],
  ['repo 没写 git 地址', (l: Lib) => {
    node(l, 'payment-svc').repo = { dir: 'payment' }
  }, 'repo-remote'],
  ['函数写了 code 没写 repo', (l: Lib) => {
    delete inner(l, 'order-svc', 'save').fn.repo
  }, 'code-repo'],
  ['函数的 repo 写在节点上，没写在 fn 里', (l: Lib) => {
    const n = inner(l, 'order-svc', 'save')
    n.repo = n.fn.repo
    delete n.fn.repo
  }, 'code-repo'],
  ['repo 还写着 dir', (l: Lib) => {
    inner(l, 'order-svc', 'save').fn.repo.dir = 'svc'
  }, 'repo-dir'],
  ['只写行号的代码块，外层函数没写 repo', (l: Lib) => {
    delete node(l, 'order-svc.build-order').fn.repo
  }, 'code-repo'],

  // 需求
  ['需求删了节点但没删连线', (l: Lib) => {
    const r = req(l)
    r.changes = r.changes.filter((c: Any) => !(c.remove === 'edge' && c.id === 'gate-items->price-cache'))
  }, 'ref-missing', 'error', 'req'],
  ['需求改的节点不存在', (l: Lib) => {
    req(l).changes.push({ modify: 'node', id: 'order-svc.no-such-node', set: { name: 'x' } })
  }, 'req-change', 'error', 'req'],
  ['需求的 proposed 没写代码', (l: Lib) => {
    change(l, (c: Any) => c.modify === 'node' && c.id === 'order-svc.build-order.calc-amount').proposed = { file: 'service/build.go:34' }
  }, 'req-change', 'error', 'req'],
  ['需求的 proposed 写了旧字段 code', (l: Lib) => {
    change(l, (c: Any) => c.modify === 'node' && c.id === 'order-svc.build-order.calc-amount').proposed = { code: 'x' }
  }, 'req-change', 'error', 'req']
]

for (const [name, mutate, rule, level = 'error', scope = 'base'] of cases) {
  test(`改坏：${name} → ${rule}`, () => {
    const lib = fresh()
    mutate(lib)
    const r = run(lib)
    expectRule(scope === 'req' ? reqIssues(r) : baseIssues(r), rule, level)
  })
}

// 改坏之后错误数应该比示例多（防止规则误报在示例上）
test('每个用例都不是示例本来就有的问题', () => {
  const clean = run(fresh())
  assert.equal(errorsOf([...baseIssues(clean), ...reqIssues(clean)]).length, 0)
  assert.ok(rules(baseIssues(clean)).every((r) => r === 'via-missing'))
})

// 按节点分文件夹：示例库就是这种布局
test('按节点分文件夹：docs/ 里的 yaml 不当节点，链路和需求按内容识别', () => {
  assert.deepEqual(LIB.errors, [])
  assert.ok(LIB.docs.every((d) => !d.file.includes('/docs/')))
  assert.equal(LIB.links.length, 4)
  assert.equal(LIB.requirements.length, 1)
  assert.equal(LIB.docs.find((d) => d.node.id === 'order-svc')?.file, 'order-svc/order-svc.yaml')
})

test('kb 相对路径按节点文件所在目录展开', () => {
  assert.equal(kbPath('docs/状态机.md', 'order-svc/order-svc.yaml'), 'order-svc/docs/状态机.md')
  assert.equal(kbPath('../docs/x.md', 'a/b/b.yaml'), 'a/docs/x.md')
  assert.equal(kbPath('https://wiki.example.com/p/1', 'a/a.yaml'), 'https://wiki.example.com/p/1')
  assert.equal(kbPath('/abs/x.md', 'a/a.yaml'), '/abs/x.md')
})

test('代码位置用自己的 repo：路径 = repo.local（相对写它的 yaml）+ code', () => {
  const { model } = run(fresh())
  const a = resolveCode(model, 'order-svc.validate')
  assert.equal(a?.repoId, 'order-svc.validate')
  assert.equal(a?.local, '../demo-repos/order-svc')
  assert.equal(a?.file, 'handler/validate.go')
  assert.equal(a?.dir, '')
  // 数据：repo 写在条目上，code 是仓库根目录下的完整路径
  const d = resolveCode(model, 'inventory-svc.LockStockReq')
  assert.equal(d?.local, '../demo-repos/monorepo')
  assert.equal(d?.file, 'services/inventory/api/inventory.proto')
  // 只写行号的代码块：文件和仓库都用外层函数的
  const block = resolveCode(model, 'order-svc.build-order.get-user')
  assert.equal(block?.repoId, 'order-svc.build-order')
  assert.equal(block?.file, 'service/build.go')
  // build-order.yaml 写的是 ../../../demo-repos/order-svc（相对它自己的文件夹），展开后相对节点库根目录
  assert.equal(block?.local, '../demo-repos/order-svc')
  // 组件节点上的 repo 不再被子节点继承
  const lib = fresh()
  delete inner(lib, 'order-svc', 'save').fn.repo
  assert.equal(resolveCode(run(lib).model, 'order-svc.save')?.local, null)
})

test('改坏：repo.local 写成空字符串 → repo-local', () => {
  const lib = fresh()
  inner(lib, 'order-svc', 'save').fn.repo.local = ''
  expectRule(baseIssues(run(lib)), 'repo-local')
})

test(".codemapignore：写进去的不读，其余全读", () => {
  const rules = parseIgnore('# 注释\n.*\ndocs/\n/_templates/\n告警/\n*.json\n!keep.json\nfoo/**/bar/')
  const ignoreCases: Array<[string, boolean, boolean]> = [
    ['_templates', true, true], ['a/_templates', true, false], ['billing/告警', true, true], ['billing/告警', false, false],
    ['redis/docs', true, true], ['redis/redis.yaml', false, false], ['.git', true, true],
    ['a/b.json', false, true], ['a/keep.json', false, false], ['foo/bar', true, true], ['foo/x/y/bar', true, true]
  ]
  for (const [p, dir, want] of ignoreCases) assert.equal(isIgnored(rules, p, dir), want, p)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-ignore-'))
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  put('a/a.yaml', 'schema: codemap/v1\nid: a\nkind: component\nname: A\n')
  put('a/告警/x.yaml', 'id: alarm\nkind: component\nname: x\n')
  put('b/deep/deep.yaml', 'schema: codemap/v1\nid: deep\nkind: component\nname: D\n')
  put('_tpl/t.yaml', 'id: tpl\nkind: component\nname: t\n')
  put('.codemapignore', '告警/\n/_tpl/\n')
  const lib = loadLibrary(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  assert.deepEqual(lib.docs.map((d) => d.node.id).sort(), ['a', 'deep'])
})

// ---------- 心跳写在链路上 ----------

test('心跳：链路上写 heartbeat，只认 true 或周期', () => {
  const lib = fresh()
  link(lib, 'inventory-svc', 'Beat').heartbeat = 'often'
  expectRule(baseIssues(run(lib)), 'link-heartbeat')
  link(lib, 'inventory-svc', 'Beat').heartbeat = true
  assert.ok(!baseIssues(run(lib)).some((i) => i.rule === 'link-heartbeat'))
})

test('心跳：连线上写 signal / period 直接报错', () => {
  const lib = fresh()
  edge(lib, 'order-system', 'inventory-svc', 'registry').signal = 'heartbeat'
  expectRule(baseIssues(run(lib)), 'edge-heartbeat')
  const lib2 = fresh()
  edge(lib2, 'order-system', 'inventory-svc', 'registry').period = '5s'
  expectRule(baseIssues(run(lib2)), 'edge-heartbeat')
})

// ---------- 函数类型、协程、分支条件 ----------

const releaser = (lib: Lib): Any => node(lib, 'order-svc.releaser')
const releaserNode = (lib: Lib, id: string): Any => releaser(lib).contains.find((x: Any) => typeof x === 'object' && x.id === id)

test('函数类型：fn.type 只能写一种，listen 或 timer', () => {
  const lib = fresh()
  releaserNode(lib, 'on-paid').fn.type = [ 'listen', 'timer' ]
  expectRule(baseIssues(run(lib)), 'fn-type')
  const lib2 = fresh()
  releaserNode(lib2, 'on-paid').fn.type = 'watch'
  expectRule(baseIssues(run(lib2)), 'fn-type')
})

test('函数类型：timer 要写 every，every 只给 timer 用', () => {
  const lib = fresh()
  delete releaserNode(lib, 'on-tick').fn.every
  expectRule(baseIssues(run(lib)), 'fn-type')
  const lib2 = fresh()
  releaserNode(lib2, 'on-tick').fn.every = 'often'
  expectRule(baseIssues(run(lib2)), 'fn-type')
  const lib3 = fresh()
  releaserNode(lib3, 'on-paid').fn.every = '5s'
  expectRule(baseIssues(run(lib3)), 'fn-type')
})

test('协程：mode 只能是 go / thread，并且是 call 或 send 线', () => {
  const lib = fresh()
  edge(lib, 'order-svc', 'create-order', 'releaser').mode = 'async'
  expectRule(baseIssues(run(lib)), 'edge-mode')
  const lib2 = fresh()
  delete edge(lib2, 'order-svc', 'create-order', 'releaser').kind
  expectRule(baseIssues(run(lib2)), 'edge-mode')
})

test('分支条件：闸门的分支可以写条件文字，没写条件的分支给提示', () => {
  const ok = run(fresh())
  assert.ok(!baseIssues(ok).some((i) => i.rule === 'gate-branches'))
  const lib = fresh()
  delete releaser(lib).edges.find((e: Any) => e.from === 'check' && e.to === 'wait').when
  expectRule(baseIssues(run(lib)), 'gate-branches', 'warn')
})

// ---------- 调用两边都要说明：连到对方里面的节点也算 ----------

// 给库存服务一张内部地图（入口 lock 实现 LockStock），订单服务的图里直接连到 lock，而不是库存服务这个框。
function withInventoryInside(lib: Lib): Lib {
  const inv = node(lib, 'inventory-svc')
  inv.contains = [
    { ref: 'order-svc', path: '../order-svc' },
    { id: 'lock', kind: 'function', name: '锁库存', fn: { code: 'services/inventory/api/inventory.proto:12-15', repo: inv.repo, serves: 'LockStock' } },
    { id: 'release', kind: 'function', name: '释放库存', fn: { code: 'services/inventory/api/inventory.proto:24-28', repo: inv.repo, serves: 'ReleaseStock' } }
  ]
  inv.edges = [
    { from: 'order-svc', to: 'lock', kind: 'call', via: 'inventory-svc.LockStock' },
    { from: 'order-svc', to: 'release', kind: 'call', via: 'inventory-svc.ReleaseStock' }
  ]
  return lib
}

test('调用两边：上层连到容器，下层连到容器里面的节点，也算画了', () => {
  const lib = withInventoryInside(fresh())
  const svc = node(lib, 'order-svc')
  svc.contains.push({ ref: 'inventory-svc.lock', path: '../inventory-svc' }, { ref: 'inventory-svc.release', path: '../inventory-svc' })
  svc.lanes.find((l: Any) => l.id === 'ext').nodes.push('inventory-svc.lock', 'inventory-svc.release')
  svc.edges.find((e: Any) => e.from === 'lock-stock' && e.to === 'inventory-svc').to = 'inventory-svc.lock'
  svc.edges.find((e: Any) => e.from === 'releaser' && e.to === 'inventory-svc').to = 'inventory-svc.release'
  // 只看订单服务 ↔ 库存服务这几条（库存服务有了内部地图后，它别的调用也会被查，不在这个用例里）
  const issues = baseIssues(run(lib)).filter((i) => i.rule === 'edge-mutual' && /order-svc->inventory-svc|release-stock|lock-stock->|releaser->/.test(i.where))
  assert.deepEqual(issues, [])
})

test('调用两边：下层一条都没连到对方（也没连到它里面），照样报错', () => {
  const lib = withInventoryInside(fresh())
  const svc = node(lib, 'order-svc')
  // 删掉订单服务里连到库存服务的两条线（锁库存、释放库存协程）
  svc.edges = svc.edges.filter((e: Any) => !(e.to === 'inventory-svc' && (e.from === 'lock-stock' || e.from === 'releaser')))
  const hit = baseIssues(run(lib)).filter((i) => i.rule === 'edge-mutual' && i.where.includes('连线 order-svc->inventory-svc') && i.msg.includes('order-svc 的地图里没有画出这条调用'))
  assert.ok(hit.length, '下层没连到库存服务时要报 edge-mutual')
})

test('调用两边：下层只连了对方的一部分，缺的接口照样报出来', () => {
  const lib = withInventoryInside(fresh())
  const svc = node(lib, 'order-svc')
  // 只删锁库存那条，剩下的释放库存线也连到库存服务，但带的是 ReleaseStock，LockStock 没对上
  svc.edges = svc.edges.filter((e: Any) => !(e.from === 'lock-stock' && e.to === 'inventory-svc'))
  const hit = baseIssues(run(lib)).filter((i) => i.rule === 'edge-mutual' && i.where.includes('连线 order-svc->inventory-svc') && i.msg.includes('LockStock'))
  assert.ok(hit.length, '缺了 LockStock 要报 edge-mutual')
})

test('调用两边：连到对方里面的节点，via 合起来也要对得上', () => {
  const lib = withInventoryInside(fresh())
  // 库存服务那边进 lock 的线改成只带 ReleaseStock：order-svc → inventory-svc 的 LockStock 没有对应
  node(lib, 'inventory-svc').edges[0].via = 'inventory-svc.ReleaseStock'
  const hit = baseIssues(run(lib)).filter((i) => i.rule === 'edge-mutual' && i.msg.includes('没有带上数据'))
  assert.ok(hit.length, 'via 对不上时要报 edge-mutual')
})

test('调用两边：只用来归类、自己没画连线的框（「共用」）不要求再画一遍', () => {
  const lib = fresh()
  const sys = node(lib, 'order-system')
  // 订单系统把 MySQL、Redis 收进一个「共用」框；下面的服务照常直接连 MySQL / Redis
  sys.contains = sys.contains.filter((c: Any) => !(typeof c === 'object' && ['mysql', 'redis'].includes(c.id)))
  sys.contains.push({
    id: 'shared',
    kind: 'component',
    name: '共用',
    contains: [
      { id: 'mysql', kind: 'resource', resource: 'mysql', name: 'MySQL' },
      { id: 'redis', kind: 'resource', resource: 'redis', name: 'Redis' }
    ]
  })
  sys.lanes = sys.lanes.map((l: Any) => (l.id === 'storage' ? { ...l, nodes: ['shared', 'mq'] } : l))
  for (const e of sys.edges) {
    if (e.to === 'mysql' || e.to === 'redis') e.to = 'shared'
    if (e.from === 'mysql' || e.from === 'redis') e.from = 'shared'
  }
  for (const f of sys.flows ?? []) for (const s of f.steps ?? []) for (const k of ['from', 'to', 'at']) if (s[k] === 'mysql' || s[k] === 'redis') s[k] = 'shared'
  // 订单服务的图里仍然连 order-system.mysql；路径改成共用里面的 MySQL
  const svc = node(lib, 'order-svc')
  svc.contains = svc.contains.map((c: Any) => (typeof c === 'object' && c.ref === 'order-system.mysql' ? { ref: 'order-system.shared.mysql', path: '../order-system' } : c))
  for (const e of svc.edges) for (const k of ['from', 'to']) if (e[k] === 'order-system.mysql') e[k] = 'order-system.shared.mysql'
  for (const f of svc.flows ?? []) for (const s of f.steps ?? []) for (const k of ['from', 'to', 'at']) if (s[k] === 'order-system.mysql') s[k] = 'order-system.shared.mysql'
  svc.lanes = svc.lanes.map((l: Any) => ({ ...l, nodes: l.nodes.map((n: string) => (n === 'order-system.mysql' ? 'order-system.shared.mysql' : n)) }))
  const mutual = baseIssues(run(lib)).filter((i) => i.rule === 'edge-mutual')
  assert.deepEqual(mutual, [])
})

// ---------- 待核查（issues） ----------

test('待核查：issues 每条要写 desc；code 只写行号时指节点自己的代码文件', () => {
  const ok = run(fresh())
  assert.ok(!baseIssues(ok).some((i) => i.rule === 'issue-format' || i.rule === 'unknown-key' || i.where.includes('待核查')))
  const lib = fresh()
  inner(lib, 'order-svc', 'validate').issues = [{ code: '22-26' }]
  expectRule(baseIssues(run(lib)), 'issue-format')
  const lib2 = fresh()
  inner(lib2, 'order-svc', 'validate').issues = { desc: 'x' }
  expectRule(baseIssues(run(lib2)), 'issue-format')
  const lib3 = fresh()
  inner(lib3, 'order-svc', 'validate').issues = [{ desc: 'x', code: '30-20' }]
  expectRule(baseIssues(run(lib3)), 'code-lines')
  const lib4 = fresh()
  inner(lib4, 'order-svc', 'validate').issues = [{ desc: 'x', where: 'y' }]
  expectRule(baseIssues(run(lib4)), 'unknown-key', 'warn')
})

test('待办：列出每个文件夹 todo/ 里的 md 和它的标题，不当节点读', async () => {
  const { listTodos } = await import('../../src/main/codemap/loadLibrary.mjs')
  const dir = path.join(__dirname, '../fixtures/codemap-demo/library')
  assert.deepEqual(listTodos(dir), [
    { file: 'coupon-svc/todo/拆出优惠券服务.md', dir: 'coupon-svc', title: '拆出优惠券服务' },
    { file: 'order-svc/todo/超时取消订单.md', dir: 'order-svc', title: '超时取消订单' }
  ])
  assert.deepEqual(LIB.todos, listTodos(dir))
  // todo/ 被 .codemapignore 忽略，里面的东西不会被当成节点
  assert.ok(!LIB.docs.some((d) => d.file.includes('/todo/')))
})
