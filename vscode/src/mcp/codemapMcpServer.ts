import { readdirSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { buildModel, checkLibrary, codeOf, fnOf, roleOf, type CodemapModel } from '../../../src/shared/codemap/codemap.mjs'
import { isInside } from '../../../src/shared/paths'
import { loadLibrary, type LoadedLibrary } from '../../../src/main/codemap/loadLibrary.mjs'
import { scanRepoEntrypoints } from '../host/mcpBridge'

const PROTOCOL = '2025-03-26'
const SERVER_NAME = 'codemap'
const SERVER_VERSION = '1.0.0'

const OFFLINE_TOOLS = new Set(['map_overview', 'read_node', 'find_nodes', 'validate_library', 'read_knowledge', 'list_knowledge', 'scan_repo_entrypoints'])

interface JsonRpc {
  jsonrpc?: '2.0'
  id?: string | number | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface BridgeRecord {
  pid: number
  workspaceRoot: string | null
  library: string | null
  port: number
  token: string
  updatedAt: string
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface ServerOptions {
  registryDir: string
  workspace: string
  knowledgeDir?: string
}

const TOOLS: ToolDefinition[] = [
  { name: 'map_overview', description: 'List the maps in the live CodeMap library.', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_node', description: 'Read one node by global id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'find_nodes', description: 'Find nodes by id, name, brief, description, or code.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'read_node_code', description: 'Read the source range a node points at.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, context: { type: 'number' } }, required: ['id'] } },
  { name: 'read_knowledge', description: 'Read a file from the CodeMap knowledge folder.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'list_knowledge', description: 'List the CodeMap knowledge folder.', inputSchema: { type: 'object', properties: {} } },
  { name: 'validate_library', description: 'Run the CodeMap checker.', inputSchema: { type: 'object', properties: { node: { type: 'string' } } } },
  { name: 'lsp_symbols', description: 'Outline symbols in a source file through the VS Code language service.', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } },
  { name: 'lsp_definitions', description: 'Go to definition through the VS Code language service.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, column: { type: 'number' } }, required: ['file', 'line'] } },
  { name: 'lsp_references', description: 'Find references through the VS Code language service.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, column: { type: 'number' } }, required: ['file', 'line'] } },
  { name: 'show_on_map', description: 'Switch the open CodeMap, light nodes, select a flow, and show a note.', inputSchema: { type: 'object', properties: { map: { type: 'string' }, nodes: { type: 'array', items: { type: 'string' } }, flow: { type: 'string' }, note: { type: 'string' } } } },
  { name: 'propose_change_set', description: 'Propose a reviewed CodeMap change. Nothing is written until a person applies it. Pass extend to update a pending proposal, and replaceChanges to replace its changes instead of appending them.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, files: { type: 'object' }, changes: { type: 'array' }, extend: { type: 'string', description: 'Pending proposal id to update in place' }, replaceChanges: { type: 'boolean', description: 'When extending, replace changes instead of appending them' }, requirement: { type: 'object' } }, required: ['title', 'summary'] } },
  { name: 'discard_change_set', description: 'Discard an unapplied external proposal. Library files are not changed.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Unapplied proposal id to discard' }, reason: { type: 'string', description: 'Reason for discarding this draft' } }, required: ['id'] } },
  { name: 'scan_repo_entrypoints', description: 'Scan routes, RPCs, MQ/watch consumers, cron/timers, DB/Redis calls, and the git remote in about a second.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Folder inside workspace or granted repos (defaults to workspace root)' }, targetFolder: { type: 'string', description: 'Optional node folder inside library for relative repo.local calculation' } } } }
]

const RESOURCES = [
  ['codemap://knowledge/create/SOP.md', 'create/SOP.md', 'CodeMap build SOP'],
  ['codemap://knowledge/create/node-template.yaml', 'create/node-template.yaml', 'Node template'],
  ['codemap://knowledge/create/link-template.yaml', 'create/link-template.yaml', 'Link template'],
  ['codemap://knowledge/create/requirement-template.yaml', 'create/requirement-template.yaml', 'Requirement template'],
  ['codemap://knowledge/common/guide.md', 'common/guide.md', 'Shared CodeMap guide'],
  ['codemap://knowledge/adjust/guide.md', 'adjust/guide.md', 'Adjust-mode CodeMap guide']
] as const

