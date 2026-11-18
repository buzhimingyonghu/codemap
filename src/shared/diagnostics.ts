import type { Diagnostic } from './types'
import { isInside, joinPath, normalizePath } from './paths'

// Matches compiler output such as `src/main.c:12:5: error: message` (clang, gcc, tsc --pretty false, rustc short, go).
const LOCATION_PATTERN =
  /^(?<file>[^\s:][^:]*?\.[A-Za-z0-9_+-]+):(?<line>\d+)(?::(?<column>\d+))?:?\s*(?:(?<severity>fatal error|error|warning|note|info)\b(?:\[[^\]]+\])?:?\s*)?(?<message>.*)$/
// Matches TypeScript's default format `src/a.ts(12,5): error TS2322: message`.
const PAREN_PATTERN =
  /^(?<file>[^\s(][^(]*?\.[A-Za-z0-9_+-]+)\((?<line>\d+),(?<column>\d+)\):\s*(?<severity>error|warning|info)\s*(?:[A-Z]+\d+)?:?\s*(?<message>.*)$/

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

function toSeverity(raw: string | undefined): Diagnostic['severity'] {
  if (!raw) return 'error'
  if (raw.includes('warning')) return 'warning'
  if (raw === 'note' || raw === 'info') return 'note'
  return 'error'
}

export function parseDiagnosticLine(rawLine: string, cwd: string): Diagnostic | null {
  const line = stripAnsi(rawLine).trim()
  if (!line || line.length > 2000) return null
  const match = PAREN_PATTERN.exec(line) ?? LOCATION_PATTERN.exec(line)
  if (!match?.groups) return null
  const { file, line: lineText, column, severity, message } = match.groups
  if (!severity && !/error|warning/i.test(message ?? '')) return null
  const resolved = file.startsWith('/') ? normalizePath(file) : joinPath(cwd, file)
  if (!file.startsWith('/') && !isInside(cwd, resolved)) return null
  return {
    file: resolved,
    line: Math.max(1, Number(lineText)),
    column: Math.max(1, Number(column ?? 1)),
    severity: toSeverity(severity?.toLowerCase()),
    message: (message ?? '').trim() || line
  }
}

export function parseDiagnostics(output: string, cwd: string): Diagnostic[] {
  const seen = new Set<string>()
  const result: Diagnostic[] = []
  for (const line of output.split(/\r?\n/)) {
    const diagnostic = parseDiagnosticLine(line, cwd)
    if (!diagnostic) continue
    const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.message}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(diagnostic)
  }
  return result
}
