import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { buildModel, checkLibrary, codeOf, edgeData, fnOf, issueKey, resolveCode, roleOf, type CodemapModel, type Issue, type LibraryCheck } from '../../../src/shared/codemap/codemap.mjs'
import { isInside } from '../../../src/shared/paths'
import { loadLibrary, type LoadedLibrary } from '../../../src/main/codemap/loadLibrary.mjs'
import type { AgentLspTools } from './agentLsp'

const MAX_BODY = 2 * 1024 * 1024
const MAX_READ = 400

export interface McpBridgeAccess {
  allowed(target: string): boolean
}

export interface ShowOnMapRequest {
  map: string | null
  nodes: string[]
  flow: string | null
  note?: string
}

export interface ExternalProposal {
  id: string
  title: string
  summary: string
  changes: Record<string, unknown>[]
  files: Record<string, string>
  requirement?: { id: string; name: string; desc?: string }
  problems: Array<{ level: string; rule: string; where: string; msg: string }>
  status: 'proposed'
  extend?: string
  replaceChanges?: boolean
}

export interface McpBridgeCallbacks {
  onShowOnMap(request: ShowOnMapRequest): void | Promise<void>
  onExternalProposal(proposal: ExternalProposal): void | Promise<void>
  onDiscardProposal?(id: string, reason?: string): void | Promise<void>
}

export interface McpBridgeOptions {
  registryDir: string
  workspaceRoot?: string | null
  library?: string | null
  knowledgeDir?: string | null
  access?: McpBridgeAccess
  agentLsp?: AgentLspTools
  callbacks?: Partial<McpBridgeCallbacks>
}

interface BridgeContext {
  workspaceRoot: string | null
  library: string | null
}

interface RpcRequest {
  method?: unknown
  params?: unknown
}

interface LibraryView {
  model: CodemapModel
  loaded: LoadedLibrary
  library: string
}

export class LoopbackMcpBridge {
  readonly token: string
  private readonly server: Server
  private port = 0
  private context: BridgeContext
  private disposed = false
  private readonly proposals = new Map<string, ExternalProposal>()

  private constructor(
    private readonly options: McpBridgeOptions,
    server: Server,
    token: string
  ) {
    this.server = server
    this.token = token
    this.context = {
      workspaceRoot: options.workspaceRoot ? path.resolve(options.workspaceRoot) : null,
      library: options.library ? path.resolve(options.library) : null
    }
  }

