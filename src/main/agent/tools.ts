import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import type { AgentChangeSet, AgentMode } from '../../shared/agent'
import { buildModel, checkLibrary, codeOf, edgeData, fnOf, issueKey, resolveCode, roleOf, type CodemapModel } from '../../shared/codemap/codemap.mjs'
import { isInside } from '../../shared/paths'
import { loadLibrary } from '../codemap/loadLibrary.mjs'
import type { CodemapAccess } from '../codemap/service'
import { knowledgeRoot } from './knowledge'
import type { ToolSpec } from './providers'

// The agent's tools. Everything is read-only except propose_change_set, which only records a
// proposal: writing happens later, from the panel, when the user applies it.

export interface ToolEnv {
  library: string
  access: CodemapAccess
  mode: AgentMode
  /** Lets the map follow the agent (focus a node, open a map, select a flow). */
  focus(map: string | null, nodes: string[], flow?: string | null, note?: string): void
  propose(set: Omit<AgentChangeSet, 'id' | 'sessionId' | 'problems' | 'status'>): AgentChangeSet
  /** Create mode: stop at a review gate. */
  gate(stage: string, summary: string): void
  /** Create mode: run sub-agents for several nodes at once (resolves when all finished). */
  delegate?(tasks: Array<{ node: string; instructions: string }>): Promise<string>
}

export interface ToolResult {
  ok: boolean
  /** Text sent back to the model. */
  content: string
  /** Short line for the panel. */
  summary: string
}

const MAX_READ = 400
const MAX_TEXT = 60_000

interface Library {
  model: CodemapModel
  docs: Array<{ file: string; node: Record<string, any> }>
  links: Array<{ file: string; data: Record<string, any> }>
  requirements: Array<Record<string, any> & { file: string }>
}

let libCache: { library: string; at: number; value: Library } | null = null

/** The library as it is on disk now (cached for a few seconds within a run). */
export function readLibrary(library: string, fresh = false): Library {
  if (!fresh && libCache && libCache.library === library && Date.now() - libCache.at < 3000) return libCache.value
  const loaded = loadLibrary(library)
  const model = buildModel(loaded.docs, loaded.links)
  const value: Library = { model, docs: loaded.docs, links: loaded.links, requirements: loaded.requirements }
  libCache = { library, at: Date.now(), value }
  return value
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters cut)` : text
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// ---------- Node summaries ----------

function nodeLine(model: CodemapModel, id: string): string {
  const n = model.nodes.get(id)?.node ?? {}
  const role = roleOf(n)
  const code = codeOf(n)
  const bits = [`${id}`, n.kind, n.name ? `「${n.name}」` : '', n.brief ? `(${n.brief})` : '', role && role !== 'step' ? `[${role}]` : '', code ? `@${code}` : '', model.members.has(id) ? '[map]' : '']
  return bits.filter(Boolean).join(' ')
}

function describeNode(lib: Library, id: string): string {
  const { model } = lib
  const entry = model.nodes.get(id)
  if (!entry) return `No node ${id}`
  const n = entry.node
  const out: string[] = [`# ${nodeLine(model, id)}`, `file: ${entry.file}`]
  if (n.desc) out.push(`desc: ${n.desc}`)
  const f = fnOf(n)
  if (Object.keys(f).length) out.push(`fn: ${JSON.stringify(f)}`)
  if (n.issues) out.push(`issues: ${JSON.stringify(n.issues)}`)
  const ups = [...(model.containedBy.get(id) ?? [])]
  if (ups.length) out.push(`contained by: ${ups.join(', ')}`)
  const members = model.members.get(id)
  if (members) {
    out.push('', '## contains')
    for (const m of members) out.push(`- ${nodeLine(model, m)}${model.refs.get(id)?.has(m) ? ' (referenced)' : ''}`)
    const edges = (n.edges ?? []) as Record<string, any>[]
    if (edges.length) {
      out.push('', '## edges')
      for (const e of edges) {
        const io = edgeData(model, id, e)
        const via = io.apis.map((a) => a.apiId).filter(Boolean)
        out.push(`- ${e.from} -> ${e.to} [${e.kind ?? 'next'}${e.mode ? ` ${e.mode}` : ''}]${e.name ? ` 「${e.name}」` : ''}${e.when ? ` when=${e.when}` : ''}${e.error ? ' error' : ''}${via.length ? ` via=${via.join(',')}` : ''}`)
      }
    }
    const flows = (n.flows ?? []) as Record<string, any>[]
    if (flows.length) {
      out.push('', '## flows')
      for (const fl of flows) {
        out.push(`- ${fl.id} 「${fl.name ?? ''}」${fl.kind ? ` ${fl.kind}` : ''}${fl.refines ? ` refines=${fl.refines}` : ''}`)
        for (const s of (fl.steps ?? []) as Record<string, any>[]) out.push(`    ${s.at ? `at ${s.at}` : `${s.from} -> ${s.to}`}${s.title ? `: ${s.title}` : ''}${s.result ? ` => ${s.result}` : ''}`)
      }
    }
  }
  return out.join('\n')
}

