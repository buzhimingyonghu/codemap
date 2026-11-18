import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import type {
  DebugBreakpoint,
  DebugEvent,
  DebugLaunchConfig,
  DebugScope,
  DebugThread,
  DebugVariable,
  StackFrame
} from '../../shared/types'
import { encodeMessage, MessageReader, type DapMessage } from './protocol'

const CANDIDATE_ADAPTERS = [
  '/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-dap',
  '/Library/Developer/CommandLineTools/usr/bin/lldb-dap',
  '/opt/homebrew/opt/llvm/bin/lldb-dap'
]

async function findLldbDap(): Promise<string> {
  const fromXcrun = await new Promise<string | null>((resolve) => {
    execFile('xcrun', ['-f', 'lldb-dap'], { timeout: 5000 }, (error, stdout) => resolve(error ? null : stdout.trim()))
  })
  const candidates = fromXcrun ? [fromXcrun, ...CANDIDATE_ADAPTERS] : CANDIDATE_ADAPTERS
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      /* try next */
    }
  }
  throw new Error('lldb-dap was not found. Install Xcode Command Line Tools with `xcode-select --install`.')
}

type Pending = { resolve: (message: DapMessage) => void; reject: (error: Error) => void }

export class DebugSession {
  private adapter: ChildProcess | null = null
  private reader = new MessageReader()
  private seq = 1
  private pending = new Map<number, Pending>()
  private eventWaiters = new Map<string, Array<(message: DapMessage) => void>>()
  private breakpoints = new Map<string, number[]>()
  private ended = false

  constructor(private readonly emit: (event: DebugEvent) => void) {}

  get active(): boolean {
    return this.adapter !== null && !this.ended
  }

  setPendingBreakpoints(path: string, lines: number[]): void {
    if (lines.length) this.breakpoints.set(path, [...lines])
    else this.breakpoints.delete(path)
  }

  async start(config: DebugLaunchConfig, env: NodeJS.ProcessEnv): Promise<void> {
    if (!config.program) throw new Error('Choose a program to debug first')
    await access(config.program).catch(() => {
      throw new Error(`Program not found: ${config.program}. Build it first.`)
    })
    const adapterPath = await findLldbDap()
    this.emit({ type: 'state', state: 'starting' })
    const adapter = spawn(adapterPath, [], { stdio: ['pipe', 'pipe', 'pipe'], env })
    this.adapter = adapter
    adapter.stdout?.on('data', (chunk: Buffer) => {
      for (const message of this.reader.push(chunk)) this.handle(message)
    })
    adapter.stderr?.on('data', (chunk: Buffer) => this.emit({ type: 'output', category: 'stderr', text: chunk.toString('utf8') }))
    adapter.on('error', (error) => this.fail(error.message))
    adapter.on('exit', () => this.finish())

    await this.request('initialize', {
      clientID: 'codemap',
      clientName: 'Codemap',
      adapterID: 'lldb-dap',
      locale: 'en-US',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
      supportsRunInTerminalRequest: false
    })
    const initialized = this.waitForEvent('initialized')
    const launch = this.request('launch', {
      program: config.program,
      args: config.args,
      cwd: config.cwd || undefined,
      stopOnEntry: config.stopOnEntry,
      env: [] as string[]
    })
    await Promise.race([initialized, launch.then(() => initialized)])
    for (const [path, lines] of this.breakpoints) {
      await this.sendBreakpoints(path, lines)
    }
    await this.request('configurationDone')
    await launch
    if (!this.ended) this.emit({ type: 'state', state: 'running' })
  }

  private handle(message: DapMessage): void {
    if (message.type === 'response' && message.request_seq !== undefined) {
      const pending = this.pending.get(message.request_seq)
      if (!pending) return
      this.pending.delete(message.request_seq)
      if (message.success) pending.resolve(message)
      else pending.reject(new Error(message.message || message.body?.error?.format || `${message.command} failed`))
      return
    }
    if (message.type !== 'event' || !message.event) return
    const waiters = this.eventWaiters.get(message.event)
    if (waiters?.length) {
      this.eventWaiters.delete(message.event)
      for (const waiter of waiters) waiter(message)
    }
    switch (message.event) {
      case 'stopped':
        this.emit({
          type: 'state',
          state: 'stopped',
          reason: message.body?.reason,
          threadId: message.body?.threadId,
          description: message.body?.description
        })
        break
      case 'continued':
        this.emit({ type: 'state', state: 'running' })
        break
      case 'output': {
        const category = message.body?.category ?? 'console'
        if (category !== 'telemetry') this.emit({ type: 'output', category, text: message.body?.output ?? '' })
        break
      }
      case 'exited':
        this.emit({ type: 'output', category: 'console', text: `Process exited with code ${message.body?.exitCode ?? '?'}\n` })
        break
      case 'terminated':
        void this.stop()
        break
      case 'breakpoint':
        break
    }
  }

