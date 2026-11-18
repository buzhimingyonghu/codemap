import type { DirEntry, GitStatus, PluginFetchInit, PluginFetchResponse, WorkspaceInfo } from '@shared/types'
import type { Disposable } from '../lib/events'

// This is the contract plugins compile against. It is intentionally small and
// stable; built-in features use the same calls, which keeps it honest.
export interface PluginContext {
  readonly id: string
  readonly version: string
  readonly subscriptions: Disposable[]

  commands: {
    register(id: string, run: (...args: any[]) => unknown, meta?: { title?: string; keybinding?: string }): Disposable
    execute<T = unknown>(id: string, ...args: any[]): Promise<T | undefined>
  }

  views: {
    register(
      id: string,
      options: {
        title: string
        location: 'sidebar' | 'panel'
        icon?: string
        mount: (element: HTMLElement) => void | (() => void) | Disposable
      }
    ): Disposable
    show(id: string): void
  }

  workspace: {
    readonly current: WorkspaceInfo | null
    readFile(path: string): Promise<string>
    writeFile(path: string, content: string): Promise<void>
    list(dir: string): Promise<DirEntry[]>
    findFiles(limit?: number): Promise<string[]>
    onDidOpen(listener: (info: WorkspaceInfo) => void): Disposable
    onDidChangeFiles(listener: (paths: string[]) => void): Disposable
  }

  editor: {
    readonly activePath: string | null
    getText(path?: string): string | null
    getSelection(): { path: string; text: string; startLine: number; endLine: number } | null
    open(path: string, line?: number): Promise<void>
    insertText(text: string): void
    onDidChangeActive(listener: (path: string | null) => void): Disposable
    onDidSave(listener: (path: string) => void): Disposable
  }

  git: {
    status(): Promise<GitStatus>
  }

  ui: {
    notify(message: string, kind?: 'info' | 'success' | 'warning' | 'error'): void
    prompt(title: string, options?: { placeholder?: string; value?: string }): Promise<string | null>
    readonly theme: { id: string; appearance: 'dark' | 'light' }
    onDidChangeTheme(listener: (theme: { id: string; appearance: 'dark' | 'light' }) => void): Disposable
  }

  // Services let plugins cooperate without importing each other, e.g. an `ai` plugin
  // registers a service that a diagram plugin consumes.
  services: {
    provide<T extends object>(name: string, implementation: T): Disposable
    get<T>(name: string): T | undefined
    onDidRegister(name: string, listener: (implementation: unknown) => void): Disposable
  }

  storage: {
    get<T>(key: string, fallback: T): T
    set(key: string, value: unknown): void
  }

  // Only URLs allowed by `permissions.network` in plugin.json are reachable.
  net: {
    fetch(url: string, init?: PluginFetchInit): Promise<PluginFetchResponse>
  }
}

export interface PluginModule {
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