// ---------- File access ----------

async function readAllowed(env: ToolEnv, absolute: string): Promise<string> {
  const real = path.resolve(absolute)
  if (!env.access.allowed(real) && !isInside(env.library, real)) {
    throw new Error(`Not allowed to read ${real}: it is outside the open folder and the folders granted to the code map. Ask the user to open the code there once, or grant the folder in Settings.`)
  }
  const info = await stat(real)
  if (!info.isFile()) throw new Error(`Not a file: ${real}`)
  if (info.size > 4 * 1024 * 1024) throw new Error('File is larger than 4 MB')
  return readFile(real, 'utf8')
}

function anchorPath(lib: Library, library: string, id: string): { path: string | null; lines: [number, number] | null; repoRoot: string | null } {
  const a = resolveCode(lib.model, id)
  if (!a) return { path: null, lines: null, repoRoot: null }
  const repoRoot = a.local ? path.resolve(library, a.local) : null
  return { path: repoRoot && a.file ? path.join(repoRoot, a.file) : null, lines: a.lines, repoRoot }
}

function withLines(text: string, from = 1, to?: number): string {
  const lines = text.split('\n')
  const end = Math.min(lines.length, to ?? lines.length, from + MAX_READ - 1)
  const out: string[] = []
  for (let i = from; i <= end; i++) out.push(`${String(i).padStart(5)}  ${lines[i - 1]}`)
  if (end < (to ?? lines.length)) out.push(`… (lines ${end + 1}-${to ?? lines.length} not shown; read again with from=${end + 1})`)
  return out.join('\n')
}

const SKIP = new Set(['.git', 'node_modules', 'vendor', 'out', 'dist', 'build', 'target', '.idea', '.vscode'])

async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 12) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.codemapignore') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) yield* walk(full, depth + 1)
    } else yield full
  }
}

// ---------- Change set checking ----------