  static async start(options: McpBridgeOptions): Promise<LoopbackMcpBridge> {
    const token = randomBytes(32).toString('hex')
    const server = createServer()
    const bridge = new LoopbackMcpBridge(options, server, token)
    server.on('request', (request, response) => {
      void bridge.handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback bridge did not bind a TCP port')
    if (address.address !== '127.0.0.1') throw new Error(`loopback bridge bound ${address.address}, expected 127.0.0.1`)
    bridge.port = address.port
    bridge.writeRegistry()
    return bridge
  }

  get address(): { host: '127.0.0.1'; port: number } {
    return { host: '127.0.0.1', port: this.port }
  }

  get registryFile(): string {
    return registryPath(this.options.registryDir, this.context.workspaceRoot)
  }

  updateContext(context: { workspaceRoot?: string | null; library?: string | null }): void {
    if (this.disposed) return
    const previous = this.registryFile
    if (context.workspaceRoot !== undefined) this.context.workspaceRoot = context.workspaceRoot ? path.resolve(context.workspaceRoot) : null
    if (context.library !== undefined) this.context.library = context.library ? path.resolve(context.library) : null
    if (previous !== this.registryFile) rmSync(previous, { force: true })
    this.writeRegistry()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    rmSync(this.registryFile, { force: true })
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private writeRegistry(): void {
    mkdirSync(this.options.registryDir, { recursive: true })
    const body = {
      pid: process.pid,
      workspaceRoot: this.context.workspaceRoot,
      library: this.context.library,
      port: this.port,
      token: this.token,
      updatedAt: new Date().toISOString()
    }
    writeFileSync(this.registryFile, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!authorized(request.headers.authorization, this.token)) {
        sendJson(response, 401, { error: 'unauthorized' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method !== 'POST' || url.pathname !== '/rpc') {
        sendJson(response, 404, { error: 'not found' })
        return
      }
      const body = await readBody(request)
      const rpc = JSON.parse(body || '{}') as RpcRequest
      const result = await this.dispatch(String(rpc.method ?? ''), asRecord(rpc.params))
      sendJson(response, 200, { ok: true, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = message === 'unauthorized' ? 401 : 400
      sendJson(response, status, { ok: false, error: message })
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'status':
        return {
          workspaceRoot: this.context.workspaceRoot,
          library: this.context.library,
          hasLibrary: Boolean(this.context.library)
        }
      case 'map_overview':
        return mapOverview(this.libraryView())
      case 'read_node':
        return readNode(this.libraryView(), str(params.id))
      case 'find_nodes':
        return findNodes(this.libraryView(), str(params.query))
      case 'read_node_code':
        return readNodeCode(this.libraryView(), str(params.id), Number(params.context ?? 5))
      case 'read_knowledge':
        return readKnowledge(this.knowledgeDir(), params.path ? str(params.path) : '')
      case 'list_knowledge':
        return listKnowledge(this.knowledgeDir())
      case 'validate_library':
        return validateLibrary(this.libraryView(), params.node ? str(params.node) : '')
      case 'lsp_symbols':
        return this.lspText('symbols', params)
      case 'lsp_definitions':
        return this.lspText('definition', params)
      case 'lsp_references':
        return this.lspText('references', params)
      case 'show_on_map':
        return this.showOnMap(params)
      case 'propose_change_set':
        return this.propose(params)
      case 'discard_change_set':
        return this.discard(params)
      case 'scan_repo_entrypoints':
        return scanRepoEntrypoints(this.scanRoots(), params)
      default:
        throw new Error(`unknown method ${method}`)
    }
  }

  private libraryView(): LibraryView {
    const library = this.context.library
    if (!library) throw new Error('no code map library is open')
    const loaded = loadLibrary(library)
    return { library, loaded, model: buildModel(loaded.docs, loaded.links) }
  }

  private knowledgeDir(): string {
    const dir = this.options.knowledgeDir ?? process.env.CODEMAP_AGENT_DIR
    if (!dir) throw new Error('knowledge directory is not configured')
    return path.resolve(dir)
  }

  private async lspText(kind: 'symbols' | 'definition' | 'references', params: Record<string, unknown>): Promise<string> {
    const lsp = this.options.agentLsp
    if (!lsp) throw new Error('language features are not available')
    const file = path.resolve(str(params.file || params.path))
    const library = this.context.library
    if (!this.options.access?.allowed(file) && !(library && isInside(library, file))) {
      throw new Error(`not allowed to read ${file}`)
    }
    if (kind === 'symbols') return lsp.symbols(file)
    const line = numberOr(params.line, 1)
    const column = numberOr(params.column ?? params.character, 1)
    return lsp.navigate(kind, file, line, column)
  }

  private async showOnMap(params: Record<string, unknown>): Promise<{ shown: true; map: string | null; nodes: string[]; flow: string | null }> {
    const view = this.libraryView()
    const map = params.map ? str(params.map) : null
    if (map && !view.model.members.has(map)) throw new Error(`${map} is not a map`)
    const nodes = asStrings(params.nodes).filter((id) => view.model.nodes.has(id))
    const flow = params.flow ? str(params.flow) : null
    if (flow) {
      const known = view.model.flows.has(flow) || (map ? view.model.flows.has(`${map}.${flow}`) : false)
      if (!known) throw new Error(`${flow} is not a flow`)
    }
    const request: ShowOnMapRequest = { map, nodes, flow, note: params.note ? str(params.note) : undefined }
    await this.options.callbacks?.onShowOnMap?.(request)
    return { shown: true, map, nodes, flow }
  }

  private scanRoots(): ScanRoots {
    return { workspaceRoot: this.context.workspaceRoot, library: this.context.library, access: this.options.access }
  }

  private async propose(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const view = this.libraryView()
    const files = sanitizeFiles(params.files)
    const changes = Array.isArray(params.changes) ? params.changes.filter((item): item is Record<string, unknown> => isRecord(item)) : []
    const extend = params.extend ? str(params.extend) : ''
    const previous = extend ? this.proposals.get(extend) : undefined
    if (extend && !previous) throw new Error(`no pending proposal ${extend}`)
    const mergedFiles = previous ? { ...previous.files, ...files } : files
    const mergedChanges = previous ? (params.replaceChanges === true ? changes : [...previous.changes, ...changes]) : changes
    const problems = checkProposal(view.loaded, mergedFiles, mergedChanges)
    const proposal: ExternalProposal = {
      id: extend || str(params.id) || `ext-${randomBytes(4).toString('hex')}`,
      title: str(params.title) || previous?.title || 'External proposal',
      summary: str(params.summary) || previous?.summary || '',
      changes: mergedChanges,
      files: mergedFiles,
      requirement: requirementOf(params.requirement) ?? previous?.requirement,
      problems,
      status: 'proposed',
      extend: extend || undefined,
      replaceChanges: params.replaceChanges === true
    }
    this.proposals.set(proposal.id, proposal)
    await this.options.callbacks?.onExternalProposal?.(proposal)
    return {
      id: proposal.id,
      extended: Boolean(extend),
      replaceChanges: proposal.replaceChanges === true,
      files: Object.keys(mergedFiles),
      changeCount: mergedChanges.length,
      problems,
      fixes: problems.map(prescribe),
      summary: problems.length ? `${problems.filter((problem) => problem.level === 'error').length} errors` : 'no new problems'
    }
  }

  private async discard(params: Record<string, unknown>): Promise<{ discarded: true; id: string; title: string }> {
    const id = str(params.id)
    if (!id) throw new Error('id is required')
    const proposal = this.proposals.get(id)
    if (!proposal) throw new Error(`no pending proposal ${id}`)
    this.proposals.delete(id)
    const reason = params.reason ? str(params.reason) : undefined
    await this.options.callbacks?.onDiscardProposal?.(id, reason)
    return { discarded: true, id, title: proposal.title }
  }
}

export function registryPath(registryDir: string, workspaceRoot: string | null): string {
  const key = createHash('sha1').update(workspaceRoot || 'no-workspace').digest('hex').slice(0, 16)
  return path.join(registryDir, `${key}.json`)
}

export function mapOverview(view: LibraryView): string {
  const { model } = view
  const roots = [...model.members.keys()].filter((id) => !(model.containedBy.get(id)?.size))
  const out: string[] = []
  const seen = new Set<string>()
  const tree = (id: string, depth: number) => {
    if (seen.has(id) || depth > 6) return
    seen.add(id)
    const own = (model.members.get(id) ?? []).filter((member) => !model.refs.get(id)?.has(member))
    out.push(`${'  '.repeat(depth)}- ${nodeLine(model, id)} (${own.length} nodes)`)
    for (const member of own) if (model.members.has(member)) tree(member, depth + 1)
  }
  for (const root of roots) tree(root, 0)
  return out.join('\n') || 'The library has no maps yet.'
}

export function readNode(view: LibraryView, id: string): string {
  const entry = view.model.nodes.get(id)
  if (!entry) throw new Error(`no node ${id}`)
  const node = entry.node
  const out = [`# ${nodeLine(view.model, id)}`, `file: ${entry.file}`]
  if (node.desc) out.push(`desc: ${node.desc}`)
  const fn = fnOf(node)
  if (Object.keys(fn).length) out.push(`fn: ${JSON.stringify(fn)}`)
  const parents = [...(view.model.containedBy.get(id) ?? [])]
  if (parents.length) out.push(`contained by: ${parents.join(', ')}`)
  const members = view.model.members.get(id)
  if (members) {
    out.push('', '## contains')
    for (const member of members) out.push(`- ${nodeLine(view.model, member)}`)
    const edges = Array.isArray(node.edges) ? node.edges : []
    if (edges.length) {
      out.push('', '## edges')
      for (const edge of edges) {
        const io = edgeData(view.model, id, edge)
        const via = io.apis.map((api) => api.apiId).filter(Boolean)
        out.push(`- ${edge.from} -> ${edge.to}${via.length ? ` via=${via.join(',')}` : ''}`)
      }
    }
    const flows = Array.isArray(node.flows) ? node.flows : []
    if (flows.length) {
      out.push('', '## flows')
      for (const flow of flows) out.push(`- ${flow.id}${flow.name ? ` 「${flow.name}」` : ''}`)
    }
  }
  return out.join('\n')
}

export function findNodes(view: LibraryView, query: string): string {
  const needle = query.toLowerCase()
  const hits: string[] = []
  for (const [id, entry] of view.model.nodes) {
    const node = entry.node
    const haystack = [id, node.name, node.brief, node.desc, codeOf(node)].map((value) => String(value ?? '').toLowerCase()).join(' ')
    if (!needle || haystack.includes(needle)) hits.push(nodeLine(view.model, id))
    if (hits.length >= 40) break
  }
  return hits.join('\n') || 'No node matches.'
}

export function readNodeCode(view: LibraryView, id: string, context: number): string {
  const anchor = resolveCode(view.model, id)
  if (!anchor?.file || !anchor.local) throw new Error(`node ${id} has no local code`)
  const file = path.resolve(view.library, anchor.local, anchor.file)
  const text = readText(file)
  const padding = Math.max(0, Math.min(50, context))
  const from = anchor.lines ? Math.max(1, anchor.lines[0] - padding) : 1
  const to = anchor.lines ? anchor.lines[1] + padding : undefined
  return `${file}\n${withLines(text, from, to)}`
}

export function readKnowledge(dir: string, relative = ''): string {
  const root = path.resolve(dir)
  if (!relative) return listKnowledge(root)
  const file = path.resolve(root, relative)
  if (!isInside(root, file)) throw new Error('path is outside the knowledge folder')
  return readText(file)
}

export function listKnowledge(dir: string): string {
  const root = path.resolve(dir)
  const files: string[] = []
  const walk = (current: string) => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = require('node:fs').readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  walk(root)
  return files.sort().join('\n')
}

export function validateLibrary(view: LibraryView, node = ''): string {
  const checked = checkLibrary(view.loaded.docs, view.loaded.requirements, view.loaded.links)
  let issues = [...view.loaded.errors, ...checked.base.issues].filter((issue) => issue.level !== 'info')
  if (node) issues = issues.filter((issue) => issue.where.includes(node))
  return issues.slice(0, 120).map(formatIssue).join('\n') || 'No errors or warnings.'
}

function checkProposal(loaded: LoadedLibrary, files: Record<string, string>, changes: Record<string, unknown>[]): Issue[] {
  const docs = [...loaded.docs]
  const links = [...loaded.links]
  const problems: Issue[] = []
  for (const [relative, text] of Object.entries(files)) {
    if (!/\.ya?ml$/.test(relative)) continue
    let data: unknown
    try {
      data = yaml.load(text)
    } catch (error) {
      problems.push({ level: 'error', rule: 'yaml', where: relative, msg: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (!isRecord(data)) continue
    if (data.owner && data.links) replaceLink(links, relative, data)
    else if (typeof data.id === 'string') replaceDoc(docs, relative, data)
  }
  const before = checkLibrary(loaded.docs, [], loaded.links)
  const beforeKeys = new Set(before.base.issues.map(issueKey))
  const requirement = { file: '(external proposal)', requirement: { id: 'proposal', name: 'proposal' }, changes }
  const after: LibraryCheck = checkLibrary(docs, changes.length ? [requirement] : [], links)
  const issues = changes.length ? after.reqs[0].issues : after.base.issues.filter((issue) => !beforeKeys.has(issueKey(issue)))
  for (const issue of issues) if (issue.level !== 'info') problems.push(issue)
  return problems
}

function replaceDoc(docs: LoadedLibrary['docs'], file: string, node: Record<string, unknown>): void {
  const index = docs.findIndex((doc) => doc.file === file)
  const next = { file, node }
  if (index >= 0) docs.splice(index, 1, next)
  else docs.push(next)
}

function replaceLink(links: LoadedLibrary['links'], file: string, data: Record<string, unknown>): void {
  const index = links.findIndex((link) => link.file === file)
  const next = { file, data }
  if (index >= 0) links.splice(index, 1, next)
  else links.push(next)
}

function prescribe(issue: Issue): string {
  const fixes: Record<string, string> = {
    yaml: 'Fix the YAML syntax, then send the whole file again with extend.',
    'node-name': 'Add the required name field.',
    'node-kind': 'Set kind to project, component, sdk, resource, or function.',
    'ref-missing': 'Point the reference at an existing node, or add that node in the same proposal.',
    'id-format': 'Use one segment for a local id and dotted global ids only where the schema allows them.',
    'id-unique': 'Rename the duplicate id.',
    'map-format': 'A map with edges, flows, or lanes also needs contains.',
    'code-repo': 'Write repo next to the code location.',
    'code-missing': 'Add fn.code, or explain the exception in ignore.',
    'edge-ends': 'Make both ends of the edge members of the same map.'
  }
  return `${issue.level} [${issue.rule}] ${issue.where}: ${fixes[issue.rule] ?? `Fix ${issue.rule}: ${issue.msg}`}`
}

function formatIssue(issue: Issue): string {
  return `${issue.level} [${issue.rule}] ${issue.where}: ${issue.msg}`
}

function nodeLine(model: CodemapModel, id: string): string {
  const node = model.nodes.get(id)?.node ?? {}
  const role = roleOf(node)
  const code = codeOf(node)
  return [id, node.kind, node.name ? `「${node.name}」` : '', role && role !== 'step' ? `[${role}]` : '', code ? `@${code}` : '', model.members.has(id) ? '[map]' : ''].filter(Boolean).join(' ')
}

function sanitizeFiles(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const files: Record<string, string> = {}
  for (const [key, text] of Object.entries(value)) {
    const relative = path.normalize(key).replace(/^[/\\]+/, '')
    if (!relative || relative.startsWith('..') || path.isAbsolute(key)) throw new Error(`file path must stay inside the library: ${key}`)
    files[relative.split(path.sep).join('/')] = String(text)
  }
  return files
}

function requirementOf(value: unknown): ExternalProposal['requirement'] {
  if (!isRecord(value)) return undefined
  const id = str(value.id)
  if (!id) return undefined
  return { id, name: str(value.name) || id, desc: value.desc ? str(value.desc) : undefined }
}

export interface ScanRoots {
  workspaceRoot: string | null
  library: string | null
  access?: McpBridgeAccess
}

export interface RepoEntrypoint {
  kind: 'route' | 'rpc' | 'mq' | 'cron' | 'db' | 'git'
  file: string
  line: number
  text: string
  repoLocal?: string
}

const SCAN_SKIP = new Set(['.git', 'node_modules', 'dist', 'out', 'build', 'vendor', 'target', '.codex', 'coverage'])
const SOURCE_EXT = new Set(['.go', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.rs'])
const MAX_SCAN_FILES = 4000
const MAX_SCAN_HITS = 400

const ENTRY_RULES: Array<{ kind: RepoEntrypoint['kind']; pattern: RegExp }> = [
  { kind: 'route', pattern: /\.(?:GET|POST|PUT|PATCH|DELETE|Handle|HandleFunc|Route)\s*\(|\b(?:app|router|r)\.(?:get|post|put|patch|delete|use)\s*\(|@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b|@(?:app|router)\.(?:get|post|put|patch|delete|route)\b|\b(?:gin|echo|chi|mux|http)\.(?:New|Handle|ListenAndServe)\b|\bListenAndServe\b|\bhttp\.Handle(?:Func)?\s*\(/ },
  { kind: 'rpc', pattern: /\bRegister\w*Server\s*\(|\bRegister\w*Handler\s*\(|\bgrpc\.(?:NewServer|Dial)\b|\btrpc\.(?:NewServer|Register)\b|\bpb\.Register\w+\s*\(|@GrpcService\b/ },
  { kind: 'mq', pattern: /\.(?:Watch|Consume|Subscribe|AddConsumer)\s*\(|\b(?:kafka|nsq|rocketmq|pulsar|amqp)\b[^\n]{0,80}\b(?:Consume|Subscribe|Watch|NewConsumer)\b|\bNew(?:Ticker|Timer)\b/ },
  { kind: 'cron', pattern: /\bcron\.(?:New|AddFunc|Schedule)\b|@Scheduled\b|\bset(?:Interval|Timeout)\s*\(|\btime\.(?:Tick|NewTicker|AfterFunc)\b|\bNewTicker\s*\(/ },
  { kind: 'db', pattern: /\b(?:redis|Redis|gorm|sql\.Open|mongo|etcd)\b[^\n]{0,40}\b(?:Get|Set|HGet|HSet|Query|Exec|Open|Watch|Dial)\s*\(|\b(?:db|redis|rdb)\.(?:Query|Exec|Get|Set|HGet|HSet)\s*\(/ }
]

export function scanRepoEntrypoints(roots: ScanRoots, params: Record<string, unknown>): { root: string; remote: string; repoLocal: string; entrypoints: RepoEntrypoint[] } {
  const root = resolveScanRoot(roots, params.path ? str(params.path) : '')
  const targetFolder = params.targetFolder ? str(params.targetFolder) : ''
  const remote = gitRemote(root)
  const repoLocal = relativeRepoLocal(roots.library, targetFolder, root)
  const entrypoints: RepoEntrypoint[] = []
  const files = listSourceFiles(root)
  for (const file of files) {
    if (entrypoints.length >= MAX_SCAN_HITS) break
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue
    const lines = text.split(/\n/)
    for (let index = 0; index < lines.length && entrypoints.length < MAX_SCAN_HITS; index += 1) {
      const line = lines[index]
      if (!line.trim() || line.length > 400) continue
      const rule = ENTRY_RULES.find((candidate) => candidate.pattern.test(line))
      if (!rule) continue
      entrypoints.push({
        kind: rule.kind,
        file: path.relative(root, file).split(path.sep).join('/'),
        line: index + 1,
        text: line.trim().slice(0, 180),
        ...(repoLocal ? { repoLocal } : {})
      })
    }
  }
  if (remote) {
    entrypoints.push({ kind: 'git', file: '.git/config', line: 1, text: remote, ...(repoLocal ? { repoLocal } : {}) })
  }
  entrypoints.sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file) || a.line - b.line || a.text.localeCompare(b.text))
  return { root, remote, repoLocal, entrypoints }
}

function resolveScanRoot(roots: ScanRoots, requested: string): string {
  const base = roots.workspaceRoot
  if (!base && !requested) throw new Error('no workspace root is open')
  const root = path.resolve(requested || base || '')
  if (!allowedScan(roots, root)) throw new Error(`not allowed to scan ${root}`)
  if (!existsDir(root)) throw new Error(`scan path is not a folder: ${root}`)
  return root
}

function allowedScan(roots: ScanRoots, target: string): boolean {
  if (roots.access?.allowed(target)) return true
  if (roots.workspaceRoot && (target === roots.workspaceRoot || isInside(roots.workspaceRoot, target))) return true
  if (roots.library && (target === roots.library || isInside(roots.library, target))) return true
  return false
}

function relativeRepoLocal(library: string | null, targetFolder: string, repoRoot: string): string {
  if (!library) return ''
  const base = targetFolder ? path.resolve(library, targetFolder) : library
  if (!isInside(library, base) && base !== path.resolve(library)) return ''
  let relative = path.relative(base, repoRoot)
  if (!relative) relative = '.'
  return relative.split(path.sep).join('/')
}

function gitRemote(root: string): string {
  const file = path.join(root, '.git', 'config')
  if (!existsFile(file)) return ''
  if (!isInside(root, file)) return ''
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  const lines = text.split(/\n/)
  let inOrigin = false
  for (const line of lines) {
    const section = /^\s*\[remote\s+"([^"]+)"\]/.exec(line)
    if (section) {
      inOrigin = section[1] === 'origin'
      continue
    }
    if (/^\s*\[/.test(line)) inOrigin = false
    if (!inOrigin) continue
    const url = /^\s*url\s*=\s*(\S+)/.exec(line)
    if (url) return url[1]
  }
  const fallback = /^\s*url\s*=\s*(\S+)/m.exec(text)
  return fallback?.[1] ?? ''
}

function listSourceFiles(root: string): string[] {
  const files: string[] = []
  const walk = (current: string) => {
    if (files.length >= MAX_SCAN_FILES) return
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES) return
      if (entry.name.startsWith('.') && entry.name !== '.git') continue
      if (SCAN_SKIP.has(entry.name)) continue
      const full = path.join(current, entry.name)
      if (!isInside(root, full)) continue
      if (entry.isDirectory()) walk(full)
      else if (SOURCE_EXT.has(path.extname(entry.name).toLowerCase())) files.push(full)
    }
  }
  walk(root)
  return files
}

function existsDir(file: string): boolean {
  try {
    return statSync(file).isDirectory()
  } catch {
    return false
  }
}

function existsFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function authorized(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  if (!match) return false
  const given = Buffer.from(match[1])
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}

function readText(file: string): string {
  return require('node:fs').readFileSync(file, 'utf8') as string
}

function withLines(text: string, from: number, to?: number): string {
  const lines = text.split(/\n/)
  const end = Math.min(lines.length, to ?? lines.length, from + MAX_READ - 1)
  const out: string[] = []
  for (let line = from; line <= end; line += 1) out.push(`${String(line).padStart(5)}  ${lines[line - 1]}`)
  return out.join('\n')
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}
