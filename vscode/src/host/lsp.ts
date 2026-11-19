import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { LspHover, LspLocation, LspNavigationKind, LspServerStatus, LspSymbol } from '../../../src/shared/lsp'

export interface VsCodeUri {
  scheme: string
  fsPath: string
}

export interface VsCodePosition {
  line: number
  character: number
}

export interface VsCodeRange {
  start: VsCodePosition
  end: VsCodePosition
}

export interface VsCodeLocation {
  uri: VsCodeUri
  range: VsCodeRange
}

export interface VsCodeLocationLink {
  targetUri: VsCodeUri
  targetRange: VsCodeRange
  targetSelectionRange?: VsCodeRange
}

export interface VsCodeMarkdownString {
  value: string
  language?: string
}

export interface VsCodeHover {
  contents: Array<string | VsCodeMarkdownString> | string | VsCodeMarkdownString
  range?: VsCodeRange
}

export interface VsCodeDocumentSymbol {
  name: string
  detail?: string
  kind: number
  range: VsCodeRange
  selectionRange: VsCodeRange
  children?: VsCodeDocumentSymbol[]
}

export interface VsCodeSymbolInformation {
  name: string
  kind: number
  containerName?: string
  location: VsCodeLocation
}

export interface VsCodeTextDocument {
  uri: VsCodeUri
  getText?(): string
  isDirty?: boolean
}

type Thenable<T> = PromiseLike<T>

export interface VsCodeWorkspaceFolder {
  uri: VsCodeUri
  name: string
}

export interface VsCodeLspHost {
  Uri: {
    file(filePath: string): VsCodeUri
  }
  workspace: {
    openTextDocument(uri: VsCodeUri): Thenable<VsCodeTextDocument>
    workspaceFolders: readonly VsCodeWorkspaceFolder[] | undefined
  }
  commands: {
    executeCommand(command: string, ...args: unknown[]): Thenable<unknown>
  }
}

const NAVIGATION_COMMANDS: Record<LspNavigationKind, string> = {
  definition: 'vscode.executeDefinitionProvider',
  declaration: 'vscode.executeDeclarationProvider',
  typeDefinition: 'vscode.executeTypeDefinitionProvider',
  implementation: 'vscode.executeImplementationProvider',
  references: 'vscode.executeReferenceProvider'
}

export class VsCodeLspBridge {
  private readonly approvedFiles = new Set<string>()
  private readonly liveBuffers = new Map<string, string>()

  constructor(private readonly host: VsCodeLspHost) {}

  async open(filePath: string, _languageId?: string, text?: string): Promise<boolean> {
    if (typeof text === 'string') this.liveBuffers.set(normalizeFile(filePath), text)
    try {
      await this.host.workspace.openTextDocument(this.host.Uri.file(path.resolve(filePath)))
      return true
    } catch {
      return false
    }
  }

  change(filePath: string, text: string): void {
    this.liveBuffers.set(normalizeFile(filePath), text)
  }

  async save(filePath: string): Promise<void> {
    this.liveBuffers.delete(normalizeFile(filePath))
  }

  async close(filePath: string): Promise<void> {
    this.liveBuffers.delete(normalizeFile(filePath))
  }

  getDirtyBuffer(filePath: string): string | undefined {
    return this.liveBuffers.get(normalizeFile(filePath))
  }

  async navigate(kind: LspNavigationKind, filePath: string, line: number, column: number): Promise<LspLocation[]> {
    const mapped = await this.mapRequest(filePath, line, column)
    const result = await this.execute(NAVIGATION_COMMANDS[kind], filePath, mapped.line, mapped.column)
    return this.remapLocations(filePath, mapped.bufferText, mapped.docText, this.toLocations(result))
  }

  async hover(filePath: string, line: number, column: number): Promise<LspHover | null> {
    const mapped = await this.mapRequest(filePath, line, column)
    const result = await this.execute('vscode.executeHoverProvider', filePath, mapped.line, mapped.column)
    const hovers = Array.isArray(result) ? (result as VsCodeHover[]) : result ? [result as VsCodeHover] : []
    const contents: string[] = []
    for (const hover of hovers) {
      const parts = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
      for (const part of parts) {
        const text = markedToString(part)
        if (text.trim()) contents.push(text)
      }
    }
    if (!contents.length) return null
    const range = hovers.find((hover) => hover.range)?.range
    const lumenRange = range ? toLumenRange(range) : undefined
    return {
      contents,
      range: lumenRange && mapped.bufferText != null && mapped.docText != null && mapped.bufferText !== mapped.docText
        ? mapDocToBufferRange(mapped.docText, mapped.bufferText, lumenRange)
        : lumenRange
    }
  }

