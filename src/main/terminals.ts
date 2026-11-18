import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import type { IPty } from 'node-pty'
import type { TerminalExit, TerminalInfo } from '../shared/types'
import { getShellEnv } from './shellEnv'

// Interactive shells for the bottom panel, one pseudo-terminal per session. Output is batched
// per animation-frame-sized window so a noisy command (`yes`, a big build) cannot flood IPC.

const FLUSH_MS = 8
const MAX_SESSIONS = 16
let nextId = 1

interface Session {
  id: string
  pty: IPty
  pending: string
  timer: NodeJS.Timeout | null
}

function loadPty(): typeof import('node-pty') {
  // Loaded lazily so a missing native module only breaks the terminal, not the whole app.
  // The main bundle is ESM, so native CommonJS modules come in through createRequire.
  return createRequire(import.meta.url)('node-pty') as typeof import('node-pty')
}

export function defaultShell(env: NodeJS.ProcessEnv): string {
  const candidates = [env.SHELL, os.userInfo().shell, '/bin/zsh', '/bin/bash', '/bin/sh']
  return candidates.find((shell): shell is string => Boolean(shell && existsSync(shell))) ?? '/bin/sh'
}

export class TerminalManager {
  private sessions = new Map<string, Session>()

  constructor(
    private readonly onData: (id: string, data: string) => void,
    private readonly onExit: (exit: TerminalExit) => void
  ) {}

  async create(cwd: string, cols: number, rows: number): Promise<TerminalInfo> {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`At most ${MAX_SESSIONS} terminals can be open`)
    const env = await getShellEnv()
    const shell = defaultShell(env)
    const id = `t${nextId++}`
    const pty = loadPty().spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: clampSize(cols, 80),
      rows: clampSize(rows, 24),
      cwd: existsSync(cwd) ? cwd : os.homedir(),
      env: {
        ...env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'Codemap',
        LANG: env.LANG || 'en_US.UTF-8'
      } as Record<string, string>
    })
    const session: Session = { id, pty, pending: '', timer: null }
    this.sessions.set(id, session)
    pty.onData((data) => {
      session.pending += data
      session.timer ??= setTimeout(() => this.flush(session), FLUSH_MS)
    })
    pty.onExit(({ exitCode, signal }) => {
      this.flush(session)
      this.sessions.delete(id)
      this.onExit({ id, code: exitCode, signal: signal ?? null })
    })
    return { id, shell, pid: pty.pid }
  }

  private flush(session: Session): void {
    if (session.timer) clearTimeout(session.timer)
    session.timer = null
    if (!session.pending) return
    const data = session.pending
    session.pending = ''
    this.onData(session.id, data)
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    try {
      session.pty.resize(clampSize(cols, 80), clampSize(rows, 24))
    } catch {
      // The process may exit between the size change and this call.
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    if (session.timer) clearTimeout(session.timer)
    try {
      session.pty.kill()
    } catch {
      // Already gone.
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}

function clampSize(value: number, fallback: number): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : fallback
}
