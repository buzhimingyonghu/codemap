import { realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { LspHover, LspLocation, LspNavigationKind, LspServerStatus, LspSymbol } from '../../shared/lsp'
import { getShellEnv } from '../shellEnv'
import { LspClient } from './client'
import { ensureCompileDatabase, type CompileDatabaseKind } from './compileDatabase'
import { toHover, toLocations, toSymbols } from './convert'
import { findProjectRoot, resolveServerBinary, SERVER_SPECS, specForLanguage, type ServerSpec } from './servers'

interface OpenDocument {
  uri: string
  languageId: string
  version: number
  clientKey: string
}

const METHOD: Record<LspNavigationKind, string> = {
  definition: 'textDocument/definition',
  declaration: 'textDocument/declaration',
  typeDefinition: 'textDocument/typeDefinition',
  implementation: 'textDocument/implementation',
  references: 'textDocument/references'
}

const CAPABILITY: Record<LspNavigationKind, string> = {
  definition: 'definitionProvider',
  declaration: 'declarationProvider',
  typeDefinition: 'typeDefinitionProvider',
  implementation: 'implementationProvider',
  references: 'referencesProvider'
}

// Owns every language server for the open folder. Servers start lazily on the first document
// of their language, one per (server, project root). Opening a parent folder that holds several
// repositories therefore starts gopls inside each repo's go.mod directory, exactly as it would
// if the repo were opened on its own.
export class LspManager {
  private root: string | null = null
  private realRoot: string | null = null
  private clients = new Map<string, LspClient>()
  private starting = new Map<string, Promise<LspClient | null>>()
  private documents = new Map<string, OpenDocument>()
  private compileDatabases = new Map<string, CompileDatabaseKind>()
  private projectRoots = new Map<string, string>()

  constructor(
    private readonly onLog: (serverId: string, text: string) => void,
    private readonly onStatus: () => void
  ) {}

  async setRoot(root: string | null): Promise<void> {
    await this.stopAll()
    this.root = root
    this.realRoot = root ? await realpath(root).catch(() => root) : null
    this.compileDatabases.clear()
    this.projectRoots.clear()
  }

  // Servers answer with real paths (/private/var/… for /var/…). Map them back onto the
  // folder path the user opened so tabs, tree selection, and breadcrumbs line up.
  private toWorkspacePaths(locations: LspLocation[]): LspLocation[] {
    const { root, realRoot } = this
    if (!root || !realRoot || root === realRoot) return locations
    return locations.map((location) =>
      location.path === realRoot || location.path.startsWith(`${realRoot}/`) ? { ...location, path: root + location.path.slice(realRoot.length) } : location
    )
  }

  private async clientFor(spec: ServerSpec, projectRoot: string): Promise<LspClient | null> {
    const key = `${spec.id}@${projectRoot}`
    const existing = this.clients.get(key)
    if (existing && (existing.state === 'ready' || existing.state === 'starting')) {
      await existing.start().catch(() => undefined)
      return existing.state === 'ready' ? existing : null
    }
    if (existing) return null // failed or stopped; don't respawn in a loop
    const inFlight = this.starting.get(key)
    if (inFlight) return inFlight
    const root = projectRoot
    const boot = (async () => {
      const env = await getShellEnv()
      const binary = await resolveServerBinary(spec, env)
      if (!binary) {
        this.onLog(spec.id, `${spec.command} was not found on PATH or in the usual toolchain folders.\n`)
        return null
      }
      const args = [...spec.args]
      if (spec.id === 'clangd') {
        const database = await ensureCompileDatabase(root).catch(() => ({ kind: null, dir: null }))
        this.compileDatabases.set(root, database.kind)
        if (database.dir) args.push(`--compile-commands-dir=${database.dir}`)
      }
      const client = new LspClient(
        key,
        binary,
        args,
        root,
        env,
        (text) => this.onLog(spec.id, text),
        () => this.onStatus()
      )
      this.clients.set(key, client)
      this.projectRoots.set(key, root)
      this.onStatus()
      try {
        await client.start()
      } catch (error) {
        this.onLog(spec.id, `${error instanceof Error ? error.message : String(error)}\n`)
        await client.stop()
        return null
      } finally {
        this.onStatus()
      }
      return client
    })()
    this.starting.set(key, boot)
    try {
      return await boot
    } finally {
      this.starting.delete(key)
    }
  }

  // macOS paths like /tmp resolve to /private/tmp; servers report the real path, so
  // documents are always registered by real path to keep URIs consistent.
  private async uriFor(file: string): Promise<string> {
    const real = await realpath(file).catch(() => file)
    return pathToFileURL(real).href
  }

  async open(file: string, languageId: string, text: string): Promise<boolean> {
    const spec = specForLanguage(languageId)
    if (!spec || !this.root) return false
    const projectRoot = await findProjectRoot(file, this.root, spec.rootMarkers)
    const client = await this.clientFor(spec, projectRoot)
    if (!client) return false
    const uri = await this.uriFor(file)
    const existing = this.documents.get(file)
    if (existing) {
      this.change(file, text)
      return true
    }
    this.documents.set(file, { uri, languageId, version: 1, clientKey: `${spec.id}@${projectRoot}` })
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } })
    return true
  }

  change(file: string, text: string): void {
    const document = this.documents.get(file)
    const client = document && this.clients.get(document.clientKey)
    if (!document || client?.state !== 'ready') return
    document.version += 1
    client.notify('textDocument/didChange', { textDocument: { uri: document.uri, version: document.version }, contentChanges: [{ text }] })
  }

  save(file: string): void {
    const document = this.documents.get(file)
    const client = document && this.clients.get(document.clientKey)
    if (document && client?.state === 'ready') client.notify('textDocument/didSave', { textDocument: { uri: document.uri } })
  }

  close(file: string): void {
    const document = this.documents.get(file)
    if (!document) return
    this.documents.delete(file)
    const client = this.clients.get(document.clientKey)
    if (client?.state === 'ready') client.notify('textDocument/didClose', { textDocument: { uri: document.uri } })
  }

  private target(file: string): { document: OpenDocument; client: LspClient } | null {
    const document = this.documents.get(file)
    const client = document && this.clients.get(document.clientKey)
    if (!document || !client || client.state !== 'ready') return null
    return { document, client }
  }

  async navigate(kind: LspNavigationKind, file: string, line: number, column: number): Promise<LspLocation[]> {
    const target = this.target(file)
    if (!target || !target.client.capabilities?.[CAPABILITY[kind]]) return []
    const params: any = { textDocument: { uri: target.document.uri }, position: { line: line - 1, character: column - 1 } }
    if (kind === 'references') params.context = { includeDeclaration: true }
    return this.toWorkspacePaths(toLocations(await target.client.request(METHOD[kind], params)))
  }

  async hover(file: string, line: number, column: number): Promise<LspHover | null> {
    const target = this.target(file)
    if (!target || !target.client.capabilities?.hoverProvider) return null
    return toHover(await target.client.request('textDocument/hover', { textDocument: { uri: target.document.uri }, position: { line: line - 1, character: column - 1 } }))
  }

  async symbols(file: string): Promise<LspSymbol[]> {
    const target = this.target(file)
    if (!target || !target.client.capabilities?.documentSymbolProvider) return []
    return toSymbols(await target.client.request('textDocument/documentSymbol', { textDocument: { uri: target.document.uri } }))
  }

  // One row per server type; with several projects open, the "best" state wins so the
  // status bar reads ready as soon as any instance is serving.
  async status(): Promise<LspServerStatus[]> {
    const env = await getShellEnv()
    const rank = { ready: 4, starting: 3, failed: 2, stopped: 1 } as const
    return Promise.all(
      SERVER_SPECS.map(async (spec) => {
        const binary = await resolveServerBinary(spec, env)
        const instances = [...this.clients.entries()].filter(([key]) => key.startsWith(`${spec.id}@`))
        const best = instances.map(([, client]) => client.state).sort((a, b) => rank[b] - rank[a])[0]
        const roots = instances.map(([key]) => this.projectRoots.get(key)).filter((root): root is string => Boolean(root))
        const database = roots.map((root) => this.compileDatabases.get(root)).find(Boolean) ?? null
        return {
          id: spec.id,
          label: spec.label,
          languages: spec.languages,
          binary,
          state: !binary ? 'missing' : (best ?? 'stopped'),
          projectRoots: roots,
          compileDatabase: spec.id === 'clangd' ? database : undefined
        } satisfies LspServerStatus
      })
    )
  }

  async restart(serverId: string): Promise<void> {
    const keys = [...this.clients.keys()].filter((key) => key.startsWith(`${serverId}@`))
    for (const key of keys) {
      await this.clients.get(key)?.stop()
      this.clients.delete(key)
      this.projectRoots.delete(key)
    }
    for (const [file, doc] of [...this.documents.entries()]) if (doc.clientKey.startsWith(`${serverId}@`)) this.documents.delete(file)
    this.onStatus()
  }

  async stopAll(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    this.documents.clear()
    this.projectRoots.clear()
    await Promise.all(clients.map((client) => client.stop()))
    this.onStatus()
  }
}