const PROMPTS = [
  { name: 'codemap-build', description: 'Build or extend a CodeMap from code.', arguments: [{ name: 'scope', description: 'Map or folder to build', required: false }, { name: 'tier', description: 'fast, balanced, or deep. Defaults to balanced', required: false }, { name: 'lens', description: 'service, business, or troubleshoot. Defaults to service', required: false }] },
  { name: 'codemap-ask', description: 'Answer a question from the open CodeMap.', arguments: [{ name: 'question', description: 'Question to answer', required: true }] },
  { name: 'codemap-require', description: 'Turn a requirement into a reviewed CodeMap change.', arguments: [{ name: 'requirement', description: 'Requirement text', required: true }] }
]

export function parseArgs(argv = process.argv.slice(2), env = process.env): ServerOptions {
  const read = (flag: string, name: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : env[name]
  }
  return {
    registryDir: read('--registry-dir', 'CODEMAP_MCP_REGISTRY_DIR') || '',
    workspace: path.resolve(read('--workspace', 'CODEMAP_WORKSPACE') || process.cwd()),
    knowledgeDir: read('--knowledge-dir', 'CODEMAP_AGENT_DIR')
  }
}

export class CodemapMcpServer {
  constructor(private readonly options: ServerOptions) {}

  async handle(message: JsonRpc): Promise<JsonRpc | null> {
    if (!message.method) return null
    if (message.method.startsWith('notifications/') || message.id == null) return null
    try {
      return { jsonrpc: '2.0', id: message.id, result: await this.result(message.method, asRecord(message.params)) }
    } catch (error) {
      return { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }
    }
  }

