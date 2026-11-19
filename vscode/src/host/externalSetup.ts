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
  jsonSnippet: string
  tomlSnippet: string
  cursorChanged: boolean
  claudeChanged: boolean
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
  return {
    cursorFile,
    claudeFile,
    jsonSnippet: jsonSnippet(config),
    tomlSnippet: tomlSnippet(config),
    cursorChanged: mergeJson(cursorFile, server),
    claudeChanged: mergeJson(claudeFile, server)
  }
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