  private request(command: string, args?: object, timeoutMs = 30000): Promise<DapMessage> {
    if (!this.adapter?.stdin || this.ended) return Promise.reject(new Error('Debugger is not running'))
    const seq = this.seq++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`${command} timed out`))
      }, timeoutMs)
      this.pending.set(seq, {
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.adapter?.stdin?.write(encodeMessage({ seq, type: 'request', command, arguments: args }))
    })
  }

  private waitForEvent(name: string): Promise<DapMessage> {
    return new Promise((resolve) => {
      const list = this.eventWaiters.get(name) ?? []
      list.push(resolve)
      this.eventWaiters.set(name, list)
    })
  }

  private async sendBreakpoints(path: string, lines: number[]): Promise<DebugBreakpoint[]> {
    const response = await this.request('setBreakpoints', {
      source: { path },
      breakpoints: lines.map((line) => ({ line })),
      sourceModified: false
    })
    const result: DebugBreakpoint[] = (response.body?.breakpoints ?? []).map((bp: any, index: number) => ({
      path,
      line: bp.line ?? lines[index],
      verified: Boolean(bp.verified)
    }))
    this.emit({ type: 'breakpoints', breakpoints: result })
    return result
  }

  async setBreakpoints(path: string, lines: number[]): Promise<DebugBreakpoint[]> {
    this.setPendingBreakpoints(path, lines)
    if (!this.active) return lines.map((line) => ({ path, line }))
    return this.sendBreakpoints(path, lines)
  }

  async threads(): Promise<DebugThread[]> {
    const response = await this.request('threads')
    return (response.body?.threads ?? []).map((thread: any) => ({ id: thread.id, name: thread.name }))
  }

  async stackTrace(threadId: number): Promise<StackFrame[]> {
    const response = await this.request('stackTrace', { threadId, startFrame: 0, levels: 200 })
    return (response.body?.stackFrames ?? []).map((frame: any) => ({
      id: frame.id,
      name: frame.name,
      path: frame.source?.path ?? null,
      line: frame.line ?? 0,
      column: frame.column ?? 0,
      presentationHint: frame.presentationHint
    }))
  }

  async scopes(frameId: number): Promise<DebugScope[]> {
    const response = await this.request('scopes', { frameId })
    return (response.body?.scopes ?? []).map((scope: any) => ({
      name: scope.name,
      variablesReference: scope.variablesReference,
      expensive: Boolean(scope.expensive)
    }))
  }

  async variables(variablesReference: number): Promise<DebugVariable[]> {
    const response = await this.request('variables', { variablesReference })
    return (response.body?.variables ?? []).map((variable: any) => ({
      name: variable.name,
      value: variable.value,
      type: variable.type,
      variablesReference: variable.variablesReference ?? 0
    }))
  }

  async evaluate(expression: string, frameId: number | null): Promise<string> {
    const response = await this.request('evaluate', { expression, frameId: frameId ?? undefined, context: 'repl' })
    return response.body?.result ?? ''
  }

  async control(command: 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut', threadId: number): Promise<void> {
    if (command !== 'pause') this.emit({ type: 'state', state: 'running' })
    await this.request(command, { threadId })
  }

  async stop(): Promise<void> {
    if (!this.adapter || this.ended) return
    try {
      await this.request('disconnect', { terminateDebuggee: true }, 3000)
    } catch {
      /* adapter may already be gone */
    }
    this.adapter?.kill()
    this.finish()
  }

  private fail(message: string): void {
    this.emit({ type: 'error', message })
    this.finish()
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true
    for (const pending of this.pending.values()) pending.reject(new Error('Debug session ended'))
    this.pending.clear()
    this.eventWaiters.clear()
    this.adapter = null
    this.emit({ type: 'state', state: 'terminated' })
  }
}
