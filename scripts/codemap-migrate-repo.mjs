#!/usr/bin/env node
// One-off migration to "every code location carries its own repo":
//   - functions: fn.code gets a sibling fn.repo, copied from the nearest node with `repo` up the
//     id prefix (the old inheritance); code that only gives line numbers stays as is
//   - repo.dir is folded into the code paths (code becomes the full path from the repo root)
//     and removed from every repo
//   - data entries in links.yaml already carry repo + code; only repo.dir is folded in
// Edits the YAML text in place so comments and layout survive. Dry run unless --write.
// Usage: node scripts/codemap-migrate-repo.mjs <library> [--write]
import fs from 'node:fs'
import path from 'node:path'
import { codeOf, fileKind, fnOf, normRepo, parseCode, prefixOf } from '../src/shared/codemap/codemap.mjs'
import { loadLibrary } from '../src/main/codemap/loadLibrary.mjs'

const args = process.argv.slice(2)
const write = args.includes('--write')
const dir = path.resolve(args.find((a) => !a.startsWith('--')) ?? '.')
const lib = loadLibrary(dir)
if (lib.errors.length) {
  console.error('YAML errors, fix them first:', lib.errors)
  process.exit(1)
}

// ---------- Index nodes (files and in-place definitions) ----------
const nodes = new Map() // id → { node, file }
const define = (node, id, file) => {
  nodes.set(id, { node, file })
  for (const item of Array.isArray(node.contains) ? node.contains : []) {
    if (item && typeof item === 'object' && typeof item.id === 'string' && item.ref === undefined) define(item, `${id}.${item.id}`, file)
  }
}
for (const d of lib.docs) if (typeof d.node.id === 'string') define(d.node, d.node.id, d.file)

const inheritedRepo = (id) => {
  for (let s = prefixOf(id); s; s = prefixOf(s)) {
    const entry = nodes.get(s)
    if (entry?.node.repo !== undefined) return { owner: s, repo: normRepo(entry.node.repo), file: entry.file }
  }
  return null
}
// The old rule: the repo of a node with its own `repo` applies to itself too
const repoOf = (id) => {
  const entry = nodes.get(id)
  if (entry?.node.repo !== undefined && entry.node.kind !== 'function') return { owner: id, repo: normRepo(entry.node.repo), file: entry.file }
  return inheritedRepo(id)
}

// ---------- Plan edits per file ----------
const edits = new Map() // file → [{ find, replace, why }]
const plan = (file, find, replace, why) => {
  if (!edits.has(file)) edits.set(file, [])
  edits.get(file).push({ find, replace, why })
}
const relLocal = (local, fromFile, toFile) => {
  // repo.local is relative to the YAML's folder; re-base it when copying to another file
  if (!local || path.isAbsolute(local)) return local
  const abs = path.resolve(dir, path.dirname(fromFile), local)
  const rel = path.relative(path.resolve(dir, path.dirname(toFile)), abs)
  return rel.split(path.sep).join('/') || '.'
}
const repoLiteral = (repo) => {
  const parts = [`remote: ${JSON.stringify(repo.remote ?? '')}`]
  if (repo.local) parts.push(`local: ${repo.local}`)
  return `{ ${parts.join(', ')} }`
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

for (const [id, { node, file }] of nodes) {
  if (node.kind !== 'function') continue
  const code = codeOf(node)
  if (code === undefined || fnOf(node).repo !== undefined) continue
  const p = parseCode(code)
  if (!p?.file) continue // line numbers only: uses the outer function's file and repo
  const src = repoOf(id)
  if (!src) {
    console.log(`  ! ${file} ${id}: no repo up the id prefix, add fn.repo by hand`)
    continue
  }
  const fullCode = src.repo.dir ? `${src.repo.dir.replace(/\/+$/, '')}/${code}` : String(code)
  const repo = { remote: src.repo.remote, local: relLocal(src.repo.local, src.file, file) }
  plan(file, { code: String(code) }, { code: fullCode, repo: repoLiteral(repo) }, `${id}: fn.repo from ${src.owner}${src.repo.dir ? `, code prefixed with ${src.repo.dir}/` : ''}`)
}

// Data entries: fold repo.dir into code
for (const d of lib.links) {
  for (const link of d.data?.links ?? []) {
    for (const item of link?.data ?? []) {
      const r = normRepo(item?.repo)
      if (!r?.dir || item.code === undefined) continue
      plan(d.file, { dataCode: String(item.code) }, { code: `${r.dir.replace(/\/+$/, '')}/${item.code}` }, `${item.id}: code prefixed with ${r.dir}/`)
    }
  }
}

// Every repo: drop dir
for (const [, { node, file }] of nodes) {
  const r = normRepo(node.repo)
  if (r?.dir !== undefined) plan(file, { dropDir: r.dir }, null, `${node.id ?? ''}: repo.dir ${r.dir} removed (folded into code)`)
}
for (const d of lib.links) for (const link of d.data?.links ?? []) for (const item of link?.data ?? []) {
  const r = normRepo(item?.repo)
  if (r?.dir !== undefined) plan(d.file, { dropDir: r.dir }, null, `${item.id}: repo.dir removed`)
}

// ---------- Apply ----------
let changed = 0
for (const [file, list] of edits) {
  const abs = path.join(dir, file)
  let text = fs.readFileSync(abs, 'utf8')
  const before = text
  for (const { find, replace, why } of list) {
    if (find.code !== undefined) {
      // Inline: fn: { code: X, ... }  →  fn: { repo: R, code: Y, ... }
      const inline = new RegExp(`(fn:\\s*\\{\\s*)code:\\s*${escape(find.code)}(?=\\s*[,}])`)
      // Block: fn:\n  code: X   →   fn:\n  repo: R\n  code: Y
      const block = new RegExp(`(^[ \\t]*)code:[ \\t]*${escape(find.code)}[ \\t]*(#.*)?$`, 'm')
      if (inline.test(text)) text = text.replace(inline, `$1repo: ${replace.repo}, code: ${replace.code}`)
      else if (block.test(text)) text = text.replace(block, (_m, indent, comment) => `${indent}repo: ${replace.repo}\n${indent}code: ${replace.code}${comment ? ` ${comment}` : ''}`)
      else console.log(`  ! ${file}: could not find "code: ${find.code}" (${why})`)
    } else if (find.dataCode !== undefined) {
      const re = new RegExp(`(code:[ \\t]*)${escape(find.dataCode)}(?=[ \\t]*(?:[,}#]|$))`, 'm')
      if (re.test(text)) text = text.replace(re, `$1${replace.code}`)
      else console.log(`  ! ${file}: could not find data code ${find.dataCode}`)
    } else if (find.dropDir !== undefined) {
      const re = new RegExp(`,?[ \\t]*dir:[ \\t]*${escape(String(find.dropDir))}[ \\t]*(?=[,}])`)
      if (re.test(text)) text = text.replace(re, '')
      else if (new RegExp(`^[ \\t]*dir:[ \\t]*${escape(String(find.dropDir))}.*\\n`, 'm').test(text)) text = text.replace(new RegExp(`^[ \\t]*dir:[ \\t]*${escape(String(find.dropDir))}.*\\n`, 'm'), '')
      else console.log(`  ! ${file}: could not drop dir ${find.dropDir}`)
    }
    console.log(`  ${file}: ${why}`)
  }
  text = text.replace(/\{\s*,\s*/g, '{ ')
  if (text !== before) {
    changed++
    if (write) fs.writeFileSync(abs, text)
  }
}
console.log(`\n${changed} file(s) ${write ? 'updated' : 'would change (dry run, add --write)'}`)
void fileKind
