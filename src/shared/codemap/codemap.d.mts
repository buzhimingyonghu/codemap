// Types for codemap.mjs. Node, link, and requirement YAML stay loosely typed on purpose:
// the codemap/v1 format is still evolving, and the validator reports shape problems itself.

/** A parsed YAML object (node, link file, requirement). */
export type CodemapData = Record<string, any>

export type IssueLevel = 'error' | 'warn' | 'info'

export interface Issue {
  level: IssueLevel
  /** Rule id, usable as a key in a node's `ignore`. */
  rule: string
  /** Human-readable location: file plus node / edge / step. */
  where: string
  msg: string
}

export interface NodeDoc {
  /** Path relative to the library root, with `/` separators. */
  file: string
  node: CodemapData
}

export interface LinkDoc {
  file: string
  data: CodemapData
}

export type RequirementDoc = CodemapData & { file: string }

export type DefinedHow = 'file' | 'contains' | 'link' | 'data' | 'missing'

export interface NodeEntry {
  node: CodemapData
  file: string
  how: DefinedHow
  owner: string | null
  list?: unknown[] | null
  /** For links and data: the original object in links.yaml (the entry holds a copy). */
  raw?: CodemapData
  /** For unresolved `{ ref, path }` references. */
  path?: string
  from?: string
}

export interface CodemapModel {
  nodes: Map<string, NodeEntry>
  flows: Map<string, { flow: CodemapData; map: string }>
  /** Map node id → ids drawn on that map. */
  members: Map<string, string[]>
  containedBy: Map<string, Set<string>>
  refs: Map<string, Set<string>>
  issues: Issue[]
  /** Resolves a short or global id from a scope, walking id prefixes outward. */
  resolve(name: unknown, scope?: string | null, table?: Map<string, unknown>): string | null
  proposed?: Map<string, ProposedCode>
}

export interface CodeAnchor {
  /** The node whose `repo` (fn.repo, or the data entry's repo) this location uses. */
  repoId: string | null
  remote: string | null
  /** Local repository folder relative to the library root (may start with `../`). */
  local: string | null
  /** Always empty: code paths are full paths from the repository root. Kept for older callers. */
  dir: string
  file: string | null
  lines: [number, number] | null
}

export interface ParsedCode {
  file: string | null
  lines: [number, number] | null
  bad: boolean
}

export interface ValidateResult {
  issues: Issue[]
  suppressed: number
  /** Node id → repository node id and file: the "code file → nodes" index. */
  anchorFile: Map<string, { repo: string | null; file: string | null } | null>
}

export type ChangeMark = 'add' | 'mod' | 'del'

export interface ProposedCode {
  file?: string
  new?: string
  diff?: string
}

export interface RequirementMarks {
  nodes: Map<string, ChangeMark>
  members: Map<string, ChangeMark>
  edges: Map<string, ChangeMark>
  fields: Map<string, ChangeMark>
  steps: WeakSet<object>
  code: Map<string, ProposedCode>
}

export interface AppliedChange {
  op: 'add' | 'modify' | 'remove'
  what: string
  target: string | null
  /** The map the change was made on (`at`), when it has one. */
  at: string | null
  /** Position in the requirement's `changes` list. */
  index: number
}

export interface AppliedRequirement {
  model: CodemapModel
  problems: Issue[]
  changes: AppliedChange[]
  marks: RequirementMarks
  /** Node and link files after the changes (copies), used when merging into the base map. */
  docs?: NodeDoc[]
  linkDocs?: LinkDoc[]
}

export interface RequirementCheck extends AppliedRequirement {
  req: RequirementDoc
  /** Issues this requirement introduces on top of the base library. */
  issues: Issue[]
  /** Node id → number of changes at or below it (badge counts). */
  impact: Map<string, number>
}

export interface LibraryCheck {
  model: CodemapModel
  base: ValidateResult
  reqs: RequirementCheck[]
}

/** A to-do file in a folder's todo/: path relative to the library, the folder it belongs to, its first heading. */
export interface TodoFile {
  file: string
  dir: string
  title: string
}

