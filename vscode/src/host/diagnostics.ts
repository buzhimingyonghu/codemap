import type { Diagnostic, DiagnosticSeverity, Range, Uri } from 'vscode'
import type { Issue } from '../../../src/shared/codemap/codemap.d.mts'

export interface YamlDiagnostic {
  file: string
  line: number
  column: number
  endLine: number
  endColumn: number
  severity: 'error' | 'warning' | 'information'
  message: string
  source: string
  code: string
}

const LINE = /\((\d+):(\d+)\)/g

export function issueFile(where: string): string | null {
  const file = where.split(' ')[0] ?? ''
  return /\.ya?ml$/.test(file) ? file : null
}

export function issueRange(message: string): { line: number; column: number; endLine: number; endColumn: number } {
  const hits = [...message.matchAll(LINE)]
  const last = hits.at(-1)
  if (!last) return { line: 1, column: 1, endLine: 1, endColumn: 1 }
  const line = Math.max(1, Number(last[1]))
  const column = Math.max(1, Number(last[2]))
  return { line, column, endLine: line, endColumn: column + 1 }
}

export function issuesToDiagnostics(library: string, issues: Issue[], join: (...parts: string[]) => string): YamlDiagnostic[] {
  const out: YamlDiagnostic[] = []
  for (const issue of issues) {
    const relative = issueFile(issue.where)
    if (!relative) continue
    const range = issueRange(issue.msg)
    out.push({
      file: join(library, relative),
      ...range,
      severity: issue.level === 'error' ? 'error' : issue.level === 'warn' ? 'warning' : 'information',
      message: `${issue.where}: ${issue.msg}`,
      source: 'codemap',
      code: issue.rule
    })
  }
  return out
}

export function toVsDiagnostic(
  item: YamlDiagnostic,
  vscode: { Diagnostic: new (range: Range, message: string, severity?: DiagnosticSeverity) => Diagnostic; Range: new (startLine: number, startCharacter: number, endLine: number, endCharacter: number) => Range; DiagnosticSeverity: typeof DiagnosticSeverity; Uri: typeof Uri }
): Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(item.line - 1, item.column - 1, item.endLine - 1, item.endColumn - 1),
    item.message,
    item.severity === 'error' ? vscode.DiagnosticSeverity.Error : item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information
  )
  diagnostic.source = item.source
  diagnostic.code = item.code
  return diagnostic
}