/** Validates a change set against the library: applies it like a requirement and reports new problems. */
export function checkChangeSet(library: string, set: Pick<AgentChangeSet, 'changes' | 'files'>): AgentChangeSet['problems'] {
  const loaded = loadLibrary(library)
  const docs = [...loaded.docs]
  const links = [...loaded.links]
  const problems: AgentChangeSet['problems'] = []
  for (const [rel, text] of Object.entries(set.files ?? {})) {
    if (!/\.(ya?ml)$/.test(rel)) continue
    let data: any
    try {
      data = yaml.load(text)
    } catch (error) {
      problems.push({ level: 'error', rule: 'yaml', where: rel, msg: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (!data || typeof data !== 'object') continue
    if (data.owner && data.links) {
      const i = links.findIndex((l) => l.file === rel)
      if (i >= 0) links.splice(i, 1, { file: rel, data })
      else links.push({ file: rel, data })
    } else if (data.id) {
      const i = docs.findIndex((d) => d.file === rel)
      if (i >= 0) docs.splice(i, 1, { file: rel, node: data })
      else docs.push({ file: rel, node: data })
    }
  }
  const base = checkLibrary(loaded.docs, [], loaded.links)
  const baseKeys = new Set(base.base.issues.map(issueKey))
  const req = { file: '(proposed change set)', requirement: { id: 'proposal', name: 'proposal' }, changes: set.changes ?? [] }
  const after = checkLibrary(docs, set.changes?.length ? [req] : [], links)
  const issues = set.changes?.length ? after.reqs[0].issues.concat(after.reqs[0].problems) : after.base.issues.filter((i) => !baseKeys.has(issueKey(i)))
  for (const i of issues) if (i.level !== 'info') problems.push({ level: i.level, rule: i.rule, where: i.where, msg: i.msg })
  return problems
}

// ---------- Tool table ----------

type Handler = (env: ToolEnv, input: Record<string, any>) => Promise<ToolResult>

interface ToolDef {
  spec: ToolSpec
  modes: AgentMode[] | 'all'
  label(input: Record<string, any>): string
  run: Handler
}

const ok = (content: string, summary: string): ToolResult => ({ ok: true, content: clip(content), summary })

const TOOLS: ToolDef[] = [
  {
    spec: {
      name: 'map_overview',
      description: 'Lists the maps of the node library: top-level maps first, each with its node count and the maps inside it. Start here to find where things are.',
      schema: { type: 'object', properties: {} }
    },
    modes: 'all',
    label: () => 'Read the map overview',
    run: async (env) => {
      const lib = readLibrary(env.library)
      const { model } = lib
      const roots = [...model.members.keys()].filter((id) => ![...(model.containedBy.get(id) ?? [])].length)
      const out: string[] = []
      const seen = new Set<string>()
      const tree = (id: string, depth: number) => {
        if (seen.has(id) || depth > 6) return
        seen.add(id)
        const own = (model.members.get(id) ?? []).filter((m) => !model.refs.get(id)?.has(m))
        out.push(`${'  '.repeat(depth)}- ${nodeLine(model, id)} (${own.length} nodes)`)
        for (const m of own) if (model.members.has(m)) tree(m, depth + 1)
      }
      for (const r of roots) tree(r, 0)
      return ok(out.join('\n') || 'The library has no maps yet.', `${model.members.size} maps`)
    }
  },
  {
    spec: {
      name: 'read_node',
      description: 'Reads one node by global id: its fields, and if it is a map, everything on it (nodes, edges with the links they carry, flows step by step).',
      schema: { type: 'object', properties: { id: { type: 'string', description: 'Global node id, e.g. dispatch.check' } }, required: ['id'] }
    },
    modes: 'all',
    label: (i) => `Read node ${i.id}`,
    run: async (env, i) => {
      const lib = readLibrary(env.library)
      const id = str(i.id)
      if (!lib.model.nodes.has(id)) return { ok: false, content: `No node ${id}. Use find_nodes or map_overview.`, summary: `no node ${id}` }
      return ok(describeNode(lib, id), lib.model.nodes.get(id)?.node.name ?? id)
    }
  },
  {
    spec: {
      name: 'find_nodes',
      description: 'Searches nodes by id, name, brief, desc, or code location (case-insensitive substring). Returns up to 40 matches.',
      schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    },
    modes: 'all',
    label: (i) => `Find nodes “${i.query}”`,
    run: async (env, i) => {
      const { model } = readLibrary(env.library)
      const q = str(i.query).toLowerCase()
      const hits: string[] = []
      for (const [id, e] of model.nodes) {
        const n = e.node
        const hay = [id, n.name, n.brief, n.desc, codeOf(n)].map((x) => String(x ?? '').toLowerCase()).join(' ')
        if (hay.includes(q)) hits.push(nodeLine(model, id))
        if (hits.length >= 40) break
      }
      return ok(hits.join('\n') || 'No node matches.', `${hits.length} matches`)
    }
  },
  {
    spec: {
      name: 'nodes_for_code',
      description: 'Finds the nodes whose code location covers a file (and optionally a line). Use it to go from code to the map.',
      schema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path, or repository-relative path as written in fn.code' }, line: { type: 'number' } }, required: ['path'] }
    },
    modes: 'all',
    label: (i) => `Find nodes for ${path.basename(str(i.path))}${i.line ? `:${i.line}` : ''}`,
    run: async (env, i) => {
      const lib = readLibrary(env.library)
      const target = str(i.path)
      const line = Number(i.line) || 0
      const hits: string[] = []
      for (const id of lib.model.nodes.keys()) {
        const a = resolveCode(lib.model, id)
        if (!a?.file) continue
        const abs = a.local ? path.resolve(env.library, a.local, a.file) : null
        const match = target === abs || target.endsWith(`/${a.file}`) || target === a.file
        if (!match) continue
        if (line && a.lines && (line < a.lines[0] || line > a.lines[1])) continue
        hits.push(`${nodeLine(lib.model, id)}${a.lines ? ` lines ${a.lines[0]}-${a.lines[1]}` : ''}`)
      }
      return ok(hits.join('\n') || 'No node points at this code.', `${hits.length} nodes`)
    }
  },
  {
    spec: {
      name: 'read_node_code',
      description: "Reads the source code a node's fn.code points at, with line numbers (a few lines of context around the range).",
      schema: { type: 'object', properties: { id: { type: 'string' }, context: { type: 'number', description: 'Extra lines before and after, default 5' } }, required: ['id'] }
    },
    modes: 'all',
    label: (i) => `Read code of ${i.id}`,
    run: async (env, i) => {
      const lib = readLibrary(env.library)
      const a = anchorPath(lib, env.library, str(i.id))
      if (!a.path) return { ok: false, content: `Node ${i.id} has no code location with a local repository folder.`, summary: 'no code' }
      const text = await readAllowed(env, a.path)
      const ctx = Math.max(0, Math.min(50, Number(i.context ?? 5)))
      const from = a.lines ? Math.max(1, a.lines[0] - ctx) : 1
      const to = a.lines ? a.lines[1] + ctx : undefined
      return ok(`${a.path}\n${withLines(text, from, to)}`, `${path.basename(a.path)}${a.lines ? `:${a.lines[0]}-${a.lines[1]}` : ''}`)
    }
  },
  {
    spec: {
      name: 'read_file',
      description: 'Reads a text file with line numbers. Allowed: the node library, the open folder, and repositories the user granted. Reads at most 400 lines per call.',
      schema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path, or relative to the node library' }, from: { type: 'number' }, to: { type: 'number' } }, required: ['path'] }
    },
    modes: 'all',
    label: (i) => `Read ${path.basename(str(i.path))}`,
    run: async (env, i) => {
      const p = path.isAbsolute(str(i.path)) ? str(i.path) : path.resolve(env.library, str(i.path))
      const text = await readAllowed(env, p)
      const from = Math.max(1, Number(i.from) || 1)
      const to = Number(i.to) || undefined
      return ok(`${p}\n${withLines(text, from, to)}`, `${path.basename(p)}${i.from ? `:${from}` : ''}`)
    }
  },
  {
    spec: {
      name: 'list_files',
      description: 'Lists files under a folder (recursively, skipping .git, vendor, node_modules, build output). Optional glob-like suffix filter such as ".go".',
      schema: { type: 'object', properties: { path: { type: 'string' }, suffix: { type: 'string' }, limit: { type: 'number' } }, required: ['path'] }
    },
    modes: 'all',
    label: (i) => `List ${str(i.path)}`,
    run: async (env, i) => {
      const dir = path.isAbsolute(str(i.path)) ? str(i.path) : path.resolve(env.library, str(i.path))
      if (!env.access.allowed(dir) && !isInside(env.library, dir)) throw new Error(`Not allowed to list ${dir}`)
      const limit = Math.min(2000, Number(i.limit) || 500)
      const out: string[] = []
      for await (const f of walk(dir)) {
        if (i.suffix && !f.endsWith(str(i.suffix))) continue
        out.push(path.relative(dir, f))
        if (out.length >= limit) break
      }
      return ok(out.join('\n') || '(empty)', `${out.length} files`)
    }
  },
  {
    spec: {
      name: 'search_code',
      description: 'Searches text (a JavaScript regular expression) in files under a folder. Returns file:line: text, up to 80 hits.',
      schema: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string' }, suffix: { type: 'string', description: 'Only files ending with this, e.g. .go' } }, required: ['path', 'pattern'] }
    },
    modes: 'all',
    label: (i) => `Search “${str(i.pattern).slice(0, 40)}”`,
    run: async (env, i) => {
      const dir = path.isAbsolute(str(i.path)) ? str(i.path) : path.resolve(env.library, str(i.path))
      if (!env.access.allowed(dir) && !isInside(env.library, dir)) throw new Error(`Not allowed to search ${dir}`)
      const re = new RegExp(str(i.pattern))
      const hits: string[] = []
      let scanned = 0
      for await (const f of walk(dir)) {
        if (i.suffix && !f.endsWith(str(i.suffix))) continue
        if (++scanned > 20000) break
        let text: string
        try {
          const info = await stat(f)
          if (info.size > 2 * 1024 * 1024) continue
          text = await readFile(f, 'utf8')
        } catch {
          continue
        }
        if (text.includes('\u0000')) continue
        const lines = text.split('\n')
        for (let n = 0; n < lines.length; n++) {
          if (re.test(lines[n])) {
            hits.push(`${path.relative(dir, f)}:${n + 1}: ${lines[n].trim().slice(0, 200)}`)
            if (hits.length >= 80) break
          }
        }
        if (hits.length >= 80) break
      }
      return ok(hits.join('\n') || 'No matches.', `${hits.length} hits`)
    }
  },
  {
    spec: {
      name: 'check_library',
      description: 'Runs the code map checker on the library as it is now and returns errors and warnings (optionally only those mentioning a node id).',
      schema: { type: 'object', properties: { node: { type: 'string' } } }
    },
    modes: 'all',
    label: () => 'Check the library',
    run: async (env, i) => {
      const loaded = loadLibrary(env.library)
      const check = checkLibrary(loaded.docs, loaded.requirements, loaded.links)
      let issues = [...loaded.errors, ...check.base.issues].filter((x) => x.level !== 'info')
      if (i.node) issues = issues.filter((x) => x.where.includes(str(i.node)))
      return ok(issues.slice(0, 120).map((x) => `${x.level} [${x.rule}] ${x.where}: ${x.msg}`).join('\n') || 'No errors or warnings.', `${issues.length} problems`)
    }
  },
  {
    spec: {
      name: 'read_knowledge',
      description: 'Reads the Codemap knowledge that ships with the app: the workflow (create/SOP.md), the codemap/v1 templates (create/node-template.yaml, link-template.yaml, requirement-template.yaml), mode guides, and domain notes. Call with no path to list files.',
      schema: { type: 'object', properties: { path: { type: 'string', description: 'Path inside the knowledge folder, e.g. create/node-template.yaml' } } }
    },
    modes: 'all',
    label: (i) => (i.path ? `Read knowledge ${i.path}` : 'List knowledge'),
    run: async (_env, i) => {
      const dir = knowledgeRoot()
      if (!i.path) {
        const out: string[] = []
        for await (const f of walk(dir)) out.push(path.relative(dir, f))
        return ok(out.join('\n') || 'The knowledge folder is empty.', `${out.length} files`)
      }
      const p = path.resolve(dir, str(i.path))
      if (!isInside(dir, p)) throw new Error('Path is outside the knowledge folder')
      const text = await readFile(p, 'utf8').catch(() => '')
      return ok(text.trim() ? text : '(empty file)', str(i.path))
    }
  },
  {
    spec: {
      name: 'show_on_map',
      description: 'Makes the map follow you: opens a map and highlights nodes on it (and optionally selects a flow to play). Call it as you look at things so the user sees where you are; also use it to point at the nodes your answer is about.',
      schema: {
        type: 'object',
        properties: {
          map: { type: 'string', description: 'Global id of the map to open; omit to stay on the current map' },
          nodes: { type: 'array', items: { type: 'string' }, description: 'Global ids to highlight' },
          flow: { type: 'string', description: 'Flow id on that map to select' },
          note: { type: 'string', description: 'One short line shown to the user' }
        }
      }
    },
    modes: 'all',
    label: (i) => `Show ${(i.nodes ?? []).length ? (i.nodes as string[]).join(', ') : (i.map ?? 'map')}`,
    run: async (env, i) => {
      const { model } = readLibrary(env.library)
      const map = i.map ? str(i.map) : null
      if (map && !model.members.has(map)) return { ok: false, content: `${map} is not a map (it has no contains).`, summary: `not a map ${map}` }
      const nodes = (Array.isArray(i.nodes) ? i.nodes : []).map(String).filter((id: string) => model.nodes.has(id))
      env.focus(map, nodes, i.flow ? str(i.flow) : null, i.note ? str(i.note) : undefined)
      return ok('Shown.', map ?? nodes.join(', '))
    }
  },
  {
    spec: {
      name: 'propose_change_set',
      description: [
        'Proposes changes to the node library. Nothing is written: the user sees the proposal as a layer on the map and applies or rejects it.',
        'changes: a list in the requirement change format: { add: node, at: <map id>, lane?, value: {...node} } | { modify: node, id: <global id>, set: {...} } | { remove: node, id } | { add|remove: edge, at, value|id } | { add|modify|remove: flow, at, value|id|set|replace } | { add: member|lane|link|data|field|kb, at, value } ...',
        'files: whole files to create or replace (library-relative path → full text), for new maps that live in their own folder (<folder>/<id>.yaml), links.yaml, or docs.',
        'In require mode also give requirement { id, name, desc }: the set is saved as requirements/<id>.yaml instead of being applied to the base map.',
        'Check the result: the reply lists checker problems this proposal introduces; fix them with another proposal before finishing.'
      ].join('\n'),
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string', description: 'What changes and why, in plain words' },
          changes: { type: 'array', items: { type: 'object' } },
          files: { type: 'object', additionalProperties: { type: 'string' } },
          requirement: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, desc: { type: 'string' } } }
        },
        required: ['title', 'summary']
      }
    },
    modes: ['adjust', 'create', 'require'],
    label: (i) => `Propose “${str(i.title)}”`,
    run: async (env, i) => {
      const files: Record<string, string> = {}
      for (const [k, v] of Object.entries((i.files ?? {}) as Record<string, unknown>)) {
        const rel = path.normalize(k).replace(/^\/+/, '')
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`File path must stay inside the library: ${k}`)
        files[rel] = String(v)
      }
      const set = env.propose({
        title: str(i.title) || 'Change set',
        summary: str(i.summary),
        changes: Array.isArray(i.changes) ? i.changes : [],
        files,
        requirement: env.mode === 'require' && i.requirement ? { id: str(i.requirement.id) || 'requirement', name: str(i.requirement.name) || str(i.title), desc: str(i.requirement.desc) || undefined } : undefined
      })
      const errors = set.problems.filter((p) => p.level === 'error')
      const text = set.problems.length
        ? `Proposal ${set.id} recorded. Checker problems it introduces:\n${set.problems.map((p) => `${p.level} [${p.rule}] ${p.where}: ${p.msg}`).join('\n')}`
        : `Proposal ${set.id} recorded. The checker found no new problems.`
      return { ok: true, content: clip(text), summary: errors.length ? `${errors.length} errors` : 'no new problems' }
    }
  },
  {
    spec: {
      name: 'review_gate',
      description: 'Create mode: stop at a review point (business understanding explained and open points discussed, L0 drawn, modules broken down, a batch of nodes broken down). The run ends here; the user reviews and either approves or sends feedback.',
      schema: { type: 'object', properties: { stage: { type: 'string' }, summary: { type: 'string', description: 'What to review and what you need from the user' } }, required: ['stage', 'summary'] }
    },
    modes: ['create'],
    label: (i) => `Review: ${str(i.stage)}`,
    run: async (env, i) => {
      env.gate(str(i.stage), str(i.summary))
      return ok('Waiting for the user to review.', str(i.stage))
    }
  },
  {
    spec: {
      name: 'delegate_nodes',
      description: 'Create mode: breaks several nodes down in parallel with sub-agents. Each task gets one node and instructions; each sub-agent may only propose files inside that node\'s folder. Returns their reports.',
      schema: {
        type: 'object',
        properties: { tasks: { type: 'array', items: { type: 'object', properties: { node: { type: 'string' }, instructions: { type: 'string' } }, required: ['node', 'instructions'] } } },
        required: ['tasks']
      }
    },
    modes: ['create'],
    label: (i) => `Delegate ${(i.tasks ?? []).length} nodes`,
    run: async (env, i) => {
      if (!env.delegate) return { ok: false, content: 'Sub-agents are not available here.', summary: 'not available' }
      const tasks = (Array.isArray(i.tasks) ? i.tasks : []).map((t: any) => ({ node: str(t.node), instructions: str(t.instructions) })).filter((t) => t.node)
      const report = await env.delegate(tasks)
      return ok(report, `${tasks.length} sub-agents finished`)
    }
  }
]

export function toolsFor(mode: AgentMode, allowDelegate = true): ToolDef[] {
  return TOOLS.filter((t) => (t.modes === 'all' || t.modes.includes(mode)) && (allowDelegate || t.spec.name !== 'delegate_nodes'))
}

export async function runTool(defs: ToolDef[], env: ToolEnv, name: string, input: Record<string, any>): Promise<ToolResult> {
  const def = defs.find((t) => t.spec.name === name)
  if (!def) return { ok: false, content: `Unknown tool ${name}`, summary: `unknown tool ${name}` }
  try {
    return await def.run(env, input ?? {})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, content: `Error: ${message}`, summary: message.slice(0, 120) }
  }
}

export function toolLabel(defs: ToolDef[], name: string, input: Record<string, any>): string {
  return defs.find((t) => t.spec.name === name)?.label(input ?? {}) ?? name
}
