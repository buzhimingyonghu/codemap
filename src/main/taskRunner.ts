import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { TaskExit, TaskOutput } from '../shared/types'
import { getShellEnv } from './shellEnv'

interface RunningTask {
  child: ChildProcess
  startedAt: number
}

export class TaskRunner {
  private tasks = new Map<string, RunningTask>()

  constructor(
    private readonly onOutput: (output: TaskOutput) => void,
    private readonly onExit: (exit: TaskExit) => void
  ) {}

  async run(command: string, cwd: string): Promise<string> {
    const trimmed = command.trim()
    if (!trimmed) throw new Error('Build command is empty')
    const taskId = randomUUID()
    const env = await getShellEnv()
    const shellPath = env.SHELL || '/bin/zsh'
    const child = spawn(shellPath, ['-lc', trimmed], {
      cwd,
      env: { ...env, FORCE_COLOR: '0', CLICOLOR: '0', TERM: 'dumb' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const startedAt = Date.now()
    this.tasks.set(taskId, { child, startedAt })
    this.onOutput({ taskId, stream: 'system', text: `$ ${trimmed}\n` })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => this.onOutput({ taskId, stream: 'stdout', text }))
    child.stderr?.on('data', (text: string) => this.onOutput({ taskId, stream: 'stderr', text }))
    child.on('error', (error) => {
      this.onOutput({ taskId, stream: 'system', text: `${error.message}\n` })
    })
    child.on('close', (code, signal) => {
      this.tasks.delete(taskId)
      this.onExit({ taskId, code, signal, durationMs: Date.now() - startedAt })
    })
    return taskId
  }

  stop(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task?.child.pid) return
    try {
      // Negative pid targets the whole process group so compilers spawned by make/npm stop too.
      process.kill(-task.child.pid, 'SIGTERM')
    } catch {
      task.child.kill('SIGTERM')
    }
    const pid = task.child.pid
    setTimeout(() => {
      if (!this.tasks.has(taskId)) return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }, 3000)
  }

  stopAll(): void {
    for (const taskId of this.tasks.keys()) this.stop(taskId)
  }
}
