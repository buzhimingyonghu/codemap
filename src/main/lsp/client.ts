import { spawn, type ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { encodeMessage, MessageReader } from '../dap/protocol'

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string }
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export type ClientState = 'starting' | 'ready' | 'stopped' | 'failed'

// One JSON-RPC connection to one language server process. Uses the same
// Content-Length framing as DAP, so the reader is shared.
export class LspClient {
  private process: ChildProcess | null = null
  private reader = new MessageReader<JsonRpcMessage>()
  private seq = 1
  private pending = new Map<number, Pending>()
  private ready: Promise<void> | null = null
  state: ClientState = 'starting'
  capabilities: any = {}

  constructor(
    readonly serverId: string,
    private readonly binary: string,
    private readonly args: string[],
    private readonly root: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly onLog: (text: string) => void,
    private readonly onExit: () => void
  ) {}

  start(): Promise<void> {
    this.ready ??= this.boot()
    return this.ready
  }

  private async boot(): Promise<void> {
    const child = spawn(this.binary, this.args, { cwd: this.root, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.process = child
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const message of this.reader.push(chunk)) this.handle(message)
    })
    child.stderr?.on('data', (chunk: Buffer) => this.onLog(chunk.toString('utf8')))
    child.on('error', (error) => {
      this.onLog(`${error.message}\n`)
      this.teardown('failed')
    })
    child.on('exit', () => this.teardown(this.state === 'starting' ? 'failed' : 'stopped'))

    const rootUri = pathToFileURL(this.root).href
    const result = await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'Codemap' },
        rootUri,
        rootPath: this.root,
        workspaceFolders: [{ uri: rootUri, name: this.root.split('/').pop() }],
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false },
            definition: { linkSupport: true },
            declaration: { linkSupport: true },
            typeDefinition: { linkSupport: true },
            implementation: { linkSupport: true },
            references: {},
            hover: { contentFormat: ['markdown', 'plaintext'] },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true }
          },
          workspace: { workspaceFolders: true, configuration: false }
        },
        initializationOptions: {}
      },
      30000
    )
    this.capabilities = result?.capabilities ?? {}
    this.notify('initialized', {})
    this.state = 'ready'
  }

  private handle(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(Number(message.id))
      if (!pending) return
      this.pending.delete(Number(message.id))
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }
    // Server-to-client requests must be answered or some servers stall.
    if (message.id !== undefined && message.method) {
      let result: unknown = null
      if (message.method === 'workspace/configuration') result = (message.params?.items ?? []).map(() => null)
      if (message.method === 'workspace/workspaceFolders') result = [{ uri: pathToFileURL(this.root).href, name: this.root.split('/').pop() }]
      this.write({ jsonrpc: '2.0', id: message.id, result })
      return
    }
    if (message.method === 'window/logMessage' && message.params?.type <= 1) this.onLog(`${message.params.message}\n`)
  }

  private write(message: JsonRpcMessage): void {
    if (!this.process?.stdin?.writable) return
    this.process.stdin.write(encodeMessage(message))
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 15000): Promise<T> {
    if (!this.process || this.state === 'stopped' || this.state === 'failed') return Promise.reject(new Error(`${this.serverId} is not running`))
    const id = this.seq++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  async stop(): Promise<void> {
    if (!this.process) return
    try {
      await this.request('shutdown', null, 2000)
      this.notify('exit', null)
    } catch {
      /* server may already be gone */
    }
    const child = this.process
    setTimeout(() => child?.kill('SIGKILL'), 1500).unref()
    this.teardown('stopped')
  }

  private teardown(state: ClientState): void {
    if (this.state === 'stopped' || this.state === 'failed') return
    this.state = state
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`${this.serverId} stopped`))
    }
    this.pending.clear()
    this.process = null
    this.onExit()
  }
}
