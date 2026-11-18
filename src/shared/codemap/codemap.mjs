// codemap/v1 的核心逻辑：建索引、校验、应用需求变更集。
// 不依赖 Node API，Codemap 界面、主进程和命令行（scripts/codemap-validate.mjs）共用。
// 规则以这份为准；原来的 ~/dev/ai/codemap-site 已冻结，不再修改。类型声明在 codemap.d.mts。
//
// 输入有两类文件：
//   节点：一个文件一个顶层节点（nodes/*.yaml，或者按节点分文件夹：<节点>/<节点>.yaml）
//   链路：每条连线上的小球传什么数据。{ owner, links: [{ id, protocol, name, data }] }（links/*.yaml）

export const STRUCT_KINDS = new Set(['project', 'component', 'sdk', 'resource'])
// type / api 只出现在索引里：links/ 里的数据和链路
const ALL_KINDS = new Set([...STRUCT_KINDS, 'function', 'type', 'api'])
const EDGE_KINDS = new Set(['next', 'call', 'send', 'return'])
const SIGNALS = new Set(['data', 'ack', 'error', 'heartbeat'])
const PERIOD = /^\d+(\.\d+)?\s*(ms|s|m|h)$/
// tcp：Kafka 协议这类跑在 TCP 上的二进制协议
const PROTOCOLS = new Set(['grpc', 'http', 'tcp', 'mq', 'func', 'sql', 'redis'])
// 函数怎么被调起来（fn.trigger）
const TRIGGERS = new Set(['grpc', 'http', 'tcp', 'mq', 'cron', 'func'])
// 函数类型（fn.type），只决定显示效果：listen 监听（订阅 / channel / watch）、timer 定时（配 fn.every）
export const FN_TYPES = new Set(['listen', 'timer'])
// 连线的调用方式（edge.mode）：go 起协程、thread 起线程，调用方不等结果
export const EDGE_MODES = new Set(['go', 'thread'])
export const LANE_DOCKS = new Set(['top', 'bottom', 'left', 'right'])
// 连线从节点的哪一边出 / 进（edge.ports）；auto 表示这一端自动选边
export const PORT_SIDES = new Set(['top', 'bottom', 'left', 'right', 'auto'])
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const COMMIT = /^[0-9a-f]{7,40}$/

const KEYS = {
  node: new Set([
    'schema', 'id', 'kind', 'name', 'brief', 'desc', 'kb', 'issues', 'ignore',
    'repo', 'review', 'fn', 'resource',
    'contains', 'lanes', 'edges', 'flows', 'layout'
  ]),
  fn: new Set(['repo', 'code', 'trigger', 'type', 'every', 'serves', 'io', 'reads', 'writes', 'check', 'guards', 'outcome', 'terminal']),
  review: new Set(['status', 'commit', 'shape']),
  // dir 已废弃：认识它是为了报出 repo-dir（告诉你怎么改），而不是笼统的 unknown-key
  repo: new Set(['remote', 'dir', 'local']),
  reqCode: new Set(['file', 'new', 'diff']),
  kb: new Set(['title', 'url']),
  // 待核查的问题点：看代码时发现的疑点，这次不修
  issue: new Set(['desc', 'code']),
  // signal / period 已废弃：心跳写在链路上（links.yaml 的 heartbeat）。认识它们是为了报出 edge-heartbeat（告诉你怎么改）
  edge: new Set(['id', 'from', 'to', 'kind', 'mode', 'via', 'when', 'error', 'swallow', 'name', 'signal', 'period', 'ports', 'kb', 'ignore']),
  linkFile: new Set(['schema', 'owner', 'links']),
  link: new Set(['id', 'name', 'protocol', 'heartbeat', 'desc', 'data', 'kb', 'ignore']),
  data: new Set(['id', 'ref', 'name', 'dir', 'desc', 'repo', 'code', 'missing', 'fields', 'kb']),
  flow: new Set(['id', 'name', 'kind', 'period', 'refines', 'scenario', 'steps', 'kb', 'ignore']),
  step: new Set(['at', 'from', 'to', 'signal', 'data', 'title', 'label', 'sample', 'result', 'async', 'kb', 'ignore']),
  // 泳道只决定节点的初始位置，界面上不画框和名字；dock 把整条泳道放到地图的上 / 下 / 左 / 右
  lane: new Set(['id', 'name', 'scope', 'dock', 'nodes']),
  field: new Set(['name', 'type', 'desc', 'kb'])
}

// ---------- 小工具 ----------

export const prefixOf = (id) => {
  const i = id.lastIndexOf('.')
  return i < 0 ? null : id.slice(0, i)
}
export const asList = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value])

// 按节点分文件夹的节点库：yaml 文件按内容区分；这些目录不是节点（说明文档、本机配置）
export function fileKind(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (data.requirement !== undefined) return 'requirement'
    if (data.owner !== undefined && data.links !== undefined) return 'link'
  }
  return 'node'
}

// ---------- 忽略文件 ----------
// 节点库根目录的 .codemapignore：写在里面的目录 / 文件不读、不检查，其余全部读。写法同 .gitignore 的常用子集：
//   # 注释        空行忽略
//   docs/         以 / 结尾只匹配目录
//   告警          不带 / 的名字：任意层级同名的目录或文件
//   /_templates/  以 / 开头：只匹配节点库根目录下的
//   *.json        * 匹配除 / 以外的任意字符，** 跨层级
//   !keep.yaml    以 ! 开头：取消前面的忽略
// 没有 .codemapignore 时用 DEFAULT_IGNORE
export const IGNORE_FILE = '.codemapignore'
export const DEFAULT_IGNORE = ['.*', 'node_modules/', 'docs/', 'local/']

