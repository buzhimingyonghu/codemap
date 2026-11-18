// Plain data shapes exchanged between the renderer and the main-process LSP manager.
// Positions are 1-based lines and columns to match Monaco; conversion happens in main.

export interface LspLocation {
  path: string
  line: number
  column: number
  endLine: number
  endColumn: number
}

export interface LspHover {
  contents: string[]
  range?: { line: number; column: number; endLine: number; endColumn: number }
}

export interface LspSymbol {
  name: string
  detail?: string
  kind: number
  line: number
  column: number
  endLine: number
  endColumn: number
  children?: LspSymbol[]
}

export type LspServerState = 'missing' | 'starting' | 'ready' | 'stopped' | 'failed'

export interface LspServerStatus {
  id: string
  label: string
  languages: string[]
  state: LspServerState
  binary: string | null
  projectRoots?: string[]
  compileDatabase?: 'compile_commands.json' | 'compile_flags.txt' | 'generated' | null
}

export type LspNavigationKind = 'definition' | 'declaration' | 'typeDefinition' | 'implementation' | 'references'
