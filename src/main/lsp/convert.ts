import { fileURLToPath } from 'node:url'
import type { LspHover, LspLocation, LspSymbol } from '../../shared/lsp'

// LSP uses 0-based positions; Monaco and the rest of Codemap use 1-based.
function toLocation(uri: string, range: any): LspLocation | null {
  if (!uri?.startsWith('file:')) return null
  return {
    path: fileURLToPath(uri),
    line: (range?.start?.line ?? 0) + 1,
    column: (range?.start?.character ?? 0) + 1,
    endLine: (range?.end?.line ?? range?.start?.line ?? 0) + 1,
    endColumn: (range?.end?.character ?? range?.start?.character ?? 0) + 1
  }
}

// Accepts Location | Location[] | LocationLink[] | null.
export function toLocations(result: any): LspLocation[] {
  if (!result) return []
  const list = Array.isArray(result) ? result : [result]
  const locations: LspLocation[] = []
  for (const entry of list) {
    const location = entry?.targetUri ? toLocation(entry.targetUri, entry.targetSelectionRange ?? entry.targetRange) : toLocation(entry?.uri, entry?.range)
    if (location) locations.push(location)
  }
  return locations
}

function markedToString(content: any): string {
  if (typeof content === 'string') return content
  if (content?.kind === 'plaintext') return '```\n' + content.value + '\n```'
  if (content?.kind === 'markdown') return content.value
  if (content?.language) return '```' + content.language + '\n' + content.value + '\n```'
  return content?.value ?? ''
}

export function toHover(result: any): LspHover | null {
  if (!result?.contents) return null
  const raw = Array.isArray(result.contents) ? result.contents : [result.contents]
  const contents = raw.map(markedToString).filter((text: string) => text.trim())
  if (!contents.length) return null
  const range = result.range
    ? {
        line: result.range.start.line + 1,
        column: result.range.start.character + 1,
        endLine: result.range.end.line + 1,
        endColumn: result.range.end.character + 1
      }
    : undefined
  return { contents, range }
}

// Accepts DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat).
export function toSymbols(result: any): LspSymbol[] {
  if (!Array.isArray(result)) return []
  const convert = (symbol: any): LspSymbol => {
    const range = symbol.selectionRange ?? symbol.range ?? symbol.location?.range
    const full = symbol.range ?? symbol.location?.range ?? range
    return {
      name: symbol.name,
      detail: symbol.detail ?? symbol.containerName,
      kind: symbol.kind,
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: full.end.line + 1,
      endColumn: full.end.character + 1,
      children: Array.isArray(symbol.children) ? symbol.children.map(convert) : undefined
    }
  }
  return result.filter((symbol) => symbol?.range || symbol?.location?.range).map(convert)
}
