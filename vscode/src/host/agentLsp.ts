import { readFileSync } from 'node:fs'
import type { LspSymbol } from '../../../src/shared/lsp'
import type { VsCodeLspBridge } from './lsp'

const SYMBOL_KINDS = [
  'file',
  'module',
  'namespace',
  'package',
  'class',
  'method',
  'property',
  'field',
  'constructor',
  'enum',
  'interface',
  'function',
  'variable',
  'constant',
  'string',
  'number',
  'boolean',
  'array',
  'object',
  'key',
  'null',
  'enumMember',
  'struct',
  'event',
  'operator',
  'typeParameter'
]

export interface AgentLspTools {
  symbols(file: string): Promise<string>
  navigate(kind: 'definition' | 'implementation' | 'references', file: string, line: number, column: number): Promise<string>
  hover(file: string, line: number, column: number): Promise<string>
}

export function createAgentLspTools(lspBridge: VsCodeLspBridge): AgentLspTools {
  return {
    async symbols(file) {
      const symbols = await lspBridge.symbols(file)
      if (!symbols.length) return '(no symbols)'
      return formatSymbols(symbols).join('\n')
    },
    async navigate(kind, file, line, column) {
      const locations = await lspBridge.navigate(kind, file, line, column)
      const unique = dedupeLocations(locations).slice(0, 40)
      if (!unique.length) return `(no ${kind})`
      return unique
        .map((location) => {
          const preview = sourceLine(location.path, location.line)
          return `${location.path}:${location.line}:${location.column}${preview ? `  ${preview}` : ''}`
        })
        .join('\n')
    },
    async hover(file, line, column) {
      const hover = await lspBridge.hover(file, line, column)
      if (!hover?.contents.length) return '(no hover)'
      return hover.contents.join('\n\n')
    }
  }
}

function formatSymbols(symbols: LspSymbol[], depth = 0): string[] {
  const lines: string[] = []
  for (const symbol of symbols) {
    const kind = SYMBOL_KINDS[symbol.kind - 1] ?? 'symbol'
    lines.push(`${'  '.repeat(depth)}${kind} ${symbol.name} [L${symbol.line}-L${symbol.endLine}]`)
    if (symbol.children?.length) lines.push(...formatSymbols(symbol.children, depth + 1))
  }
  return lines
}

function dedupeLocations<T extends { path: string; line: number; column: number }>(locations: T[]): T[] {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const location of locations) {
    const key = `${location.path}:${location.line}:${location.column}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(location)
  }
  return unique
}

function sourceLine(file: string, line: number): string {
  try {
    const text = readFileSync(file, 'utf8')
    return (text.split(/\r?\n/)[line - 1] ?? '').trim().slice(0, 160)
  } catch {
    return ''
  }
}