  async symbols(filePath: string): Promise<LspSymbol[]> {
    const result = await this.executeDocument(filePath, 'vscode.executeDocumentSymbolProvider')
    if (!Array.isArray(result)) return []
    return result.flatMap((symbol) => {
      const converted = toLumenSymbol(symbol as VsCodeDocumentSymbol | VsCodeSymbolInformation)
      return converted ? [converted] : []
    })
  }

  async status(): Promise<LspServerStatus[]> {
    const folders = this.host.workspace.workspaceFolders
    if (!folders?.length) return []
    return [
      {
        id: 'vscode',
        label: 'VS Code Language Features',
        languages: [],
        state: 'ready',
        binary: null,
        projectRoots: folders.map((folder) => folder.uri.fsPath)
      }
    ]
  }

  isApprovedFile(filePath: string): boolean {
    return approvalKeys(filePath).some((key) => this.approvedFiles.has(key))
  }

  private async execute(command: string, filePath: string, line: number, column: number): Promise<unknown> {
    const uri = this.host.Uri.file(path.resolve(filePath))
    return this.host.commands.executeCommand(command, uri, toVsCodePosition(line, column))
  }

  private async executeDocument(filePath: string, command: string): Promise<unknown> {
    const uri = this.host.Uri.file(path.resolve(filePath))
    return this.host.commands.executeCommand(command, uri)
  }

  private async mapRequest(filePath: string, line: number, column: number): Promise<{ line: number; column: number; bufferText?: string; docText?: string }> {
    const normPath = normalizeFile(filePath)
    const bufferText = this.liveBuffers.get(normPath)
    if (bufferText == null) return { line, column }
    let docText: string | undefined
    try {
      const doc = await this.host.workspace.openTextDocument(this.host.Uri.file(path.resolve(filePath)))
      if (typeof doc?.getText === 'function') docText = doc.getText()
    } catch {
      docText = undefined
    }
    if (docText == null || docText === bufferText) return { line, column, bufferText, docText }
    const mapped = mapBufferToDocPosition(bufferText, docText, line, column)
    return { line: mapped.line, column: mapped.column, bufferText, docText }
  }

  private remapLocations(filePath: string, bufferText: string | undefined, docText: string | undefined, locations: LspLocation[]): LspLocation[] {
    if (bufferText == null || docText == null || bufferText === docText) return locations
    const source = normalizeFile(filePath)
    return locations.map((location) => {
      if (normalizeFile(location.path) !== source) return location
      return { ...location, ...mapDocToBufferRange(docText, bufferText, location) }
    })
  }

  private toLocations(result: unknown): LspLocation[] {
    if (!result) return []
    const entries = Array.isArray(result) ? result : [result]
    const locations: LspLocation[] = []
    for (const entry of entries) {
      const location = toLumenLocation(entry as VsCodeLocation | VsCodeLocationLink)
      if (!location) continue
      this.approve(location.path)
      locations.push(location)
    }
    return locations
  }

  private approve(filePath: string): void {
    for (const key of approvalKeys(filePath)) this.approvedFiles.add(key)
  }
}

export function createVsCodeLspAdapter(vscode: typeof import('vscode')): VsCodeLspHost {
  return {
    Uri: vscode.Uri,
    workspace: vscode.workspace,
    commands: vscode.commands
  }
}

function toVsCodePosition(line: number, column: number): VsCodePosition {
  return { line: Math.max(0, line - 1), character: Math.max(0, column - 1) }
}

