import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface ExternalMcpConfig {
  workspaceRoot: string
  mcpScriptPath: string
  registryDir: string
  knowledgeDir: string
  command?: string
}

export interface ExternalSetupResult {
  cursorFile: string
  claudeFile: string
  skillFile: string
  jsonSnippet: string
  tomlSnippet: string
  cursorChanged: boolean
  claudeChanged: boolean
  skillChanged: boolean
}

interface McpServerConfig {
  command: string
  args: string[]
}

export function mcpServerConfig(config: ExternalMcpConfig): McpServerConfig {
  return {
    command: config.command || 'node',
    args: [config.mcpScriptPath, '--registry-dir', config.registryDir, '--knowledge-dir', config.knowledgeDir, '--workspace', config.workspaceRoot]
  }
}

export function jsonSnippet(config: ExternalMcpConfig): string {
  return `${JSON.stringify({ mcpServers: { codemap: mcpServerConfig(config) } }, null, 2)}\n`
}

export function tomlSnippet(config: ExternalMcpConfig): string {
  const server = mcpServerConfig(config)
  const args = server.args.map((arg) => JSON.stringify(arg)).join(', ')
  return `[mcp_servers.codemap]\ncommand = ${JSON.stringify(server.command)}\nargs = [${args}]\n`
}

export function setupExternalAgents(config: ExternalMcpConfig): ExternalSetupResult {
  const server = mcpServerConfig(config)
  const cursorFile = path.join(config.workspaceRoot, '.cursor', 'mcp.json')
  const claudeFile = path.join(config.workspaceRoot, '.mcp.json')
  const skillFile = path.join(config.workspaceRoot, '.agents', 'skills', 'codemap', 'SKILL.md')
  return {
    cursorFile,
    claudeFile,
    skillFile,
    jsonSnippet: jsonSnippet(config),
    tomlSnippet: tomlSnippet(config),
    cursorChanged: mergeJson(cursorFile, server),
    claudeChanged: mergeJson(claudeFile, server),
    skillChanged: writeIfChanged(skillFile, skillMarkdown())
  }
}

export function skillMarkdown(): string {
  return `${SKILL_MARKDOWN.trim()}
`
}

export function appendTomlSnippet(file: string, snippet: string): boolean {
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    current = ''
  }
  if (/^\s*\[mcp_servers\.codemap\]\s*$/m.test(current)) return false
  const next = `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${snippet.trim()}\n`
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, next)
  return true
}


function writeIfChanged(file: string, content: string): boolean {
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    current = ''
  }
  if (current === content) return false
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  return true
}

const SKILL_MARKDOWN = `
# CodeMap

Use the \`codemap\` MCP server to read and propose a CodeMap. Do not write node YAML until a person applies the proposal.

## Tools

- \`scan_repo_entrypoints\`: scan a workspace or granted repo for routes, RPCs, MQ/watch consumers, cron/timers, DB/Redis calls, and the git remote. Pass \`path\` for a folder and \`targetFolder\` for the node folder used to calculate \`repo.local\`.
- \`map_overview\`: list the live maps.
- \`read_node\`: read one node by global id.
- \`show_on_map\`: open a map, light nodes, select a flow, and show a note.
- \`propose_change_set\`: propose reviewed files and changes. Pass \`extend\` to update a pending proposal in place. Pass \`replaceChanges: true\` to replace its changes; otherwise new changes are appended and files are merged by path.
- \`discard_change_set\`: discard an unapplied proposal by \`id\` when a draft is wedged. This does not change library files.

## Build choices

Pick one tier and one perspective before building:

- Tiers: \`fast\` (L0 panorama + L1 component architecture, no review pause), \`balanced\` (one blueprint check, then L0+L1), \`deep\` (stage-by-stage drill-down). Default scope stops at L0 and L1. Generate a \`kind: function\` execution map only when the user names one node or explicitly picks \`deep\`.
- Perspectives: \`service\` (microservices, entrypoints, storage), \`business\` (product stages), \`troubleshoot\` (state, retries, timeouts, background jobs).

## Visual hierarchy

Keep L0 and L1 readable:

- Lay the main path out as 2–4 named left-to-right \`lanes\` (for example access, orchestration, domain, downstream). \`lanes.name\` is rendered as the layer title, so use a short Chinese title.
- Dock non-main nodes: callers \`left\`, config/registry/auth \`top\`, third parties and notification targets \`right\`, DB/Redis/MQ/object storage \`bottom\`.
- At most 4 nodes in one business column, 8 core business nodes, and 12 nodes on the whole map including docks. Aggregate before adding another box.
- Node \`name\`: 2–6 Chinese characters. Key edge \`name\`: a 2–6 character verb such as 创建订单 or 锁定库存. Do not mix function nodes into L0 or L1.

Read \`codemap://knowledge/common/guide.md\` and follow \`create/SOP.md\` for the chosen tier and perspective.

## Checker

Proposals must stay valid \`codemap/v1\`: every node has a name and kind, ids are unique, a map with edges or flows has \`contains\`, edge ends belong to that map, and code locations include their repo. Fix reported errors with \`extend\`, or discard the draft and start a clean proposal.
`
function mergeJson(file: string, server: McpServerConfig): boolean {
  const current = readJson(file)
  const servers = isRecord(current.mcpServers) ? { ...current.mcpServers } : {}
  const existing = servers.codemap
  if (isRecord(existing) && JSON.stringify(existing) === JSON.stringify(server)) return false
  const preserved = Object.fromEntries(Object.entries(servers).filter(([name]) => name !== 'codemap'))
  const next = { ...current, mcpServers: { ...preserved, codemap: server } }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  return true
}

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