export interface IgnoreRule {
  re: RegExp
  negate: boolean
  dirOnly: boolean
}

export interface ApiData {
  apiId: string | null
  api: CodemapData | null
  items: { item: CodemapData; dir: 'request' | 'response'; type: string | null }[]
}

export interface EdgeData {
  apis: ApiData[]
  items: ApiData['items']
  request: string[]
  response: string[]
}

export declare const STRUCT_KINDS: Set<string>
export declare const FN_TYPES: Set<string>
export declare const EDGE_MODES: Set<string>
export declare const IGNORE_FILE: string
export declare const DEFAULT_IGNORE: string[]

export declare function prefixOf(id: string): string | null
export declare function asList<T>(value: T | T[] | null | undefined): T[]
export declare function fileKind(data: unknown): 'node' | 'link' | 'requirement'
export declare function parseIgnore(text: string | null | undefined): IgnoreRule[]
export declare function isIgnored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean
export declare function refPaths(node: CodemapData): { ref: string; path: string }[]
export declare function fnOf(node: CodemapData | null | undefined): CodemapData
export declare function roleOf(node: CodemapData | null | undefined): 'entry' | 'gate' | 'end' | 'step' | null
export declare function parseCode(code: unknown): ParsedCode | null
export declare function codeOf(node: CodemapData | null | undefined): string | undefined
/** The repository written next to a code location: `fn.repo` for functions, `repo` for data. */
export declare function codeRepoOf(node: CodemapData | null | undefined): unknown
/** Normalized repository identity from `remote` (git@host:a/b.git and https://host/a/b match). */
export declare function repoKey(repo: { remote?: string } | null | undefined): string | null
export declare function groupBy<T extends Record<string, any>>(list: T[], key: keyof T): Map<unknown, T[]>
export declare function sampleEntries(text: string | null | undefined): { type: string; entries: { key: string; value: string }[] } | null
export declare function sampleKeys(text: string | null | undefined): { type: string; keys: string[] } | null
export declare function dataDir(item: CodemapData | null | undefined): 'request' | 'response'
export declare function normRepo(repo: unknown): { remote?: string; dir?: string; local?: string } | null
export declare function dirOf(file: string | null | undefined): string
export declare function joinPath(base: string, rel: string): string
export declare function kbPath(url: string, nodeFile: string): string
export declare function apiData(model: CodemapModel, via: unknown, map: string): ApiData
/** A link's heartbeat: '' when the period is set by the client, the period ('3s'), or null when it is not a heartbeat. */
export declare function heartbeatOf(api: CodemapData | null | undefined): string | null
export declare function edgeData(model: CodemapModel, map: string, edge: CodemapData | null | undefined): EdgeData
export declare function stepChoices(edgeData: EdgeData, back: boolean, kind?: string): string[]
export declare function ioOf(model: CodemapModel, id: string): { in: string[]; out: string | null }
export declare function buildModel(docs: NodeDoc[], linkDocs?: LinkDoc[]): CodemapModel
export declare function repoFor(model: CodemapModel, id: string): string | null
/** An issue's code: line numbers alone are lines of the node's own file. */
export declare function issueCode(model: CodemapModel, id: string, code: unknown): string | null
export declare function scopeAnchorFor(model: CodemapModel, id: string): { id: string; file: string } | null
export declare function resolveCode(model: CodemapModel, id: string, code?: unknown): CodeAnchor | null
export declare function validate(model: CodemapModel): ValidateResult
export declare function resolveField(model: CodemapModel, ref: string, scope: string): string | null
export declare function applyRequirement(sourceDocs: NodeDoc[], req: RequirementDoc, sourceLinks?: LinkDoc[]): AppliedRequirement
export declare function impact(models: CodemapModel[], changes: AppliedChange[]): Map<string, number>
export declare function issueKey(issue: Issue): string
export declare function checkLibrary(docs: NodeDoc[], requirements: RequirementDoc[], links?: LinkDoc[]): LibraryCheck