function toLumenRange(range: VsCodeRange): NonNullable<LspHover['range']> {
  return {
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}

function isLocationLink(value: VsCodeLocation | VsCodeLocationLink): value is VsCodeLocationLink {
  return 'targetUri' in value && value.targetUri != null
}

function toLumenLocation(entry: VsCodeLocation | VsCodeLocationLink): LspLocation | null {
  if (!entry) return null
  if (isLocationLink(entry)) {
    if (entry.targetUri?.scheme !== 'file' || !entry.targetUri.fsPath) return null
    const range = entry.targetSelectionRange ?? entry.targetRange
    if (!range) return null
    return { path: path.normalize(entry.targetUri.fsPath), ...toLumenRange(range) }
  }
  if (entry.uri?.scheme !== 'file' || !entry.uri.fsPath || !entry.range) return null
  return { path: path.normalize(entry.uri.fsPath), ...toLumenRange(entry.range) }
}

function markedToString(content: string | VsCodeMarkdownString | undefined): string {
  if (typeof content === 'string') return content
  if (!content || typeof content.value !== 'string') return ''
  if (content.language) return '```' + content.language + '\n' + content.value + '\n```'
  return content.value
}

function isDocumentSymbol(symbol: VsCodeDocumentSymbol | VsCodeSymbolInformation): symbol is VsCodeDocumentSymbol {
  return 'selectionRange' in symbol || 'children' in symbol
}

function toLumenSymbol(symbol: VsCodeDocumentSymbol | VsCodeSymbolInformation): LspSymbol | null {
  if (isDocumentSymbol(symbol)) {
    const selection = symbol.selectionRange ?? symbol.range
    const full = symbol.range ?? selection
    if (!selection || !full) return null
    const children = symbol.children?.flatMap((child) => {
      const converted = toLumenSymbol(child)
      return converted ? [converted] : []
    })
    return {
      name: symbol.name,
      detail: symbol.detail,
      kind: symbol.kind + 1,
      line: selection.start.line + 1,
      column: selection.start.character + 1,
      endLine: full.end.line + 1,
      endColumn: full.end.character + 1,
      children
    }
  }
  const range = symbol.location?.range
  if (!range || symbol.location.uri?.scheme === 'untitled') return null
  return {
    name: symbol.name,
    detail: symbol.containerName,
    kind: symbol.kind + 1,
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}

function approvalKeys(filePath: string): string[] {
  const normalized = path.normalize(path.resolve(filePath))
  const keys = [normalized]
  try {
    const resolved = path.normalize(realpathSync(normalized))
    if (resolved !== normalized) keys.push(resolved)
  } catch {
    /* missing or unreachable path still keeps the normalized form */
  }
  return keys
}

function normalizeFile(filePath: string): string {
  return path.normalize(path.resolve(filePath))
}

export function mapBufferToDocPosition(bufferText: string, docText: string, line1: number, col1: number): { line: number; column: number } {
  return mapLine(bufferText, docText, line1, col1)
}

export function mapDocToBufferRange(
  docText: string,
  bufferText: string,
  range1: { line: number; column: number; endLine: number; endColumn: number }
): { line: number; column: number; endLine: number; endColumn: number } {
  const start = mapLine(docText, bufferText, range1.line, range1.column)
  const end = mapLine(docText, bufferText, range1.endLine, range1.endColumn)
  return { line: start.line, column: start.column, endLine: end.line, endColumn: end.column }
}

function mapLine(fromText: string, toText: string, line1: number, col1: number): { line: number; column: number } {
  const fromLines = splitLines(fromText)
  const toLines = splitLines(toText)
  const { prefixLines, suffixLines } = commonEdges(fromLines, toLines)
  const safeLine = clamp(Math.trunc(line1) || 1, 1, Math.max(1, fromLines.length))
  const column = Math.max(1, Math.trunc(col1) || 1)
  if (safeLine <= prefixLines) return { line: safeLine, column }

  const suffixStart = fromLines.length - suffixLines
  if (suffixLines > 0 && safeLine > suffixStart) {
    const delta = toLines.length - fromLines.length
    return { line: Math.max(1, safeLine + delta), column }
  }

  const editedStart = prefixLines + 1
  const editedEnd = Math.max(editedStart, toLines.length - suffixLines)
  const fromEdited = Math.max(1, suffixStart - prefixLines)
  const toEdited = Math.max(1, editedEnd - prefixLines)
  const offset = safeLine - prefixLines
  const proportional = editedStart + Math.min(toEdited, Math.max(1, Math.round((offset * toEdited) / fromEdited))) - 1
  const clamped = clamp(proportional, editedStart, Math.min(editedEnd, Math.max(1, toLines.length)))
  const token = tokenAt(fromLines[safeLine - 1] ?? '', column)
  if (token) {
    const nearby = nearbyToken(toLines, clamped, token)
    if (nearby) return nearby
  }
  return { line: clamped, column }
}

function commonEdges(fromLines: string[], toLines: string[]): { prefixLines: number; suffixLines: number } {
  const limit = Math.min(fromLines.length, toLines.length)
  let prefixLines = 0
  while (prefixLines < limit && fromLines[prefixLines] === toLines[prefixLines]) prefixLines += 1
  let suffixLines = 0
  while (
    suffixLines < limit - prefixLines &&
    fromLines[fromLines.length - 1 - suffixLines] === toLines[toLines.length - 1 - suffixLines]
  ) {
    suffixLines += 1
  }
  return { prefixLines, suffixLines }
}

function nearbyToken(lines: string[], around: number, token: string): { line: number; column: number } | null {
  for (let distance = 0; distance <= 3; distance += 1) {
    const candidates = distance === 0 ? [around] : [around - distance, around + distance]
    for (const line of candidates) {
      if (line < 1 || line > lines.length) continue
      const column = lines[line - 1]?.indexOf(token)
      if (column != null && column >= 0) return { line, column: column + 1 }
    }
  }
  return null
}

function tokenAt(line: string, column1: number): string {
  if (!line) return ''
  const index = clamp(column1 - 1, 0, Math.max(0, line.length - 1))
  if (!isIdent(line[index] ?? '')) return ''
  let start = index
  let end = index + 1
  while (start > 0 && isIdent(line[start - 1] ?? '')) start -= 1
  while (end < line.length && isIdent(line[end] ?? '')) end += 1
  return line.slice(start, end)
}

function isIdent(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char)
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
