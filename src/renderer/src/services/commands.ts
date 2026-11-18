import type { Disposable } from '../lib/events'
import { getState, setState } from '../state/store'
import { reportError } from './ui'

export interface CommandMeta {
  title: string
  category?: string
  keybinding?: string
  source?: string
  hidden?: boolean
}

export interface CommandEntry extends CommandMeta {
  id: string
  run: (...args: any[]) => unknown
}

const commands = new Map<string, CommandEntry>()

function bump(): void {
  setState({ registryVersion: getState().registryVersion + 1 })
}

export function registerCommand(id: string, run: CommandEntry['run'], meta: CommandMeta): Disposable {
  commands.set(id, { id, run, ...meta })
  bump()
  return {
    dispose: () => {
      if (commands.get(id)?.run === run) {
        commands.delete(id)
        bump()
      }
    }
  }
}

export async function executeCommand<T = unknown>(id: string, ...args: any[]): Promise<T | undefined> {
  const command = commands.get(id)
  if (!command) throw new Error(`Unknown command: ${id}`)
  try {
    return (await command.run(...args)) as T
  } catch (error) {
    reportError(error)
    return undefined
  }
}

export function hasCommand(id: string): boolean {
  return commands.has(id)
}

export function listCommands(): CommandEntry[] {
  return [...commands.values()].filter((command) => !command.hidden)
}
