#!/usr/bin/env node
// codemap/v1 校验命令。规则在 src/shared/codemap/codemap.mjs，Codemap 的代码地图用的是同一份。
// 用法（不写节点库目录时用当前目录）：
//   node scripts/codemap-validate.mjs [节点库目录]          校验全部节点和需求
//   node scripts/codemap-validate.mjs [节点库目录] --index  另外打印“代码文件 → 节点”反查索引
//   node scripts/codemap-validate.mjs [节点库目录] --all    把“提示”级别的问题也逐条打印（默认只打印条数）
// 也可以 npm run codemap:validate -- [节点库目录] [--index] [--all]
import path from 'node:path'
import { checkLibrary } from '../src/shared/codemap/codemap.mjs'
import { loadLibrary } from '../src/main/codemap/loadLibrary.mjs'

const DEFAULT_LIBRARY = process.cwd()

const LEVEL = { error: '错误', warn: '警告', info: '提示' }

function printIssues(issues) {
  if (!issues.length) {
    console.log('  没有问题')
    return
  }
  const levels = showAll ? ['error', 'warn', 'info'] : ['error', 'warn']
  for (const level of levels) {
    for (const i of issues.filter((x) => x.level === level)) console.log(`  ${LEVEL[level]} [${i.rule}] ${i.where}：${i.msg}`)
  }
  const infos = issues.filter((x) => x.level === 'info')
  if (!showAll && infos.length) {
    const byRule = new Map()
    for (const i of infos) byRule.set(i.rule, (byRule.get(i.rule) ?? 0) + 1)
    console.log(`  提示 ${infos.length} 条（${[...byRule].map(([r, n]) => `${r} ${n}`).join('、')}），加 --all 查看`)
  }
}

function printMaps(model) {
  const { nodes, members, containedBy } = model
  const roots = [...members.keys()].filter((id) => !containedBy.get(id)?.size)
  const printed = new Set()
  const walk = (id, depth, trail) => {
    const n = nodes.get(id).node
    const by = [...(containedBy.get(id) ?? [])]
    const map = members.has(id)
    if (!map && by.length < 2) return
    const stats = map ? `：${members.get(id).length} 节点 · ${(n.edges ?? []).length} 连线 · ${(n.flows ?? []).length} 流程` : ''
    const shared = by.length > 1 ? `，被 ${by.length} 处包含` : ''
    const again = printed.has(id) ? '（见上）' : ''
    console.log(`  ${'    '.repeat(depth)}${id}（${n.kind}）${stats}${shared}${again}`)
    if (!map || printed.has(id) || trail.includes(id)) return
    printed.add(id)
    for (const m of members.get(id)) walk(m, depth + 1, [...trail, id])
  }
  for (const root of roots) walk(root, 0, [])
}

function printIndex(base) {
  const byFile = new Map()
  for (const [id, anchor] of base.anchorFile) {
    if (!anchor?.file || !anchor.repo) continue
    const key = `${anchor.repo}:${anchor.file}`
    if (!byFile.has(key)) byFile.set(key, [])
    byFile.get(key).push(id)
  }
  console.log('\n代码文件 → 节点（文件保存时，用它找到受影响的节点）')
  for (const key of [...byFile.keys()].sort()) console.log(`  ${key}\n    ${byFile.get(key).join('\n    ')}`)
}

const args = process.argv.slice(2)
const showAll = args.includes('--all')
const dir = path.resolve(args.find((a) => !a.startsWith('--')) ?? DEFAULT_LIBRARY)
const library = loadLibrary(dir)
const { model, base, reqs } = checkLibrary(library.docs, library.requirements, library.links)
base.issues.unshift(...library.errors)
let errors = base.issues.filter((i) => i.level === 'error').length
const count = (kind) => [...model.nodes.values()].filter((x) => x.node.kind === kind).length

console.log(`节点库 ${path.relative(process.cwd(), dir) || '.'}：节点 ${model.nodes.size - count('api') - count('type')} 个（${model.members.size} 个可以打开），链路 ${count('api')} 条，数据 ${count('type')} 个`)
printMaps(model)
console.log(`\n节点检查${base.suppressed ? `（${base.suppressed} 条已按 ignore 忽略）` : ''}`)
printIssues(base.issues)
if (args.includes('--index')) printIndex(base)

for (const r of reqs) {
  errors += r.issues.filter((i) => i.level === 'error').length
  const n = (op) => r.changes.filter((c) => c.op === op).length
  console.log(`\n需求「${r.req.requirement?.name ?? r.req.file}」：新增 ${n('add')}，修改 ${n('modify')}，删除 ${n('remove')}`)
  printIssues(r.issues)
  const shown = [...r.impact].filter(([id]) => r.model.members.has(id) || model.members.has(id))
  console.log(`  角标（可打开的节点）：${shown.map(([id, k]) => `${id} ${k}`).join(' · ')}`)
}

process.exit(errors ? 1 : 0)