  private async result(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'Use the live VS Code CodeMap when it is open. Read-only map and knowledge tools still work from disk when it is not.'
        }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: TOOLS }
      case 'tools/call':
        return this.callTool(str(params.name), asRecord(params.arguments))
      case 'resources/list':
        return { resources: RESOURCES.map(([uri, , description]) => ({ uri, name: uri.split('/').pop(), description, mimeType: uri.endsWith('.md') ? 'text/markdown' : 'text/yaml' })) }
      case 'resources/read':
        return this.readResource(str(params.uri))
      case 'prompts/list':
        return { prompts: PROMPTS }
      case 'prompts/get':
        return this.prompt(str(params.name), asRecord(params.arguments))
      default:
        throw new Error(`method not found: ${method}`)
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    try {
      const text = await this.toolText(name, args)
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
    }
  }

  private async toolText(name: string, args: Record<string, unknown>): Promise<string> {
    const records = this.registryRecords()
    const bridge = await this.firstLive(records)
    if (bridge) return rpc(bridge, name, args)
    if (name === 'scan_repo_entrypoints') return JSON.stringify(scanOfflineEntrypoints(this.options.workspace, args), null, 2)
    if (!OFFLINE_TOOLS.has(name)) throw new Error(`VS Code CodeMap is not running; ${name} needs the live bridge`)
    const view = this.offlineLibrary(records)
    switch (name) {
      case 'map_overview':
        return overview(view.model)
      case 'read_node':
        return describe(view.model, str(args.id))
      case 'find_nodes':
        return search(view.model, str(args.query))
      case 'validate_library':
        return problems(view.loaded, str(args.node ?? ''))
      case 'read_knowledge':
        return args.path ? readKnowledgeFile(this.knowledge(), str(args.path)) : listKnowledgeFiles(this.knowledge())
      case 'list_knowledge':
        return listKnowledgeFiles(this.knowledge())
      default:
        throw new Error(`offline tool ${name} is not available`)
    }
  }

  private readResource(uri: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
    const found = RESOURCES.find(([candidate]) => candidate === uri)
    if (!found) throw new Error(`resource not found: ${uri}`)
    return { contents: [{ uri, mimeType: uri.endsWith('.md') ? 'text/markdown' : 'text/yaml', text: readKnowledgeFile(this.knowledge(), found[1]) }] }
  }

  private prompt(name: string, args: Record<string, unknown>): { description: string; messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> } {
    const found = PROMPTS.find((prompt) => prompt.name === name)
    if (!found) throw new Error(`prompt not found: ${name}`)
    const tier = buildTier(args.tier)
    const lens = buildLens(args.lens)
    const text = {
      'codemap-build': buildPrompt(str(args.scope), tier, lens),
      'codemap-ask': `Answer from the CodeMap, cite node ids and path:line, and call show_on_map for the nodes you mean. Question: ${str(args.question)}`,
      'codemap-require': `Turn this requirement into one reviewed proposal with requirement metadata and proposed code: ${str(args.requirement)}`
    }[name]
    return { description: found.description, messages: [{ role: 'user', content: { type: 'text', text: text ?? found.description } }] }
  }

  private knowledge(): string {
    if (!this.options.knowledgeDir) throw new Error('knowledge directory is not configured')
    return path.resolve(this.options.knowledgeDir)
  }

  private offlineLibrary(records: BridgeRecord[]): { model: CodemapModel; loaded: LoadedLibrary } {
    const recorded = records.map((record) => record.library).find((library): library is string => typeof library === 'string' && isLibrary(library))
    const library = recorded ?? detectLibrary(this.options.workspace)
    if (!library) throw new Error(`no CodeMap library under ${this.options.workspace}`)
    const loaded = loadLibrary(library)
    return { loaded, model: buildModel(loaded.docs, loaded.links) }
  }

  private registryRecords(): BridgeRecord[] {
    if (!this.options.registryDir) return []
    let names: string[] = []
    try {
      names = readdirSync(this.options.registryDir).filter((name) => name.endsWith('.json'))
    } catch {
      return []
    }
    return names.flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(path.join(this.options.registryDir, name), 'utf8')) as BridgeRecord]
      } catch {
        return []
      }
    })
  }

  private async firstLive(records: BridgeRecord[]): Promise<BridgeRecord | null> {
    const ranked = records
      .map((record) => ({ record, score: matchScore(this.options.workspace, record.workspaceRoot) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score)
    for (const item of ranked) {
      if (await ping(item.record)) return item.record
    }
    if (records.length === 1 && await ping(records[0])) return records[0]
    return null
  }
}

export function runStdioServer(options = parseArgs()): void {
  if (!options.registryDir) options = { ...options, registryDir: process.env.CODEMAP_MCP_REGISTRY_DIR || '' }
  const server = new CodemapMcpServer(options)
  let buffered = ''
  let framing: 'headers' | 'lines' | null = null
  let pending = 0
  process.stdin.on('data', (chunk: Buffer | string) => {
    buffered += chunk.toString()
    framing ??= buffered.startsWith('Content-Length:') ? 'headers' : 'lines'
    const messages = framing === 'headers' ? takeFrames(buffered) : takeLines(buffered)
    buffered = messages.rest
    for (const message of messages.items) {
      pending += 1
      void server.handle(message).then((response) => {
        if (response) writeMessage(response, framing === 'headers')
      }).finally(() => {
        pending -= 1
      })
    }
  })
  process.stdin.on('end', () => {
    const finish = () => {
      if (pending === 0) process.exit(0)
      else setTimeout(finish, 10)
    }
    finish()
  })
  process.stdin.resume()
}

function writeMessage(message: JsonRpc, headers: boolean): void {
  const body = JSON.stringify(message)
  if (headers) process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  else process.stdout.write(`${body}\n`)
}

function takeLines(buffer: string): { items: JsonRpc[]; rest: string } {
  const items: JsonRpc[] = []
  let rest = buffer
  while (true) {
    const newline = rest.indexOf('\n')
    if (newline < 0) break
    const line = rest.slice(0, newline).trim()
    rest = rest.slice(newline + 1)
    if (!line) continue
    items.push(JSON.parse(line) as JsonRpc)
  }
  return { items, rest }
}

function takeFrames(buffer: string): { items: JsonRpc[]; rest: string } {
  const items: JsonRpc[] = []
  let rest = buffer
  while (true) {
    const split = rest.indexOf('\r\n\r\n')
    if (split < 0) break
    const headers = rest.slice(0, split)
    const match = /Content-Length:\s*(\d+)/i.exec(headers)
    if (!match) throw new Error('missing Content-Length')
    const length = Number(match[1])
    const start = split + 4
    if (Buffer.byteLength(rest.slice(start)) < length) break
    const body = Buffer.from(rest.slice(start)).subarray(0, length).toString('utf8')
    rest = Buffer.from(rest.slice(start)).subarray(length).toString('utf8')
    items.push(JSON.parse(body) as JsonRpc)
  }
  return { items, rest }
}

function rpc(record: BridgeRecord, method: string, params: Record<string, unknown>): Promise<string> {
  const body = JSON.stringify({ method, params })
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: '127.0.0.1', port: record.port, path: '/rpc', method: 'POST', headers: { authorization: `Bearer ${record.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { ok?: boolean; result?: unknown; error?: string }
          if (response.statusCode !== 200 || payload.ok === false) reject(new Error(payload.error || `bridge HTTP ${response.statusCode}`))
          else resolve(typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result, null, 2))
        })
      }
    )
    request.on('error', reject)
    request.end(body)
  })
}

function ping(record: BridgeRecord): Promise<boolean> {
  return rpc(record, 'status', {}).then(() => true).catch(() => false)
}

function matchScore(workspace: string, root: string | null): number {
  if (!root) return 0
  const left = path.resolve(workspace)
  const right = path.resolve(root)
  if (left === right) return 1000
  if (isInside(right, left)) return 500 - path.relative(right, left).length
  if (isInside(left, right)) return 250 - path.relative(left, right).length
  return -1
}

export function detectLibrary(workspace: string): string | null {
  const root = path.resolve(workspace)
  if (isLibrary(root)) return root
  const nested = path.join(root, 'codemap')
  if (isLibrary(nested)) return nested
  return findLibrary(root, 2)
}

function findLibrary(dir: string, depth: number): string | null {
  if (depth < 0 || !existsDir(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const child = path.join(dir, entry.name)
    if (isLibrary(child)) return child
    const nested = depth > 0 ? findLibrary(child, depth - 1) : null
    if (nested) return nested
  }
  return null
}

function isLibrary(dir: string): boolean {
  if (!existsDir(dir)) return false
  if (existsDir(path.join(dir, 'nodes')) || existsFile(path.join(dir, '.codemapignore'))) return true
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory() && existsFile(path.join(dir, entry.name, `${entry.name}.yaml`)))
  } catch {
    return false
  }
}


function scanOfflineEntrypoints(workspace: string, args: Record<string, unknown>) {
  const root = path.resolve(workspace)
  return scanRepoEntrypoints({
    workspaceRoot: root,
    library: null,
    access: { allowed: (target) => target === root || isInside(root, target) }
  }, args)
}

function buildTier(value: unknown): 'fast' | 'balanced' | 'deep' {
  const tier = str(value)
  return tier === 'fast' || tier === 'deep' ? tier : 'balanced'
}

function buildLens(value: unknown): 'service' | 'business' | 'troubleshoot' {
  const lens = str(value)
  return lens === 'business' || lens === 'troubleshoot' ? lens : 'service'
}

function buildPrompt(scope: string, tier: 'fast' | 'balanced' | 'deep', lens: 'service' | 'business' | 'troubleshoot'): string {
  const target = scope || 'the open workspace'
  const tierGuide = {
    fast: 'fast: produce the L0 and L1 skeleton with zero review pauses.',
    balanced: 'balanced: align one structured blueprint, then build L0 and L1.',
    deep: 'deep: review stage by stage and drill down to functions and branches.'
  }[tier]
  const lensGuide = {
    service: 'service: group by real microservices, entrypoints, and DB/Redis/MQ.',
    business: 'business: group by user-facing product capabilities and stages.',
    troubleshoot: 'troubleshoot: highlight state transitions, retries, timeouts, and background jobs.'
  }[lens]
  return [
    `Build the CodeMap for ${target}.`,
    `Use tier ${tier} (${tierGuide}) and lens ${lens} (${lensGuide}).`,
    'Call scan_repo_entrypoints first so routes, RPCs, MQ/watch consumers, cron/timers, DB/Redis, and the git remote are known.',
    'Read codemap://knowledge/common/guide.md and follow create/SOP.md for this tier and lens.',
    'Propose files with propose_change_set. Use extend to update a pending proposal, and replaceChanges when the previous changes should be replaced instead of appended.',
    'If a draft gets wedged, call discard_change_set instead of leaving a broken proposal.',
    'Keep every proposal inside the codemap/v1 checker rules: node name and kind, unique ids, map contains, edge ends, and repo next to code.'
  ].join(' ')
}

function overview(model: CodemapModel): string {
  const roots = [...model.members.keys()].filter((id) => !(model.containedBy.get(id)?.size))
  const lines: string[] = []
  const seen = new Set<string>()
  const walk = (id: string, depth: number) => {
    if (seen.has(id) || depth > 6) return
    seen.add(id)
    const own = (model.members.get(id) ?? []).filter((member) => !model.refs.get(id)?.has(member))
    lines.push(`${'  '.repeat(depth)}- ${nodeLine(model, id)} (${own.length} nodes)`)
    for (const member of own) if (model.members.has(member)) walk(member, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return lines.join('\n') || 'The library has no maps yet.'
}

function describe(model: CodemapModel, id: string): string {
  const entry = model.nodes.get(id)
  if (!entry) throw new Error(`no node ${id}`)
  const lines = [`# ${nodeLine(model, id)}`, `file: ${entry.file}`]
  const fn = fnOf(entry.node)
  if (Object.keys(fn).length) lines.push(`fn: ${JSON.stringify(fn)}`)
  const members = model.members.get(id)
  if (members) {
    lines.push('', '## contains', ...members.map((member) => `- ${nodeLine(model, member)}`))
    const edges = Array.isArray(entry.node.edges) ? entry.node.edges : []
    if (edges.length) lines.push('', '## edges', ...edges.map((edge) => `- ${edge.from} -> ${edge.to}`))
  }
  return lines.join('\n')
}

function search(model: CodemapModel, query: string): string {
  const needle = query.toLowerCase()
  const hits: string[] = []
  for (const [id, entry] of model.nodes) {
    const haystack = [id, entry.node.name, entry.node.brief, entry.node.desc, codeOf(entry.node)].join(' ').toLowerCase()
    if (haystack.includes(needle)) hits.push(nodeLine(model, id))
    if (hits.length >= 40) break
  }
  return hits.join('\n') || 'No node matches.'
}

function problems(loaded: LoadedLibrary, node: string): string {
  const checked = checkLibrary(loaded.docs, loaded.requirements, loaded.links)
  const issues = [...loaded.errors, ...checked.base.issues].filter((issue) => issue.level !== 'info' && (!node || issue.where.includes(node)))
  return issues.slice(0, 120).map((issue) => `${issue.level} [${issue.rule}] ${issue.where}: ${issue.msg}`).join('\n') || 'No errors or warnings.'
}

function nodeLine(model: CodemapModel, id: string): string {
  const node = model.nodes.get(id)?.node ?? {}
  const role = roleOf(node)
  return [id, node.kind, node.name ? `「${node.name}」` : '', role && role !== 'step' ? `[${role}]` : '', codeOf(node) ? `@${codeOf(node)}` : '', model.members.has(id) ? '[map]' : ''].filter(Boolean).join(' ')
}

function listKnowledgeFiles(dir: string): string {
  const root = path.resolve(dir)
  const files: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  walk(root)
  return files.sort().join('\n')
}

function readKnowledgeFile(dir: string, relative: string): string {
  const root = path.resolve(dir)
  const file = path.resolve(root, relative)
  if (!isInside(root, file)) throw new Error('path is outside the knowledge folder')
  return readFileSync(file, 'utf8')
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}