export function parseIgnore(text) {
  const rules = []
  for (let line of String(text ?? '').split(/\r?\n/)) {
    line = line.trim()
    if (!line || line.startsWith('#')) continue
    const negate = line.startsWith('!')
    if (negate) line = line.slice(1)
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    const anchored = line.startsWith('/') || line.includes('/')
    line = line.replace(/^\//, '')
    if (!line) continue
    const body = line.split('/').map((seg) => (seg === '**' ? '(?:.*)' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/')
    const re = new RegExp(anchored ? `^${body.replace(/\/\(\?:\.\*\)/g, '(?:/.*)?')}$` : `(?:^|/)${body}$`)
    rules.push({ re, negate, dirOnly })
  }
  return rules
}

// rel：相对节点库根目录的路径（用 / 分隔，不以 / 开头）；isDir：是不是目录
export function isIgnored(rules, rel, isDir) {
  let hit = false
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue
    if (r.re.test(rel)) hit = !r.negate
  }
  return hit
}

// 节点 contains 里 { ref, path } 形式的引用（含就地定义节点里的）
export function refPaths(node) {
  const out = []
  const walk = (n) => {
    for (const item of Array.isArray(n?.contains) ? n.contains : []) {
      if (!item || typeof item !== 'object') continue
      if (typeof item.ref === 'string') out.push({ ref: item.ref, path: typeof item.path === 'string' ? item.path : '' })
      else walk(item)
    }
  }
  walk(node)
  return out
}

// ---------- 函数 ----------
// kind: function 的专有字段都在 fn 里。函数在执行图里的角色由字段推出来：
//   entry 入口：写了 trigger 或 serves
//   gate  闸门：写了 check（画成菱形，要有通过 / 不通过两个分支）
//   end   结束：写了 outcome（success / error）
//   step  普通步骤：其他
export const fnOf = (n) => (n?.kind === 'function' && n.fn && typeof n.fn === 'object' ? n.fn : {})
export function roleOf(n) {
  if (n?.kind !== 'function') return null
  const f = fnOf(n)
  if (f.outcome !== undefined) return 'end'
  if (f.check !== undefined) return 'gate'
  if (f.trigger !== undefined || f.serves !== undefined) return 'entry'
  return 'step'
}

// 代码位置写成一个字符串，文件是仓库根目录下的完整路径：
//   "order/controller/x.go:35-44"  文件 + 行号
//   "service/order.go:42"             文件 + 一行
//   "28-32"                           只写行号：函数内部的代码块，文件和仓库都用外层函数的
//   "service/order.go"                只写文件
// 返回 { file, lines: [起, 止] | null, bad }，bad 表示行号写错
export function parseCode(code) {
  if (code === undefined || code === null || code === '') return null
  const s = String(code).trim()
  const range = (a, b) => {
    const x = +a, y = b === undefined ? x : +b
    return x >= 1 && y >= x ? [x, y] : 'bad'
  }
  let m = /^(\d+)(?:-(\d+))?$/.exec(s)
  if (m) {
    const r = range(m[1], m[2])
    return { file: null, lines: r === 'bad' ? null : r, bad: r === 'bad' }
  }
  m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(s)
  if (m) {
    const r = range(m[2], m[3])
    return { file: m[1], lines: r === 'bad' ? null : r, bad: r === 'bad' }
  }
  return { file: s, lines: null, bad: false }
}
// 节点的代码位置：函数写在 fn.code，links/ 里的数据写在 code
export const codeOf = (n) => (n?.kind === 'function' ? fnOf(n).code : n?.kind === 'type' ? n.code : undefined)
// 代码在哪个仓库：和代码位置写在一起。函数写在 fn.repo，数据写在 repo
export const codeRepoOf = (n) => (n?.kind === 'function' ? fnOf(n).repo : n?.kind === 'type' ? n.repo : undefined)
const isAbsPath = (p) => String(p).startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
const hasDotDot = (p) => String(p).split(/[\\/]/).includes('..')

export function groupBy(list, key) {
  const map = new Map()
  for (const item of list) {
    if (!map.has(item[key])) map.set(item[key], [])
    map.get(item[key]).push(item)
  }
  return map
}

// 示例载荷形如 `Type{ A: 1, B: [..] }` 时，取出类型名和最外层的 字段: 值
export function sampleEntries(text) {
  const head = /^\s*([A-Za-z_]\w*)\s*\{/.exec(String(text ?? ''))
  if (!head) return null
  const entries = []
  let depth = 0
  let quote = null
  let token = ''
  let expectKey = true
  let cur = null
  const add = (c) => {
    if (cur) cur.value += c
  }
  for (let i = text.indexOf('{'); i < text.length; i++) {
    const c = text[i]
    if (quote) {
      add(c)
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      add(c)
      continue
    }
    if ('{[('.includes(c)) {
      depth++
      if (depth === 1) expectKey = true
      else add(c)
      continue
    }
    if ('}])'.includes(c)) {
      depth--
      if (depth === 0) break
      add(c)
      continue
    }
    if (depth !== 1) {
      add(c)
      continue
    }
    if (c === ',') {
      expectKey = true
      token = ''
      cur = null
    } else if (expectKey) {
      if (/\w/.test(c)) token += c
      else if (c === ':' && token) {
        cur = { key: token, value: '' }
        entries.push(cur)
        expectKey = false
        token = ''
      } else if (!/\s/.test(c)) {
        expectKey = false
        token = ''
      }
    } else add(c)
  }
  for (const e of entries) e.value = e.value.trim()
  return { type: head[1], entries }
}
export function sampleKeys(text) {
  const r = sampleEntries(text)
  return r && { type: r.type, keys: r.entries.map((e) => e.key) }
}

// ---------- 链路与数据 ----------
// 链路 = 一条连线上的小球传什么数据，写在 links/ 下。全局 id 是 owner.链路id。
// 链路的 data 列表：每一条就地定义一个数据类型（写 id，全局 id 是 owner.数据id），
// 或者引用已有的（写 ref）；dir 是方向，request 去（默认）/ response 回。
// 连线上 via 写链路 id，一条线走多条链路时写列表。

export const dataDir = (item) => (item?.dir === 'response' ? 'response' : 'request')
export const normRepo = (r) => (typeof r === 'string' ? { remote: r } : r && typeof r === 'object' ? r : null)
// 用 remote 认出同一个仓库：git@host:a/b.git、https://host/a/b、ssh://git@host/a/b 算同一个
export function repoKey(repo) {
  const remote = String(repo?.remote ?? '').trim()
  if (!remote) return null
  return remote
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(':', '/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

// 节点文件所在目录（相对节点库根目录）：kb 的相对路径从这里算
export const dirOf = (file) => (file && file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '')

// 把相对路径拼到目录上，处理 ./ 和 ../；结果仍是相对节点库根目录的路径（可以以 ../ 开头）
export function joinPath(base, rel) {
  const out = base ? base.split('/') : []
  for (const seg of String(rel).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

// kb 条目的实际路径：http(s) 和绝对路径原样返回，相对路径按节点所在目录展开
export function kbPath(url, nodeFile) {
  if (/^https?:\/\//i.test(url) || String(url).startsWith('/') || /^[A-Za-z]:[\\/]/.test(url)) return url
  return joinPath(dirOf(nodeFile), url)
}

// 一条链路上的数据：{ apiId, api, items: [{ type, dir, item }] }
export function apiData(model, via, map) {
  const apiId = typeof via === 'string' ? model.resolve(via, map) : null
  const api = apiId && model.nodes.get(apiId).node.kind === 'api' ? model.nodes.get(apiId).node : null
  const prefix = apiId ? prefixOf(apiId) : null
  const items = asList(api?.data)
    .filter((it) => it && typeof it === 'object')
    .map((it) => ({ item: it, dir: dataDir(it), type: it.id ? (prefix ? `${prefix}.${it.id}` : it.id) : it.ref ? model.resolve(it.ref, apiId) : null }))
  return { apiId: api ? apiId : null, api, items }
}

// 链路是不是心跳：heartbeat: true（周期由客户端配置）或周期字符串；返回周期，没写周期返回 ''，不是心跳返回 null
export function heartbeatOf(api) {
  const hb = api?.heartbeat
  if (hb === true) return ''
  if (typeof hb === 'string' && PERIOD.test(hb)) return hb
  return null
}

// 连线上的数据：via 指向的链路里的数据，分成请求和响应
export function edgeData(model, map, e) {
  const vias = e?.via === undefined || e?.via === null ? [] : Array.isArray(e.via) ? e.via : [e.via]
  const apis = vias.map((v) => apiData(model, v, map))
  const items = apis.flatMap((a) => a.items)
  const pick = (dir) => [...new Set(items.filter((i) => i.dir === dir && i.type).map((i) => i.type))]
  return { apis, items, request: pick('request'), response: pick('response') }
}

// 沿连线走一步时可能传的数据：正着走取请求；逆着 call 走、或者走 return 线，取响应
export const stepChoices = (ed, back, kind) => (back || kind === 'return' ? ed.response : ed.request)

// 函数的输入输出：写了 fn.io 用 fn.io，否则从它 fn.serves 的链路取
export function ioOf(model, id) {
  const n = model.nodes.get(id)?.node
  if (!n) return { in: [], out: null }
  const f = fnOf(n)
  if (f.io) return { in: asList(f.io.in).map((t) => model.resolve(t, id)).filter(Boolean), out: f.io.out ? model.resolve(f.io.out, id) : null }
  const ins = [], outs = []
  for (const ref of asList(f.serves)) {
    const d = apiData(model, ref, id)
    for (const it of d.items) (it.dir === 'response' ? outs : ins).push(it.type)
  }
  return { in: ins.filter(Boolean), out: outs.find(Boolean) ?? null }
}

// ---------- 建索引 ----------
// 节点只定义一次：独立文件，或者就地写在 contains 里（全局 id = 外层 id + "." + 短 id）。
// contains 里写字符串是引用，同一个节点可以被多个节点包含。
// 链路和数据在索引里也是节点（kind: api / type），这样引用、字段反查用同一套查找。

export function buildModel(docs, linkDocs = []) {
  const nodes = new Map() // 全局 id → { node, file, how, owner, list }
  const flows = new Map() // 全局流程 id → { flow, map }
  const members = new Map() // 地图节点 id → 包含的节点 id 列表
  const containedBy = new Map() // 节点 id → Set(包含它的节点 id)
  // contains 里 { ref, path } 引用的节点：画在这张图上（外部框），但不属于这个节点，不算包含关系
  const refs = new Map() // 地图节点 id → Set(引用的节点 id)
  const issues = []
  const report = (level, rule, where, msg) => issues.push({ level, rule, where, msg })

  const define = (obj, id, file, how, owner, list) => {
    if (nodes.has(id)) {
      report('error', 'id-unique', `${file} 节点 ${id}`, `id 重复（已在 ${nodes.get(id).file} 定义）`)
      return
    }
    nodes.set(id, { node: obj, file, how, owner, list })
    if (obj.contains !== undefined && !Array.isArray(obj.contains)) {
      report('error', 'node-format', `${file} 节点 ${id}`, 'contains 必须是列表')
      return
    }
    for (const item of obj.contains ?? []) {
      if (item && typeof item === 'object') {
        if (item.ref !== undefined) {
          const extra = Object.keys(item).filter((k) => k !== 'ref' && k !== 'path')
          if (extra.length) report('warn', 'unknown-key', `${file} 节点 ${id}`, `引用 ${item.ref} 只写 ref 和 path：多了 ${extra.join(', ')}`)
          if (item.path !== undefined && typeof item.path !== 'string') report('error', 'ref-path', `${file} 节点 ${id}`, `引用 ${item.ref} 的 path 要写成字符串`)
          continue
        }
        if (typeof item.id !== 'string' || !SEGMENT.test(item.id)) {
          report('error', 'id-format', `${file} 节点 ${id}`, `就地定义的 id 只能是一段（不带 "."）：${JSON.stringify(item.id)}`)
          continue
        }
        define(item, `${id}.${item.id}`, file, 'contains', id, obj.contains)
      } else if (typeof item !== 'string') {
        report('error', 'node-format', `${file} 节点 ${id}`, `contains 里的 ${JSON.stringify(item)} 既不是引用也不是节点`)
      }
    }
  }

  for (const doc of docs) {
    const id = doc.node?.id
    if (typeof id !== 'string' || !id.split('.').every((s) => SEGMENT.test(s))) {
      report('error', 'id-format', doc.file, `文件顶层节点的 id 不合法：${JSON.stringify(id)}`)
      continue
    }
    define(doc.node, id, doc.file, 'file', null, null)
  }

  // links/：每个文件 { owner, links }，链路 id 是 owner.链路id，数据 id 是 owner.数据id
  const linkOwners = []
  for (const doc of linkDocs) {
    const where = doc.file
    const owner = doc.data?.owner
    if (typeof owner !== 'string' || !owner) {
      report('error', 'link-owner', where, '链路文件要写 owner（这些链路属于哪个节点）')
      continue
    }
    linkOwners.push({ owner, file: where })
    const links = doc.data.links
    if (!Array.isArray(links)) {
      report('error', 'link-format', where, 'links 必须是列表')
      continue
    }
    for (const link of links) {
      if (!link || typeof link !== 'object' || typeof link.id !== 'string' || !SEGMENT.test(link.id)) {
        report('error', 'id-format', where, `链路 id 只能是一段（不带 "."）：${JSON.stringify(link?.id)}`)
        continue
      }
      const lid = `${owner}.${link.id}`
      if (nodes.has(lid)) {
        report('error', 'id-unique', `${where} 链路 ${lid}`, `id 重复（已在 ${nodes.get(lid).file} 定义）`)
        continue
      }
      // 索引里按节点存，kind 固定为 api；原始对象不改，name 默认等于 id
      nodes.set(lid, { node: { ...link, kind: 'api', name: link.name ?? link.id }, raw: link, file: where, how: 'link', owner, list: links })
      if (link.data !== undefined && !Array.isArray(link.data)) {
        report('error', 'link-format', `${where} 链路 ${lid}`, 'data 必须是列表')
        continue
      }
      for (const item of link.data ?? []) {
        if (!item || typeof item !== 'object' || item.ref) continue
        if (typeof item.id !== 'string' || !SEGMENT.test(item.id)) {
          report('error', 'id-format', `${where} 链路 ${lid}`, `data 里的 id 只能是一段：${JSON.stringify(item.id)}`)
          continue
        }
        const tid = `${owner}.${item.id}`
        if (nodes.has(tid)) {
          report('error', 'id-unique', `${where} 链路 ${lid}`, `数据 ${tid} 重复（已在 ${nodes.get(tid).file} 定义）；多条链路传同一份数据时写 ref`)
          continue
        }
        nodes.set(tid, { node: { ...item, kind: 'type', name: item.name ?? item.id }, raw: item, file: where, how: 'data', owner: lid, list: link.data })
      }
    }
  }
  for (const { owner, file } of linkOwners) {
    if (!nodes.has(owner) || ['api', 'type'].includes(nodes.get(owner).node.kind)) report('error', 'link-owner', file, `owner ${owner} 不是已有节点`)
  }
  for (const doc of docs) {
    const owner = typeof doc.node?.id === 'string' ? prefixOf(doc.node.id) : null
    if (owner && !nodes.has(owner)) {
      report('error', 'id-prefix', doc.file, `id 前缀 ${owner} 不是已有节点；带 "." 的 id 要挂在已有节点下面`)
    }
  }

  // 短 id 解析：从当前节点开始，沿 id 前缀逐层往外找，最后按全局 id 找
  const resolve = (name, scope, table = nodes) => {
    if (typeof name !== 'string' || !name) return null
    for (let s = scope; s; s = prefixOf(s)) if (table.has(`${s}.${name}`)) return `${s}.${name}`
    return table.has(name) ? name : null
  }

  for (const [id, { node: n, file }] of nodes) {
    if (!n.contains) continue
    const list = []
    for (const item of n.contains) {
      if (item && typeof item === 'object') {
        // 引用别处的节点：{ ref: 全局 id, path: 它的文件夹（相对本 yaml 所在的文件夹） }
        if (item.ref !== undefined) {
          if (typeof item.ref !== 'string' || !item.ref.split('.').every((s) => SEGMENT.test(s))) {
            report('error', 'id-format', `${file} 节点 ${id}`, `contains 引用的 ref 不合法：${JSON.stringify(item.ref)}`)
            continue
          }
          const target = resolve(item.ref, id)
          if (target === id) report('error', 'contains-self', `${file} 节点 ${id}`, '节点不能包含自己')
          else if (target) {
            list.push(target)
            if (!refs.has(id)) refs.set(id, new Set())
            refs.get(id).add(target)
          }
          else {
            // 读不到：放一个占位节点，图上照样画（点不开），提示去配置 path
            const path = typeof item.path === 'string' ? item.path : ''
            if (!nodes.has(item.ref)) nodes.set(item.ref, { node: { id: item.ref, name: item.ref, kind: 'component' }, file, how: 'missing', owner: null, list: null, path, from: id })
            list.push(item.ref)
            if (!refs.has(id)) refs.set(id, new Set())
            refs.get(id).add(item.ref)
          }
          continue
        }
        if (typeof item.id === 'string' && SEGMENT.test(item.id)) list.push(`${id}.${item.id}`)
        continue
      }
      const target = resolve(item, id)
      if (!target) report('error', 'ref-missing', `${file} 节点 ${id}`, `contains 引用的 ${item} 不存在`)
      else if (target === id) report('error', 'contains-self', `${file} 节点 ${id}`, '节点不能包含自己')
      else list.push(target)
    }
    const seen = new Set()
    for (const target of list) {
      if (seen.has(target)) report('error', 'contains-dup', `${file} 节点 ${id}`, `${target} 重复包含`)
      seen.add(target)
      if (refs.get(id)?.has(target)) continue
      if (!containedBy.has(target)) containedBy.set(target, new Set())
      containedBy.get(target).add(id)
    }
    members.set(id, [...seen])
    for (const f of n.flows ?? []) {
      if (typeof f.id !== 'string' || !SEGMENT.test(f.id)) {
        report('error', 'id-format', `${file} 节点 ${id}`, `流程 id 不合法：${JSON.stringify(f.id)}`)
        continue
      }
      const full = `${id}.${f.id}`
      if (nodes.has(full) || flows.has(full)) report('error', 'id-unique', `${file} 流程 ${full}`, 'id 重复')
      else flows.set(full, { flow: f, map: id })
    }
  }
  return { nodes, flows, members, containedBy, refs, issues, resolve }
}

// ---------- 代码锚点 ----------
// 每个代码位置自带仓库：repo 和 code 写在同一处（函数的 fn，数据条目），路径 = repo.local + code，
// 不从外层节点继承。唯一的例外是函数内部的代码块：code 只写行号时，文件和仓库都用外层函数的。

// 只写行号时，外层最近一个写了文件的函数（id 前缀上找）
// 待核查（issues）的代码位置：只写行号时指节点自己代码文件里的行；自己没写文件，再按外层函数的文件算
export function issueCode(model, id, code) {
  if (code === undefined || code === null) return null
  const own = parseCode(codeOf(model.nodes.get(id)?.node))
  const p = parseCode(code)
  return p && !p.file && own?.file ? `${own.file}:${String(code).trim()}` : String(code)
}

export function scopeAnchorFor(model, id) {
  for (let s = prefixOf(id); s; s = prefixOf(s)) {
    const n = model.nodes.get(s)?.node
    const p = parseCode(codeOf(n))
    if (p?.file) return { id: s, file: p.file }
  }
  return null
}

// 代码位置用的仓库写在哪个节点上：自己写了 repo 就是自己；只写行号时是提供文件的外层函数
export function repoFor(model, id) {
  const n = model.nodes.get(id)?.node
  if (codeRepoOf(n) !== undefined) return id
  const p = parseCode(codeOf(n))
  if (p && !p.file) {
    const scope = scopeAnchorFor(model, id)
    if (scope && codeRepoOf(model.nodes.get(scope.id)?.node) !== undefined) return scope.id
  }
  return null
}

// 把代码位置展开成可以直接定位的形式：哪个仓库、哪个文件、哪几行。
//   code 不传时取节点自己的代码位置；需求里拟写的代码传它的 file（仓库用节点自己的）
export function resolveCode(model, id, code = codeOf(model.nodes.get(id)?.node)) {
  const p = parseCode(code)
  if (!p) return null
  let file = p.file
  if (!file) file = scopeAnchorFor(model, id)?.file ?? null
  const repoId = repoFor(model, id)
  // 组件上的待核查：组件没有 fn.repo，代码在组件自己的 repo 里
  const self = model.nodes.get(id)
  const own = !repoId && self?.node?.kind !== 'function' && self?.node?.repo ? self : null
  const entry = repoId ? model.nodes.get(repoId) : own
  const repo = entry ? normRepo(repoId ? codeRepoOf(entry.node) : entry.node.repo) : null
  // repo.local 相对写 repo 的那个 yaml 所在的文件夹
  const local = repo?.local ? joinPath(dirOf(entry.file), repo.local) : null
  return { repoId, remote: repo?.remote ?? null, local, dir: '', file, lines: p.lines }
}

// ---------- 校验 ----------

export function validate(model) {
  const { nodes, flows, members, containedBy, resolve } = model
  const refsOf = (X) => model.refs?.get(X) ?? new Set()
  const issues = [...model.issues]
  let suppressed = 0
  const report = (level, rule, where, msg, el) => {
    if (el?.ignore && Object.hasOwn(el.ignore, rule)) {
      suppressed++
      return
    }
    issues.push({ level, rule, where, msg })
  }
  const unknownKeys = (obj, kind, where) => {
    if (!obj || typeof obj !== 'object') return
    const extra = Object.keys(obj).filter((k) => !KEYS[kind].has(k))
    if (extra.length) report('warn', 'unknown-key', where, `不认识的字段 ${extra.join(', ')}`, obj)
  }
  // 属于“没读到的引用节点”的链路 / 类型：它们缺失是因为引用没配置好，只在 ref-path 那里提示一次
  const underMissing = (ref) => {
    for (let x = prefixOf(String(ref)); x; x = prefixOf(x)) if (nodes.get(x)?.how === 'missing') return true
    return false
  }
  const typeOf = (ref, scope, where, el) => {
    if (ref === undefined) return null
    const t = resolve(ref, scope)
    if (!t && underMissing(ref)) return null
    if (!t) report('error', 'ref-missing', where, `类型 ${ref} 不存在`, el)
    else if (nodes.get(t).node.kind !== 'type') report('error', 'not-type', where, `${ref} 不是 kind: type 的节点`, el)
    else return t
    return null
  }
  const apiOf = (ref, scope, where, el) => {
    const a = resolve(ref, scope)
    if (!a && underMissing(ref)) return null
    if (!a) report('error', 'ref-missing', where, `链路 ${ref} 不存在`, el)
    else if (nodes.get(a).node.kind !== 'api') report('error', 'not-api', where, `${ref} 不是 links/ 里的链路`, el)
    else return a
    return null
  }
  const checkIo = (io, scope, where, el) => {
    if (!io) return
    for (const t of asList(io.in)) typeOf(t, scope, where, el)
    typeOf(io.out, scope, where, el)
  }
  // 链路的 data：每条要么就地定义（id + fields），要么引用（ref）
  const checkData = (data, apiScope, where, el) => {
    const list = asList(data)
    if (!list.length) report('warn', 'api-data', where, '链路没写 data（这条线上传什么）', el)
    for (const it of list) {
      if (!it || typeof it !== 'object') {
        report('error', 'api-data', where, `data 里每一条要写成对象：${JSON.stringify(it)}`, el)
        continue
      }
      unknownKeys(it, 'data', `${where} 数据 ${it.id ?? it.ref ?? ''}`)
      if (it.dir !== undefined && !['request', 'response'].includes(it.dir)) report('error', 'api-data', where, `dir 只能是 request / response：${it.dir}`, el)
      if (it.ref) {
        typeOf(it.ref, apiScope, where, el)
        if (it.id || it.fields) report('error', 'api-data', where, `${it.ref}：写了 ref 就是引用已有类型，不能再写 id / fields`, el)
      } else if (!it.id) report('error', 'api-data', where, 'data 里每一条要写 id（就地定义）或者 ref（引用已有类型）', el)
      else {
        // 结构体在哪定义：repo + code；实在找不到写 missing: 原因
        const dw = `${where} 数据 ${it.id}`
        if (it.missing !== undefined) {
          if (typeof it.missing !== 'string' || !it.missing.trim()) report('error', 'data-repo', dw, 'missing 要写清为什么找不到定义', el)
          if (it.repo !== undefined || it.code !== undefined) report('warn', 'data-repo', dw, '写了 missing 就不用写 repo / code', el)
        } else {
          if (it.repo === undefined) report('error', 'data-repo', dw, '数据要写 repo（结构体在哪个仓库）；找不到定义就写 missing: 原因', el)
          if (it.code === undefined) report('error', 'data-repo', dw, '数据要写 code（仓库内路径:行号）；找不到定义就写 missing: 原因', el)
        }
      }
    }
  }
  const fieldOf = (ref, scope, where, el) => {
    const i = String(ref).lastIndexOf('.')
    if (i < 0) {
      report('error', 'field-format', where, `字段要写成 类型.字段：${ref}`, el)
      return null
    }
    const t = typeOf(ref.slice(0, i), scope, where, el)
    if (!t) return null
    const name = ref.slice(i + 1)
    if (!(nodes.get(t).node.fields ?? []).some((f) => f.name === name)) {
      report('error', 'ref-missing', where, `字段 ${ref} 不存在`, el)
      return null
    }
    return `${t}.${name}`
  }
  const checkKb = (kb, where, el) => {
    for (const item of asList(kb)) {
      if (!item || typeof item !== 'object' || !item.url) {
        report('error', 'kb-url', where, `kb 每一条要写 { title, url }：${JSON.stringify(item)}`, el)
        continue
      }
      unknownKeys(item, 'kb', `${where} 知识库`)
      if (!item.title) report('warn', 'kb-title', where, `kb 没写 title：${item.url}`, el)
      // url 可以是 http(s) 链接，也可以是文件路径（相对节点库目录，或者绝对路径）
      if (/^[a-z][a-z0-9+.-]*:/i.test(item.url) && !/^https?:\/\//i.test(item.url) && !/^[A-Za-z]:[\\/]/.test(item.url)) {
        report('error', 'kb-url', where, `kb 的 url 要么是 http(s) 链接，要么是文件路径：${item.url}`, el)
      }
    }
  }
  // 返回 { repo, file }，泳道范围检查和反查索引要用
  // 仓库：{ remote, local }；remote 认出是哪个仓库，local 是本机目录（相对写它的 yaml 所在的文件夹）
  const checkRepo = (repo, where, el) => {
    const r = normRepo(repo)
    if (!r?.remote) report('error', 'repo-remote', where, 'repo 要写仓库地址（git 远端，或者 Go 模块路径）', el)
    if (r && typeof repo === 'object') unknownKeys(repo, 'repo', `${where} repo`)
    if (r?.dir !== undefined) report('error', 'repo-dir', where, `repo 不再写 dir：code 直接写仓库根目录下的完整路径（把 ${r.dir}/ 加到 code 前面）`, el)
    if (r?.local !== undefined && (typeof r.local !== 'string' || !r.local)) report('error', 'repo-local', where, 'repo.local 写本机仓库目录（相对节点文件所在目录）', el)
    else if (r?.local && isAbsPath(r.local)) report('warn', 'repo-local', where, `repo.local 建议写相对路径，绝对路径只在你的电脑上有效：${r.local}`, el)
  }

  // 代码位置：一个字符串，"文件:行号"、"文件" 或者只写 "行号"；仓库和它写在一起（repo）
  const checkCode = (code, ownerId, where, el, repoValue) => {
    if (code === undefined) return null
    if (typeof code !== 'string' && typeof code !== 'number') {
      report('error', 'code-format', where, `code 写成一个字符串，比如 "service/order.go:35-44"：${JSON.stringify(code)}`, el)
      return null
    }
    const p = parseCode(code)
    if (p.bad) report('error', 'code-lines', where, `行号要写成 42 或 42-58：${code}`, el)
    let file = p.file
    if (file) {
      if (isAbsPath(file) || hasDotDot(file)) report('error', 'code-path', where, `只能写仓库内的相对路径：${file}`, el)
      if (repoValue === undefined) report('error', 'code-repo', where, '代码位置要和仓库写在一起：在 code 旁边写 repo: { remote, local }', el)
      if (!p.lines && !p.bad) report('info', 'code-lines', where, `${file} 没写行号，只能打开整个文件`, el)
    } else {
      const scope = scopeAnchorFor(model, ownerId)
      if (!scope) report('error', 'code-format', where, `只写行号时，外层要有节点写了文件：${code}`, el)
      else file = scope.file
    }
    const repoId = repoFor(model, ownerId)
    if (!p.file && repoValue === undefined && !repoId) report('error', 'code-repo', where, '外层函数没写 repo，读不到代码', el)
    return { repo: repoId ? repoKey(normRepo(codeRepoOf(nodes.get(repoId).node))) : null, file }
  }

  // ----- 节点 -----
  const anchorFile = new Map()
  for (const [id, { node: n, file, how, raw, path }] of nodes) {
    const where = `${file} ${how === 'link' ? '链路' : how === 'data' ? '数据' : '节点'} ${id}`
    // 引用了但没读到的节点：只提示去配置 path，不做别的检查
    if (how === 'missing') {
      if (!path) report('info', 'ref-path', where, `引用的 ${id} 没配置 path，图上画成占位框、点不开；在 contains 里写 { ref: ${id}, path: 它的文件夹 }`)
      else report('warn', 'ref-path', where, `引用的 ${id} 在 path ${path} 下没读到节点，检查路径`)
      continue
    }
    if (how === 'link') unknownKeys(raw, 'link', where)
    else if (how === 'data') unknownKeys(raw, 'data', where)
    else {
      unknownKeys(n, 'node', where)
      if (n.kind === 'type' || n.kind === 'api') report('error', 'node-kind', where, '数据类型和链路写在 links/ 里', n)
    }
    if (!n.kind) report('error', 'node-kind', where, '缺少 kind', n)
    else if (!ALL_KINDS.has(n.kind)) report('info', 'node-kind', where, `未知 kind ${n.kind}，按通用节点处理`, n)
    if (!n.name) report('error', 'node-name', where, '缺少 name', n)
    // 函数的专有字段都在 fn 里
    const f = fnOf(n)
    if (n.fn !== undefined) {
      if (n.kind !== 'function') report('warn', 'fn-kind', where, 'fn 只用在 kind: function 的节点上', n)
      else if (!n.fn || typeof n.fn !== 'object' || Array.isArray(n.fn)) report('error', 'fn-format', where, 'fn 要写成对象', n)
      else unknownKeys(n.fn, 'fn', `${where} fn`)
    }
    if (f.outcome !== undefined && !['success', 'error'].includes(f.outcome)) report('error', 'fn-outcome', where, 'fn.outcome 只能是 success / error', n)
    if (f.check !== undefined && !f.check) report('warn', 'gate-check', where, '闸门的 fn.check 是空的（校验什么）', n)
    if (n.kind === 'type') {
      if (!Array.isArray(n.fields) || !n.fields.length) report('warn', 'type-fields', where, '数据类型没有 fields', n)
      const names = new Set()
      for (const f of n.fields ?? []) {
        unknownKeys(f, 'field', `${where}.${f.name}`)
        if (!f.name) report('error', 'field-format', where, `字段缺少 name：${JSON.stringify(f)}`, n)
        if (names.has(f.name)) report('error', 'id-unique', where, `字段 ${f.name} 重复`, n)
        names.add(f.name)
        checkKb(f.kb, `${where}.${f.name}`, f)
      }
    }
    // 仓库：函数写在 fn.repo，数据写在条目上；组件节点上的 repo 只是说明（对应哪个仓库），不参与拼路径
    const codeRepo = codeRepoOf(n)
    if (codeRepo !== undefined) checkRepo(codeRepo, where, n)
    if (n.repo !== undefined && n.kind !== 'type') {
      checkRepo(n.repo, where, n)
      if (n.kind === 'function') report('error', 'code-repo', where, '函数的仓库写在 fn.repo（和 fn.code 写在一起）', n)
    }
    checkIo(f.io, id, where, n)
    if (how === 'link') {
      if (n.heartbeat !== undefined && n.heartbeat !== true && !PERIOD.test(String(n.heartbeat))) {
        report('error', 'link-heartbeat', where, `heartbeat 只能写 true（周期由客户端配置，写在 desc 里）或 500ms / 3s / 1m 这种周期：${JSON.stringify(n.heartbeat)}`, n)
      }
      if (!n.protocol) report('warn', 'api-protocol', where, '链路没写 protocol（grpc / http / mq / func …）', n)
      else if (!PROTOCOLS.has(n.protocol)) report('info', 'api-protocol', where, `未知协议 ${n.protocol}`, n)
      checkData(n.data, id, where, n)
      if (n.protocol === 'mq' && apiData(model, id, id).items.some((i) => i.dir === 'response')) report('warn', 'api-data', where, 'mq 链路没有 response', n)
    }
    if (f.serves !== undefined) {
      for (const ref of asList(f.serves)) apiOf(ref, id, where, n)
      if (f.io) report('info', 'serves', where, '写了 serves 后，输入输出从链路取，io 可以不写', n)
    }
    for (const key of ['reads', 'writes', 'guards']) for (const ref of asList(f[key])) fieldOf(ref, id, where, n)
    checkKb(n.kb, where, n)
    if (n.issues !== undefined) {
      if (!Array.isArray(n.issues)) report('error', 'issue-format', where, 'issues 要写成列表，每条 { desc, code }', n)
      else n.issues.forEach((it, i) => {
        const iw = `${where} 待核查第 ${i + 1} 条`
        if (!it || typeof it !== 'object' || typeof it.desc !== 'string' || !it.desc.trim()) {
          report('error', 'issue-format', iw, '每条待核查都要写 desc（问题是什么、影响是什么）', n)
          return
        }
        unknownKeys(it, 'issue', iw)
        // code 的仓库取节点自己的 fn.repo；只写行号时，文件取节点自己的 fn.code
        // 组件、服务这类不是函数的节点没有 fn.repo，就用节点自己的 repo
        if (it.code !== undefined) checkCode(issueCode(model, id, it.code), id, iw, n, codeRepoOf(n) ?? (n.kind !== 'function' ? n.repo : undefined) ?? (repoFor(model, id) ? {} : undefined))
      })
    }
    // 代码位置：函数在 fn.code + fn.repo，数据在 code + repo
    const code = codeOf(n)
    if (code !== undefined && how !== 'link') anchorFile.set(id, checkCode(code, id, where, n, codeRepo))
    else if (codeRepo !== undefined && n.kind === 'function') report('warn', 'code-repo', where, '写了 fn.repo 但没写 fn.code', n)
    if (n.kind === 'function' && code === undefined && !model.proposed?.has(id)) report('warn', 'code-missing', where, '函数没有关联代码（fn.code）', n)
    if (f.trigger !== undefined && !TRIGGERS.has(f.trigger)) report('warn', 'fn-trigger', where, `未知 trigger ${f.trigger}（grpc / http / tcp / mq / cron / func）`, n)
    if (f.type !== undefined && !FN_TYPES.has(f.type)) report('error', 'fn-type', where, `fn.type 只能是 listen（监听）或 timer（定时），写一个：${JSON.stringify(f.type)}`, n)
    if (f.type === 'timer' && !PERIOD.test(String(f.every ?? ''))) report('error', 'fn-type', where, `定时函数要写 fn.every（多久一次，500ms / 3s / 1m）${f.every === undefined ? '' : `：${f.every}`}`, n)
    if (f.every !== undefined && f.type !== 'timer') report('error', 'fn-type', where, 'fn.every 只用于定时函数（fn.type: timer）', n)
    // 校对状态：地图是否校对过、上次核对代码时的 commit 和结构指纹
    if (n.review !== undefined) {
      const r = n.review
      if (!r || typeof r !== 'object') report('error', 'review-format', where, 'review 要写成 { status, commit, shape }', n)
      else {
        unknownKeys(r, 'review', `${where} review`)
        if (r.status !== undefined && !['draft', 'reviewed'].includes(r.status)) report('error', 'review-format', where, `review.status 只能是 draft / reviewed：${r.status}`, n)
        if (r.commit !== undefined && !COMMIT.test(String(r.commit))) report('error', 'review-format', where, `review.commit 要写提交哈希：${r.commit}`, n)
        if ((r.commit === undefined) !== (r.shape === undefined)) report('warn', 'review-format', where, 'review 的 commit 和 shape 要一起写', n)
      }
    }
    if (!n.contains && (n.edges || n.flows || n.lanes)) report('error', 'map-format', where, '有 edges / flows / lanes 就必须有 contains', n)
  }

  // ----- 包含关系成环（递归调用时会出现，允许但提示）；{ ref } 只是画了邻居，不算包含 -----
  {
    const state = new Map()
    const visit = (id, trail) => {
      if (state.get(id) === 'done') return
      if (state.get(id) === 'active') {
        const cycle = [...trail.slice(trail.indexOf(id)), id]
        report('warn', 'contains-cycle', `${nodes.get(id).file} 节点 ${id}`, `包含关系成环：${cycle.join(' → ')}`)
        return
      }
      state.set(id, 'active')
      for (const m of (members.get(id) ?? []).filter((m) => !refsOf(id).has(m))) visit(m, [...trail, id])
      state.set(id, 'done')
    }
    for (const id of members.keys()) visit(id, [])
  }

  // ----- 地图 -----
  const closureCache = new Map()
  const closure = (id) => {
    if (closureCache.has(id)) return closureCache.get(id)
    // 只沿真正属于的成员往下走；{ ref } 引用的节点不属于 id
    const own = (x) => (members.get(x) ?? []).filter((m) => !refsOf(x).has(m))
    const out = new Set()
    const queue = own(id)
    while (queue.length) {
      const x = queue.shift()
      if (out.has(x)) continue
      out.add(x)
      queue.push(...own(x))
    }
    closureCache.set(id, out)
    return out
  }
  // 外部节点 ext 在地图 P 里显示成哪个成员：它自己，或者（间接）包含它的成员
  const liftIn = (P, ext, exclude) => {
    const mem = members.get(P) ?? []
    if (mem.includes(ext)) return ext
    return mem.find((m) => m !== exclude && !(model.refs?.get(P)?.has(m)) && closure(m).has(ext)) ?? null
  }
  const edgeEnds = (map, e) => [resolve(e.from, map), resolve(e.to, map)]
  const findEdge = (map, a, b, kind, error) => {
    const edges = (nodes.get(map).node.edges ?? []).map((e) => ({ e, ends: edgeEnds(map, e) }))
    const hits =
      kind === 'return'
        ? edges.filter(({ e, ends: [f, t] }) => (f === b && t === a && ['call', 'send'].includes(e.kind)) || (f === a && t === b && e.kind === 'return'))
        : edges.filter(({ ends: [f, t] }) => f === a && t === b)
    return (hits.find(({ e }) => Boolean(e.error) === Boolean(error)) ?? hits[0])?.e ?? null
  }
  // 两端相同的所有连线（同一对节点之间可以按接口画多条线）
  const edgesBetween = (map, a, b) => (nodes.get(map).node.edges ?? []).filter((e) => {
    const [f, t] = edgeEnds(map, e)
    return f === a && t === b
  })
  // 连线走的链路集合（全局 id）
  const viaSet = (map, e) => new Set(asList(e.via).map((v) => resolve(v, map)).filter(Boolean))
  const externalKeys = new Map() // `${X}|${P}` → Set(X 的外部连线放到 P 里之后的 key)

  for (const [X, mem] of members) {
    const { node: nX, file } = nodes.get(X)
    // 画在图上的节点（含 ref 引用的外部节点）；own 是真正属于这个节点的成员
    const shown = new Set(mem)
    const memSet = new Set(mem.filter((m) => !refsOf(X).has(m)))
    const W = `${file} 地图 ${X}`
    // 上一层：真正包含 X 的地图。用 { ref } 把 X 画进来的地图只是邻居，不要求它们把 X 的连线再画一遍
    const containers = [...(containedBy.get(X) ?? [])].filter((P) => !refsOf(P).has(X))

    // 泳道
    const laneOf = new Map()
    // 这张图的主仓库：图上函数用得最多的仓库（泳道 scope 按它核对）
    const repoCount = new Map()
    for (const m of memSet) {
      const r = anchorFile.get(m)?.repo
      if (r) repoCount.set(r, (repoCount.get(r) ?? 0) + 1)
    }
    const mapRepo = [...repoCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    for (const lane of nX.lanes ?? []) {
      unknownKeys(lane, 'lane', `${W} 泳道 ${lane.id}`)
      if (lane.dock !== undefined && !LANE_DOCKS.has(lane.dock)) report('error', 'lane-dock', `${W} 泳道 ${lane.id}`, `dock 只能是 top / bottom / left / right：${lane.dock}`, lane)
      const scopes = asList(lane.scope)
      for (const ref of asList(lane.nodes)) {
        const id = resolve(ref, X)
        if (!id || !shown.has(id)) {
          report('error', 'lane-node', `${W} 泳道 ${lane.id}`, `${ref} 不在这张地图的 contains 里`, lane)
          continue
        }
        if (laneOf.has(id)) report('error', 'lane-node', `${W} 泳道 ${lane.id}`, `${ref} 同时在泳道 ${laneOf.get(id)} 里`, lane)
        laneOf.set(id, lane.id)
        const anchor = anchorFile.get(id)
        // 泳道范围只核对和这张图的函数同一个仓库的代码
        if (scopes.length && anchor?.file && anchor.repo && anchor.repo === mapRepo && !scopes.some((s) => anchor.file.startsWith(s))) {
          report('warn', 'lane-scope', `${W} 泳道 ${lane.id}`, `${ref} 的代码在 ${anchor.file}，不在泳道范围（${scopes.join(' / ')}）内`, nodes.get(id).node)
        }
      }
    }
    if (nX.lanes?.length) {
      // 布局只看泳道：每个节点都要放进泳道，存储 / 依赖服务也一样（贴上下两边用 dock）
      for (const id of shown) if (!laneOf.has(id)) report('warn', 'lane-missing', W, `${id} 没有放进任何泳道`)
    }

    // 手动排过的位置：layout: { 节点: [x, y] }，只对这张图有效
    if (nX.layout !== undefined) {
      if (!nX.layout || typeof nX.layout !== 'object' || Array.isArray(nX.layout)) report('error', 'layout-format', W, 'layout 要写成 { 节点: [x, y] }', nX)
      else {
        for (const [ref, xy] of Object.entries(nX.layout)) {
          const id = resolve(ref, X)
          if (!id || !shown.has(id)) report('warn', 'layout-node', W, `layout 里的 ${ref} 不在这张地图的 contains 里`, nX)
          if (!Array.isArray(xy) || xy.length !== 2 || !xy.every((v) => typeof v === 'number' && Number.isFinite(v))) {
            report('error', 'layout-format', W, `layout 里 ${ref} 的位置要写成 [x, y]：${JSON.stringify(xy)}`, nX)
          }
        }
      }
    }

    // 连线
    const keys = new Map()
    for (const e of nX.edges ?? []) {
      const [a, b] = edgeEnds(X, e)
      const ew = `${W} 连线 ${e.id ?? `${e.from}->${e.to}`}`
      unknownKeys(e, 'edge', ew)
      if (e.ports !== undefined) {
        const ports = asList(e.ports)
        if (!ports.length || ports.length > 2 || !ports.every((p) => PORT_SIDES.has(p))) {
          report('error', 'edge-ports', ew, `ports 写成 [起点那边, 终点那边]，每个是 top / bottom / left / right / auto：${JSON.stringify(e.ports)}`, e)
        }
      }
      const kind = e.kind ?? 'next'
      if (!EDGE_KINDS.has(kind)) report('error', 'edge-kind', ew, `未知连线类型 ${kind}`, e)
      if (e.mode !== undefined && !EDGE_MODES.has(e.mode)) report('error', 'edge-mode', ew, `mode 只能是 go（协程）或 thread（线程）：${JSON.stringify(e.mode)}`, e)
      if (e.mode !== undefined && kind !== 'call' && kind !== 'send') report('error', 'edge-mode', ew, '起协程 / 线程的线要写 kind: call 或 send', e)
      checkKb(e.kb, ew, e)
      if (e.signal !== undefined || e.period !== undefined) {
        report('error', 'edge-heartbeat', ew, '连线上不写 signal / period：心跳写在 via 引用的链路上（links.yaml 里给这个接口加 heartbeat: true 或 3s）', e)
      }
      // 小球走的线（流程用到）要知道传什么数据；return、错误边、心跳这类只是控制流，不要求
      if (e.via === undefined) {
        const used = (nX.flows ?? []).some((f) => f.kind !== 'background' && (f.steps ?? []).some((s) => {
          const sf = resolve(s.from, X), st = resolve(s.to, X)
          return (sf === a && st === b) || (sf === b && st === a && kind === 'call')
        }))
        if (used && kind !== 'return' && !e.error) report('info', 'via-missing', ew, '流程走过这条线，但没写 via，小球不知道传什么数据', e)
      } else {
        const vias = Array.isArray(e.via) ? e.via : [e.via]
        if (!vias.length) report('error', 'via-format', ew, 'via 不能是空列表', e)
        for (const v of vias) {
          if (typeof v === 'string') apiOf(v, X, ew, e)
          else report('error', 'via-format', ew, 'via 写 links/ 里链路的 id，多条时写列表', e)
        }
      }
      if (!a || !b) {
        report('error', 'ref-missing', ew, `${!a ? e.from : e.to} 不存在`, e)
        continue
      }
      // 进出对应：连线传的数据，下游要有对应的入口（via 里至少一条链路属于下游节点或它的上层）
      if (e.via !== undefined && kind !== 'return' && nodes.get(b)?.how !== 'missing') {
        const owners = [...viaSet(X, e)].map((v) => prefixOf(v)).filter(Boolean)
        const downs = new Set([b])
        for (let s = b; s; s = prefixOf(s)) downs.add(s)
        // 投递到 mq / etcd 这类中间件，或者从中间件收消息：消息属于发布方，不检查
        const viaRes = nodes.get(b)?.node.kind === 'resource' || nodes.get(a)?.node.kind === 'resource'
        if (owners.length && !viaRes && !owners.some((o) => downs.has(o))) {
          report('warn', 'edge-unmatched', ew, `下游 ${b} 没有对应的入口：via 里的链路都不属于 ${b}，在 ${b} 的 links.yaml 里补上它接收的接口`, e)
        }
      }
      const key = e.id ?? `${a}->${b}`
      if (keys.has(key)) report('error', 'edge-unique', ew, '同一对节点之间有多条连线时，要给连线写 id', e)
      keys.set(key, e)
      if (!shown.has(a) || !shown.has(b)) {
        report('error', 'edge-endpoint', ew, `${!shown.has(a) ? e.from : e.to} 不在这张地图的 contains 里：外部节点也要写进 contains（{ ref, path }）`, e)
        continue
      }
      const inA = memSet.has(a)
      const inB = memSet.has(b)
      if (!inA && !inB) continue
      if (inA && inB) continue
      const ext = inA ? b : a
      if (ext === X) {
        report('error', 'edge-endpoint', ew, '连线不能连到地图自己', e)
        continue
      }
      // 外部连线：在每个包含 X、并且能看到外部节点的地图里，都要有对应的连线
      let visible = false
      for (const P of containers) {
        const m = liftIn(P, ext, X)
        if (!m) continue
        visible = true
        const k = `${X}|${P}`
        if (!externalKeys.has(k)) externalKeys.set(k, new Set())
        externalKeys.get(k).add(kind === 'return' ? `${m}->${X}` : inA ? `${X}->${m}` : `${m}->${X}`)
        const match = inA ? findEdge(P, X, m, kind, e.error) : findEdge(P, m, X, kind, e.error)
        if (!match) {
          report('error', 'edge-lift', ew, `放到 ${P} 里是 ${inA ? `${X} → ${m}` : `${m} → ${X}`}，但 ${P} 里没有这条连线`, e)
        } else if (kind !== 'return' && Boolean(match.error) !== Boolean(e.error)) {
          report('warn', 'edge-lift', ew, `${P} 里对应的连线${match.error ? '是' : '不是'}错误边，两边要一致`, e)
        } else if (kind !== 'return' && e.via && match.via) {
          // 下层连线走的接口，必须包含在上层对应连线的接口里
          // 上层同一对节点之间按接口分成了几条线时，合起来算
          const mine = viaSet(X, e)
          const theirs = new Set((inA ? edgesBetween(P, X, m) : edgesBetween(P, m, X)).flatMap((x) => [...viaSet(P, x)]))
          const extra = [...mine].filter((v) => !theirs.has(v))
          if (extra.length) report('error', 'edge-lift', ew, `走的接口是 ${extra.join(', ')}，但 ${P} 里对应的连线只走 ${[...theirs].join(', ')}`, e)
        }
      }
      if (containers.length && !visible) report('warn', 'edge-orphan', ew, `外部节点 ${ext} 在包含 ${X} 的地图里都看不到`, e)
    }

    // 流程
    const stepEdge = (from, to) => {
      for (const e of nX.edges ?? []) {
        const [a, b] = edgeEnds(X, e)
        if (a === from && b === to) return { e, back: false }
      }
      for (const e of nX.edges ?? []) {
        const [a, b] = edgeEnds(X, e)
        if (a === to && b === from && e.kind === 'call') return { e, back: true }
      }
      return null
    }
    // 流程跳步时，找出从已经到过的节点走到 target 的最短连线路径（不含起点，含 target）
    const shortOf = (id, map) => (id && id.startsWith(map + '.') ? id.slice(map.length + 1) : id)
    const missingPath = (reached, target) => {
      const next = new Map()
      for (const e of nX.edges ?? []) {
        const [a, b] = edgeEnds(X, e)
        if (!a || !b) continue
        if (!next.has(a)) next.set(a, [])
        next.get(a).push(b)
      }
      const prev = new Map()
      const queue = [...reached]
      const seen = new Set(queue)
      while (queue.length) {
        const cur = queue.shift()
        if (cur === target) break
        for (const b of next.get(cur) ?? []) {
          if (seen.has(b)) continue
          seen.add(b)
          prev.set(b, cur)
          queue.push(b)
        }
      }
      if (!prev.has(target)) return null
      const path = []
      for (let cur = target; cur && !reached.has(cur); cur = prev.get(cur)) path.unshift(cur)
      const start = prev.get(path[0])
      return start ? [start, ...path] : path
    }

    for (const f of nX.flows ?? []) {
      const full = `${X}.${f.id}`
      const fw = `${file} 流程 ${full}`
      unknownKeys(f, 'flow', fw)
      checkKb(f.kb, fw, f)
      if (f.kind && !['main', 'background'].includes(f.kind)) report('error', 'flow-kind', fw, `未知流程类型 ${f.kind}`, f)
      const background = f.kind === 'background'
      if (background && !f.period) report('warn', 'flow-period', fw, '后台流程要写 period（周期）', f)
      for (const key of Object.keys(f.scenario?.values ?? {})) fieldOf(key, X, `${fw} scenario`, f)
      const steps = f.steps ?? []
      if (!steps.length) report('error', 'flow-empty', fw, '流程没有步骤', f)
      const reached = new Set()
      const crossing = []
      steps.forEach((s, i) => {
        const sw = `${fw} 第 ${i + 1} 步`
        unknownKeys(s, 'step', sw)
        checkKb(s.kb, sw, s)
        if (s.signal && !SIGNALS.has(s.signal)) report('error', 'step-signal', sw, `未知小球类型 ${s.signal}`, s)
        const picked = typeOf(s.data, X, sw, s)
        if (s.at) {
          const at = resolve(s.at, X)
          if (!at || !shown.has(at)) report('error', 'ref-missing', sw, `${s.at} 不在这张地图里`, s)
          reached.add(at)
          return
        }
        const from = resolve(s.from, X)
        const to = resolve(s.to, X)
        if (!from || !to) {
          report('error', 'ref-missing', sw, `${s.from} → ${s.to} 引用了不存在的节点`, s)
          return
        }
        const hit = stepEdge(from, to)
        if (!hit) report('error', 'step-edge', sw, `${s.from} → ${s.to} 不在这张地图的任何一条连线上`, s)
        if (!background && reached.size && !reached.has(from)) {
          // 告诉写的人缺了哪几步：从已经到过的节点沿连线走到 from 的最短路径
          const gap = missingPath(reached, from)
          const tip = gap ? `，中间少了 ${gap.map((id) => shortOf(id, X)).join(' → ')}，把这几步补进流程` : `，前面的步骤要先走到 ${s.from}`
          report('error', 'step-reached', sw, `小球还没到过 ${s.from}${tip}`, s)
        }
        reached.add(from)
        reached.add(to)
        if (memSet.has(from) !== memSet.has(to)) crossing.push([from, to])

        // 这一步传的数据：从连线上的数据里选；有多种时用 data 指明
        const ed = hit ? edgeData(model, X, hit.e) : null
        const choices = ed ? stepChoices(ed, hit.back, hit.e.kind) : []
        if (picked && ed && choices.length && !choices.includes(picked)) {
          report('error', 'step-data', sw, `data ${s.data} 不在这条连线的${hit.back || hit.e.kind === 'return' ? '响应' : '请求'}数据里（${choices.join(', ')}）`, s)
        }
        if (!picked && choices.length > 1 && !background) {
          report('warn', 'step-data', sw, `这条连线上有 ${choices.length} 种数据（${choices.map((c) => nodes.get(c)?.node.name ?? c).join(', ')}），用 data 指明这一步传的是哪一种`, s)
        }

        // 示例载荷：字段名必须真实存在
        const sample = typeof s.sample === 'string' ? sampleKeys(s.sample) : null
        if (!sample) return
        const type = picked ?? (choices.length === 1 ? choices[0] : null)
        let target = null
        if (type) {
          if (nodes.get(type).node.name === sample.type) target = type
          else if ([...nodes.values()].some((x) => x.node.kind === 'type' && x.node.name === sample.type)) {
            report('warn', 'sample-type', sw, `示例是 ${sample.type}，但这一步传的是 ${nodes.get(type).node.name}`, s)
          }
        } else {
          const candidates = [...nodes].filter(([, x]) => x.node.kind === 'type' && x.node.name === sample.type)
          if (candidates.length === 1) target = candidates[0][0]
        }
        if (target) {
          const names = new Set((nodes.get(target).node.fields ?? []).map((x) => x.name))
          const unknown = sample.keys.filter((k) => !names.has(k))
          if (unknown.length) report('error', 'sample-field', sw, `示例里的字段 ${unknown.join(', ')} 在 ${target} 里不存在`, s)
        }
      })

      // 跨层连续：进出 X 的步骤，要和上一层流程里进出 X 的步骤按顺序一一对应
      if (f.refines) {
        const target = resolve(f.refines, X, flows)
        if (!target) report('error', 'ref-missing', fw, `refines 的流程 ${f.refines} 不存在`, f)
        else {
          const P = flows.get(target).map
          if (!(members.get(P) ?? []).includes(X)) report('error', 'flow-refines', fw, `${target} 所在的 ${P} 没有包含（或引用）${X}`, f)
          else {
            const mine = crossing
              .map(([a, b]) => [memSet.has(a) ? X : liftIn(P, a, X), memSet.has(b) ? X : liftIn(P, b, X)])
              .map(([a, b]) => `${a}→${b}`)
            const theirs = (flows.get(target).flow.steps ?? [])
              .filter((s) => s.from && [resolve(s.from, P), resolve(s.to, P)].includes(X))
              .map((s) => `${resolve(s.from, P)}→${resolve(s.to, P)}`)
            if (mine.join() !== theirs.join()) {
              report('error', 'flow-refines', fw, `进出 ${X} 的步骤和 ${target} 对不上\n      本层：${mine.join(', ')}\n      上层：${theirs.join(', ')}`, f)
            }
          }
        }
      }
    }

    checkExec(X, nX, file, memSet)
  }

  // 双方都要说明：地图 P 里有一条 call / send 线，一端 X 有自己的地图，那么 X 的地图里必须有一条
  // 方向相同的线：外侧那端是 P 里的另一端（或它的某个上层），里侧那端是 X 里面的节点；
  // 两边都写了 via 时，X 那边这些线的 via 合起来要包含 P 这条线的（上层一条线常常是下层几条线的汇总）。
  // 不管 X 是被包含还是被 { ref } 引用，调用和被调用的两边都要画出这条线。
  const selfAndUp = (id) => {
    const out = []
    for (let s = id; s; s = prefixOf(s)) out.push(s)
    return out
  }
  for (const [P] of members) {
    const { node: nP, file } = nodes.get(P)
    for (const e of nP.edges ?? []) {
      if (e.kind !== 'call' && e.kind !== 'send') continue
      const [a, b] = edgeEnds(P, e)
      // X 在线的哪一头都要查：[X, 另一端, X 是不是终点]
      for (const [X, other, xIsTo] of [
        [b, a, true],
        [a, b, false]
      ]) {
        // X 没有自己的地图（比如 redis、mq-client）就不查；只用来归类、自己没画连线的框（比如
        // 「共用」只收了组状态、锁、通知）也不查，它里面的节点各自的地图会查
        if (!X || !other || X === P || !members.has(X)) continue
        if (!(nodes.get(X).node.edges ?? []).length) continue
        // 另一端：它本身、它的上层，或者它里面的节点都算对上。比如上层画 下单 → 共用，
        // 下单的图里画的是 admit → 共用里的「组状态」，也算画了这条调用（via 仍要合起来对得上）
        const outer = new Set([...selfAndUp(other), ...closure(other)])
        const inner = closure(X)
        const hits = (nodes.get(X).node.edges ?? []).filter((e2) => {
          if (e2.kind === 'return') return false
          const [a2, b2] = edgeEnds(X, e2)
          return xIsTo ? outer.has(a2) && inner.has(b2) : inner.has(a2) && outer.has(b2)
        })
        const where = `${file} 地图 ${P} 连线 ${e.from}->${e.to}`
        if (!hits.length) {
          report(
            'error',
            'edge-mutual',
            where,
            xIsTo
              ? `${X} 的地图里没有说明这条调用从哪来：要画 ${other}（或它的上层、它里面的节点）→ ${X} 里的节点`
              : `${X} 的地图里没有画出这条调用：要画 ${X} 里的节点 → ${other}（或它的上层、它里面的节点）`,
            e
          )
          continue
        }
        const mine = viaSet(P, e)
        const theirs = new Set(hits.flatMap((e2) => [...viaSet(X, e2)]))
        const miss = [...mine].filter((v) => !theirs.has(v))
        if (mine.size && theirs.size && miss.length) report('error', 'edge-mutual', where, `${X} 那边对应的连线没有带上数据：${miss.join(', ')}`, e)
      }
    }
  }

  // 接口：mq 接口要有人发也要有人收；接口有没有被用到、有没有入口实现
  {
    const use = new Map() // 接口 id → { send, recv, call, serve }
    const touch = (id, k) => {
      if (!use.has(id)) use.set(id, { send: 0, recv: 0, call: 0, serve: 0 })
      use.get(id)[k]++
    }
    for (const [M] of members) {
      for (const e of nodes.get(M).node.edges ?? []) {
        for (const v of Array.isArray(e.via) ? e.via : [e.via]) {
          if (typeof v !== 'string') continue
          const a = resolve(v, M)
          if (!a || nodes.get(a).node.kind !== 'api') continue
          const [f, t] = edgeEnds(M, e)
          const res = (id) => nodes.get(id)?.node.kind === 'resource'
          if (e.kind === 'send') touch(a, res(t) ? 'send' : res(f) ? 'recv' : 'call')
          else touch(a, 'call')
        }
      }
    }
    for (const [id, { node: n }] of nodes) for (const ref of asList(fnOf(n).serves)) {
      const a = resolve(ref, id)
      if (a) touch(a, 'serve')
    }
    for (const [id, { node: n, file }] of nodes) {
      if (n.kind !== 'api') continue
      const u = use.get(id)
      const where = `${file} 节点 ${id}`
      if (!u) report('info', 'api-unused', where, '这个接口没有被任何连线用到', n)
      else if (n.protocol === 'mq') {
        if (u.send && !u.recv) report('warn', 'mq-no-consumer', where, `topic ${n.name} 有人发、没人收`, n)
        if (u.recv && !u.send) report('warn', 'mq-no-producer', where, `topic ${n.name} 有人收、没人发`, n)
      }
    }
  }

  // ----- 执行图：含 kind: function 的地图。函数的角色（入口 / 步骤 / 闸门 / 结束）由 fn 字段推出 -----
  function checkExec(X, nX, file, memSet) {
    const exec = [...memSet].filter((id) => nodes.get(id)?.node.kind === 'function')
    const role = (id) => roleOf(nodes.get(id)?.node)
    if (!exec.length) return
    const W = `${file} 地图 ${X}`
    const all = (nX.edges ?? []).map((e) => ({ e, from: resolve(e.from, X), to: resolve(e.to, X) }))
    const internal = all.filter((x) => memSet.has(x.from) && memSet.has(x.to))
    const exits = groupBy(all.filter((x) => memSet.has(x.from) && x.to && !memSet.has(x.to)), 'from')
    const outs = groupBy(internal, 'from')
    const ins = groupBy(internal, 'to')
    const entries = exec.filter((id) => role(id) === 'entry')
    const onlyEntries = entries.length === exec.length
    if (!entries.length) report('error', 'exec-entry', W, '执行图里没有入口：至少一个函数要写 fn.trigger 或 fn.serves')
    const seen = new Set(entries)
    const queue = [...entries]
    while (queue.length) {
      for (const x of outs.get(queue.shift()) ?? []) {
        if (!seen.has(x.to)) {
          seen.add(x.to)
          queue.push(x.to)
        }
      }
    }
    for (const id of exec) {
      const n = nodes.get(id).node
      const f = fnOf(n)
      const r = role(id)
      const where = `${W} 节点 ${id}`
      const out = outs.get(id) ?? []
      const ex = exits.get(id) ?? []
      if (!seen.has(id)) report('error', 'exec-reachable', where, '从入口走不到这个节点：补一条从入口那一侧连过来的线；它是被图外调起的，就给它写 fn.trigger', n)
      if (r === 'entry' && ins.get(id)?.length) {
        const by = ins.get(id).map((x) => shortOf(x.from, X)).join('、')
        report('error', 'exec-entry', where, `入口（写了 trigger / serves）不应该有图内的入边：它是被 ${by} 调起的，去掉它的 trigger / serves，当普通步骤`, n)
      }
      // 入口在上层地图里只是一个“门”：只连外部节点、自己有 contains（下一层展开），
      // 或者这张图里只有入口（自上而下梳理时，先把入口归到模块，内部步骤以后再补），都不算死路
      const door = r === 'entry' && (ex.length || n.contains || onlyEntries)
      // 普通步骤只调用外部（比如提交位点到云 API）也算有出口
      const callsOut = r === 'step' && ex.some(({ e }) => e.kind === 'call' || e.kind === 'send')
      // 常驻循环（监听 / 定时）自己一直转，不往下走也不算死路，比如定时采负载只更新内存
      const resident = f.type === 'listen' || f.type === 'timer'
      if (r !== 'end' && !out.length && !door && !callsOut && !resident) report('error', 'exec-dead-end', where, '分支无出口：节点没有往下走的连线。走到这里就完了的写 fn.outcome（再连到外部或写 fn.terminal: true）；还要往下走的补上连线', n)
      if (r === 'end') {
        if (out.length) report('error', 'end-exit', where, `结束（写了 outcome）不应该再连到图内其他节点：它还连到 ${out.map((x) => shortOf(x.to, X)).join('、')}，去掉 outcome 当普通步骤，或者去掉这些线`, n)
        if (!ex.length && !f.terminal) report('error', 'end-exit', where, '结束后交给谁不明确：要有一条连到外部的线，或者写 fn.terminal: true', n)
        for (const { e } of ex) {
          if (f.outcome === 'error' && !e.error && e.kind !== 'return') report('warn', 'end-exit', where, `错误结束，但出口 ${e.from}->${e.to} 不是错误边`, n)
          if (f.outcome === 'success' && e.error) report('warn', 'end-exit', where, `成功结束，但出口 ${e.from}->${e.to} 是错误边`, n)
        }
      }
      if (r === 'gate') {
        // 两种写法：pass / fail；或者每条分支写条件文字（if / else if / else，比如 when: 是 leader）
        const branches = [...out, ...ex].map((x) => x.e)
        const fails = branches.filter((e) => e.when === 'fail' || e.error)
        const named = branches.filter((e) => typeof e.when === 'string' && e.when && e.when !== 'pass' && e.when !== 'fail')
        if (branches.length < 2) report('error', 'gate-branches', where, '闸门至少要有两个分支', n)
        else if (named.length) {
          const bare = branches.filter((e) => !e.when && !e.error)
          if (bare.length) report('warn', 'gate-branches', where, `分支要写清楚条件（when）：${bare.map((e) => `${e.from}->${e.to}`).join('、')}`, n)
        } else if (!fails.length || fails.length === branches.length) {
          report('error', 'gate-branches', where, '闸门要有通过和不通过两个分支（when: pass / fail），或者每条分支写条件文字（when: 是 leader）', n)
        }
      }
    }
    for (const { e, to } of internal) {
      const target = nodes.get(to)?.node
      if (e.error && roleOf(target) === 'end' && fnOf(target).outcome === 'success' && !e.swallow) {
        report('warn', 'error-swallowed', `${W} 连线 ${e.from}->${e.to}`, '错误分支走到了成功结束；如果确实要吞掉错误，写 swallow: 原因', e)
      }
    }
    checkFields(X, nX, W, memSet, internal)
  }

  // ----- 字段：地图 X 负责产出 X.io.out，检查每个字段的来源 -----
  function checkFields(X, nX, W, memSet, internal) {
    const norm = (id, key) => asList(fnOf(nodes.get(id).node)[key]).map((ref) => resolveField(model, ref, id)).filter(Boolean)
    if (![...memSet].some((id) => norm(id, 'writes').length)) return
    const io = ioOf(model, X)
    const out = io.out
    if (!out) {
      report('error', 'field-output', W, `图里有字段写入（writes），但 ${X} 没有声明 fn.io.out`)
      return
    }
    const inputs = new Set(io.in)
    const all = (nodes.get(out).node.fields ?? []).map((f) => `${out}.${f.name}`)
    const preds = groupBy(internal, 'to')
    const own = (id) => norm(id, 'writes').filter((ref) => ref.startsWith(`${out}.`))
    // 每个节点执行前“一定已经赋值”的字段：所有前驱的交集
    const before = new Map()
    const after = new Map()
    for (let changed = true; changed; ) {
      changed = false
      for (const id of memSet) {
        const n = nodes.get(id).node
        let set
        if (roleOf(n) === 'entry') set = new Set()
        else {
          const known = (preds.get(id) ?? []).map((x) => after.get(x.from)).filter(Boolean)
          if (!known.length) continue
          set = new Set([...known[0]].filter((x) => known.every((k) => k.has(x))))
        }
        const next = new Set([...set, ...own(id)])
        if (!after.has(id) || after.get(id).size !== next.size || before.get(id).size !== set.size) {
          before.set(id, set)
          after.set(id, next)
          changed = true
        }
      }
    }
    for (const id of memSet) {
      const n = nodes.get(id).node
      const where = `${W} 节点 ${id}`
      const ready = before.get(id)
      for (const ref of norm(id, 'writes')) {
        if (!ref.startsWith(`${out}.`)) report('warn', 'field-write', where, `writes 只记录 ${X} 产出的 ${out} 的字段：${ref}`, n)
      }
      const reads = norm(id, 'reads')
      for (const ref of new Set([...reads, ...norm(id, 'guards')])) {
        const type = ref.slice(0, ref.lastIndexOf('.'))
        if (type === out) {
          if (ready && !ready.has(ref) && reads.includes(ref)) report('error', 'field-read-before-write', where, `读取 ${ref} 时，前面还没有步骤给它赋值`, n)
        } else if (!inputs.has(type)) {
          report('error', 'field-source', where, `字段无来源：${ref} 既不在 ${X} 的输入（io.in）里，也不是 ${X} 产出的 ${out}`, n)
        }
      }
      if (roleOf(n) === 'end' && fnOf(n).outcome === 'success' && ready) {
        const missing = all.filter((f) => !ready.has(f))
        if (missing.length) report('error', 'field-missing', where, `成功返回时，这些字段在某条路径上没有赋值：${missing.join(', ')}`, n)
      }
    }
  }

  return { issues, suppressed, anchorFile }
}

// `类型.字段` → `类型全局id.字段`；类型不存在时返回 null
export function resolveField(model, ref, scope) {
  const i = String(ref).lastIndexOf('.')
  if (i < 0) return null
  const t = model.resolve(ref.slice(0, i), scope)
  return t && model.nodes.get(t).node.kind === 'type' ? `${t}.${ref.slice(i + 1)}` : null
}

// ---------- 需求：把变更集应用到节点数据上 ----------
// 返回应用后的 model，以及给界面上色用的 marks：
//   nodes   节点 id → add / mod / del
//   members `地图|节点` → add / del（节点本身没变，只是被放进 / 拿出某张地图）
//   edges   `地图|from->to` → add / del
//   fields  `类型id.字段` → add / del
//   steps   需求插入的流程步骤对象

export function applyRequirement(sourceDocs, req, sourceLinks = []) {
  const docs = structuredClone(sourceDocs)
  const linkDocs = structuredClone(sourceLinks)
  let model = buildModel(docs, linkDocs)
  const problems = []
  const changes = []
  // code：节点 id → 需求里拟写的代码 { file, new, diff }，只挂在需求上，不写进节点
  const marks = { nodes: new Map(), members: new Map(), edges: new Map(), fields: new Map(), steps: new WeakSet(), code: new Map() }
  // 链路和数据在索引里是副本，修改要写回 links/ 里的原始对象
  const editable = (id) => {
    const en = model.nodes.get(id)
    return en ? (en.raw ?? en.node) : null
  }

  const edgeKey = (map, from, to) => `${map}|${model.resolve(from, map) ?? from}->${model.resolve(to, map) ?? to}`
  const findEdgeIndex = (map, key) => {
    const edges = model.nodes.get(map).node.edges ?? []
    const byId = edges.findIndex((e) => e.id === key)
    if (byId >= 0) return byId
    const [a, b] = String(key).split('->').map((x) => model.resolve(x, map))
    return edges.findIndex((e) => model.resolve(e.from, map) === a && model.resolve(e.to, map) === b)
  }
  const dropRefs = (target) => {
    for (const [M, { node }] of model.nodes) {
      if (node.contains) node.contains = node.contains.filter((x) => typeof x !== 'string' || model.resolve(x, M) !== target)
      for (const lane of node.lanes ?? []) lane.nodes = asList(lane.nodes).filter((x) => model.resolve(x, M) !== target)
    }
  }

  for (const [i, raw] of (req.changes ?? []).entries()) {
    // 插入到节点数据里的内容都复制一份，重复应用同一个需求时互不影响
    const c = structuredClone(raw)
    const where = `${req.file} 第 ${i + 1} 条变更`
    const problem = (msg) => problems.push({ level: 'error', rule: 'req-change', where, msg })
    const op = ['add', 'modify', 'remove'].find((k) => c[k])
    if (!op) {
      problem('变更要写 add / modify / remove 之一')
      continue
    }
    const what = c[op]
    const at = c.at && model.nodes.has(c.at) ? c.at : null
    if (c.at && !at) {
      problem(`at ${c.at} 不是已有节点（要写全局 id）`)
      continue
    }
    const holder = at ? editable(at) : null
    const holderKind = at ? model.nodes.get(at).node.kind : null
    const needAt = () => {
      if (!holder) problem(`${op}: ${what} 要写 at`)
      return Boolean(holder)
    }
    let target = at
    // 拟写的代码：{ file, new } 新代码 / { file, diff } 改动
    if (c.proposed !== undefined) {
      const p = c.proposed
      if (!p || typeof p !== 'object' || Array.isArray(p)) problem('proposed 要写成 { file, new } 或 { file, diff }')
      else {
        const extra = Object.keys(p).filter((k) => !KEYS.reqCode.has(k))
        if (extra.length) problem(`proposed 里不认识的字段 ${extra.join(', ')}（只有 file / new / diff）`)
        if (!p.new && !p.diff) problem('proposed 要写 new（拟写的代码）或 diff（改动）')
        if (p.file && parseCode(p.file)?.bad) problem(`proposed.file 的行号写错：${p.file}`)
      }
    }

    switch (`${op}:${what}`) {
      case 'add:node': {
        if (!needAt()) continue
        if (!c.value?.id) {
          problem('value 缺少 id')
          continue
        }
        if (model.nodes.has(`${at}.${c.value.id}`)) {
          problem(`${at}.${c.value.id} 已经存在`)
          continue
        }
        ;(holder.contains ??= []).push(c.value)
        if (c.lane) {
          const lane = (holder.lanes ?? []).find((l) => l.id === c.lane)
          if (!lane) problem(`泳道 ${c.lane} 不存在`)
          else lane.nodes = [...asList(lane.nodes), c.value.id]
        }
        // 需求新增节点在图上的位置：写在这条变更上，合入时再写回地图的 layout
        if (c.layout !== undefined) {
          if (!Array.isArray(c.layout) || c.layout.length !== 2 || !c.layout.every((v) => typeof v === 'number')) problem(`layout 要写成 [x, y]：${JSON.stringify(c.layout)}`)
          else holder.layout = { ...(holder.layout ?? {}), [c.value.id]: c.layout }
        }
        target = `${at}.${c.value.id}`
        marks.nodes.set(target, 'add')
        if (c.proposed) marks.code.set(target, c.proposed)
        break
      }
      case 'add:member': {
        if (!needAt()) continue
        const id = model.resolve(c.id, at)
        if (!id) {
          problem(`要引用的 ${c.id} 不存在`)
          continue
        }
        ;(holder.contains ??= []).push(c.id)
        marks.members.set(`${at}|${id}`, 'add')
        break
      }
      case 'add:edge':
      case 'add:flow':
      case 'add:lane': {
        if (!needAt()) continue
        const list = (holder[`${what}s`] ??= [])
        const dup = what === 'edge' ? findEdgeIndex(at, c.value.id ?? `${c.value.from}->${c.value.to}`) >= 0 : list.some((x) => x.id === c.value.id)
        if (dup) {
          problem(`${what} 已经存在`)
          continue
        }
        list.push(c.value)
        if (what === 'edge') marks.edges.set(edgeKey(at, c.value.from, c.value.to), 'add')
        break
      }
      case 'add:field': {
        if (!needAt()) continue
        if (holderKind !== 'type') {
          problem(`${at} 不是数据类型`)
          continue
        }
        if ((holder.fields ?? []).some((f) => f.name === c.value?.name)) {
          problem(`字段 ${at}.${c.value?.name} 已经存在`)
          continue
        }
        ;(holder.fields ??= []).push(c.value)
        marks.fields.set(`${at}.${c.value.name}`, 'add')
        break
      }
      case 'add:link': {
        // 新增一条链路：at 是 owner；没有这个 owner 的链路文件就新建一个
        if (!needAt()) continue
        if (!c.value?.id) {
          problem('value 缺少 id')
          continue
        }
        const lid = `${at}.${c.value.id}`
        if (model.nodes.has(lid)) {
          problem(`${lid} 已经存在`)
          continue
        }
        let doc = linkDocs.find((d) => d.data?.owner === at)
        if (!doc) {
          doc = { file: `（需求 ${req.requirement?.id ?? req.file} 新建的 links/${at}.yaml）`, data: { owner: at, links: [] } }
          linkDocs.push(doc)
        }
        doc.data.links.push(c.value)
        target = lid
        marks.nodes.set(lid, 'add')
        for (const it of asList(c.value.data)) if (it?.id) marks.nodes.set(`${at}.${it.id}`, 'add')
        break
      }
      case 'add:data': {
        // 给链路加一条数据：at 是链路 id
        if (!needAt()) continue
        if (holderKind !== 'api') {
          problem(`${at} 不是链路`)
          continue
        }
        const tid = c.value?.id ? `${prefixOf(at)}.${c.value.id}` : null
        if (tid && model.nodes.has(tid)) {
          problem(`数据 ${tid} 已经存在`)
          continue
        }
        ;(holder.data ??= []).push(c.value)
        target = tid ?? at
        marks.nodes.set(tid ?? at, tid ? 'add' : 'mod')
        break
      }
      case 'add:kb': {
        if (!needAt()) continue
        ;(holder.kb ??= []).push(c.value)
        break
      }
      case 'modify:node': {
        const node = editable(c.id)
        if (!node) {
          problem(`要修改的节点 ${c.id} 不存在（要写全局 id）`)
          continue
        }
        // set 里的 fn 合并而不是整个替换，只改写到的那几个字段
        const { fn: setFn, ...rest } = c.set ?? {}
        Object.assign(node, rest)
        if (setFn) node.fn = { ...(node.fn ?? {}), ...setFn }
        if (c.proposed) marks.code.set(c.id, c.proposed)
        target = c.id
        if (marks.nodes.get(c.id) !== 'add') marks.nodes.set(c.id, 'mod')
        break
      }
      case 'modify:edge': {
        if (!needAt()) continue
        const index = findEdgeIndex(at, c.id)
        if (index < 0) problem(`${at} 里没有连线 ${c.id}`)
        else Object.assign(holder.edges[index], c.set ?? {})
        break
      }
      case 'modify:flow': {
        if (!needAt()) continue
        const flow = (holder.flows ?? []).find((f) => f.id === c.id)
        if (!flow) {
          problem(`${at} 里没有流程 ${c.id}`)
          continue
        }
        Object.assign(flow, c.set ?? {})
        for (const [key, replacement] of Object.entries(c.replace ?? {})) {
          const [a, b] = key.split('->').map((x) => model.resolve(x, at))
          const index = flow.steps.findIndex((s) => model.resolve(s.from, at) === a && model.resolve(s.to, at) === b)
          if (index < 0) problem(`流程 ${c.id} 里没有 ${key} 这一步`)
          else {
            flow.steps.splice(index, 1, ...replacement)
            for (const s of replacement) marks.steps.add(s)
          }
        }
        break
      }
      case 'remove:node': {
        const entry = model.nodes.get(c.id)
        if (!entry) {
          problem(`要删除的节点 ${c.id} 不存在（要写全局 id）`)
          continue
        }
        if (entry.how === 'file') docs.splice(docs.findIndex((d) => d.node === entry.node), 1)
        else entry.list.splice(entry.list.indexOf(entry.raw ?? entry.node), 1)
        dropRefs(c.id)
        target = c.id
        marks.nodes.set(c.id, 'del')
        break
      }
      case 'remove:member': {
        if (!needAt()) continue
        const id = model.resolve(c.id, at)
        const inline = (holder.contains ?? []).some((x) => typeof x === 'object' && `${at}.${x.id}` === id)
        if (inline) {
          problem(`${c.id} 是在 ${at} 里就地定义的，要用 remove: node`)
          continue
        }
        holder.contains = (holder.contains ?? []).filter((x) => typeof x !== 'string' || model.resolve(x, at) !== id)
        for (const lane of holder.lanes ?? []) lane.nodes = asList(lane.nodes).filter((x) => model.resolve(x, at) !== id)
        marks.members.set(`${at}|${id}`, 'del')
        break
      }
      case 'remove:edge': {
        if (!needAt()) continue
        const index = findEdgeIndex(at, c.id)
        if (index < 0) problem(`${at} 里没有连线 ${c.id}`)
        else {
          const e = holder.edges[index]
          marks.edges.set(edgeKey(at, e.from, e.to), 'del')
          holder.edges.splice(index, 1)
        }
        break
      }
      case 'remove:flow':
      case 'remove:lane': {
        if (!needAt()) continue
        const list = holder[`${what}s`] ?? []
        const index = list.findIndex((x) => x.id === c.id)
        if (index < 0) problem(`${at} 里没有 ${what} ${c.id}`)
        else list.splice(index, 1)
        break
      }
      case 'remove:field': {
        if (!needAt()) continue
        const index = (holder.fields ?? []).findIndex((f) => f.name === c.id)
        if (index < 0) problem(`${at} 里没有字段 ${c.id}`)
        else {
          holder.fields.splice(index, 1)
          marks.fields.set(`${at}.${c.id}`, 'del')
        }
        break
      }
      default:
        problem(`不支持的变更 ${op}: ${what}`)
        continue
    }
    // index：在 req.changes 里的第几条，界面按它找回原文和拟写代码
    changes.push({ op, what, target, at, index: i })
    model = buildModel(docs, linkDocs)
    model.proposed = marks.code
  }
  // docs / linkDocs：应用后的节点和链路文件（副本），合入底图时按文件写回
  return { model, problems, changes, marks, docs, linkDocs }
}

// 需求角标：每处改动计入被改的节点，以及沿“被谁包含 / 定义在谁里面”往上的所有节点；同一处改动对同一节点只算一次
export function impact(models, changes) {
  const parents = (id) => {
    const out = new Set()
    for (const m of models) {
      for (const p of m.containedBy.get(id) ?? []) out.add(p)
      const entry = m.nodes.get(id)
      // 数据 → 所在链路 → 链路的 owner
      if (entry?.how === 'data' || entry?.how === 'link') out.add(entry.owner)
      if (entry?.how === 'file' && !m.containedBy.get(id)?.size && prefixOf(id)) out.add(prefixOf(id))
    }
    return out
  }
  const count = new Map()
  for (const c of changes) {
    if (!c.target) continue
    const seen = new Set([c.target])
    const queue = [c.target]
    while (queue.length) {
      for (const p of parents(queue.shift())) {
        if (!seen.has(p)) {
          seen.add(p)
          queue.push(p)
        }
      }
    }
    for (const id of seen) count.set(id, (count.get(id) ?? 0) + 1)
  }
  return count
}

// 需求会插入或删除流程步骤，序号会变；比较新旧问题时忽略序号
export const issueKey = (issue) => `${issue.rule}|${issue.where.replace(/第 \d+ 步/, '第 ? 步')}|${issue.msg}`

// 校验底图，再逐个应用需求，只保留每个需求新带来的问题
export function checkLibrary(docs, requirements, links = []) {
  const model = buildModel(docs, links)
  const base = validate(model)
  const baseKeys = new Set(base.issues.map(issueKey))
  const reqs = requirements.map((req) => {
    const applied = applyRequirement(docs, req, links)
    const merged = validate(applied.model)
    return {
      req,
      ...applied,
      issues: [...applied.problems, ...merged.issues.filter((i) => !baseKeys.has(issueKey(i)))],
      impact: impact([model, applied.model], applied.changes)
    }
  })
  return { model, base, reqs }
}
