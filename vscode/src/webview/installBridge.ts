import type { CodemapApi, Unsubscribe } from '../../../src/shared/api'
import type { HostEvent, HostRequest, HostResponse } from '../host/protocol'
import type { NavigationSnapshot } from '../host/session'
import { getActiveTab } from '../../../src/renderer/src/services/documents'
import { getState } from '../../../src/renderer/src/state/store'

type VsCodeApi = {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
const listeners = new Map<string, Set<(payload: unknown) => void>>()
let vscodeApi: VsCodeApi | null = null

function api(): VsCodeApi {
  vscodeApi ??= acquireVsCodeApi()
  return vscodeApi
}

function request<T>(channel: string, args: unknown[] = []): Promise<T> {
  const requestId = crypto.randomUUID()
  const message: HostRequest = { type: 'request', requestId, channel, args }
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, { resolve: (value) => resolve(value as T), reject })
    api().postMessage(message)
  })
}

export { request }

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const set = listeners.get(channel) ?? new Set()
  const wrapped = (payload: unknown) => listener(payload as T)
  set.add(wrapped)
  listeners.set(channel, set)
  return () => set.delete(wrapped)
}

function unavailable(name: string): Promise<never> {
  return Promise.reject(new Error(`${name} is not available in the VS Code extension`))
}

export function installVscodeCodemapBridge(): void {
  const codemap: CodemapApi = {
    app: {
      info: () => request('app:info'),
      state: () => request('app:state'),
      setTheme: (theme) => request('app:setTheme', [theme]),
      setLocale: (locale) => request('app:setLocale', [locale]),
      setDirtyCount: (count) => {
        void request('app:setDirtyCount', [count])
      },
      confirm: (options) => request('app:confirm', [options]),
      popupMenu: (items) => popupMenu(items),
      onMenuCommand: (listener) => subscribe('menu:command', listener)
    },
    workspace: {
      openDialog: () => request('workspace:openDialog'),
      open: () => unavailable('workspace.open'),
      close: () => unavailable('workspace.close'),
      getSettings: () => request('workspace:getSettings'),
      saveSettings: (settings) => request('workspace:saveSettings', [settings]),
      pickFile: () => request('workspace:pickFile')
    },
    fs: {
      list: (dir) => request('fs:list', [dir]),
      read: (file) => request('fs:read', [file]),
      readExternal: (file) => request('fs:readExternal', [file]),
      write: (file, content) => request('fs:write', [file, content]),
      create: (parent, name, kind) => request('fs:create', [parent, name, kind]),
      rename: (from, newName) => request('fs:rename', [from, newName]),
      trash: (target) => request('fs:trash', [target]),
      reveal: (target) => request('fs:reveal', [target]),
      transfer: (sources, targetDir, mode) => request('fs:transfer', [sources, targetDir, mode]),
      duplicate: (target) => request('fs:duplicate', [target]),
      readClipboardFiles: async () => [],
      writeClipboardFiles: async () => undefined,
      pathForFile: () => '',
      listFiles: (limit) => request('fs:listFiles', [limit]),
      mapIndex: () => request('fs:mapIndex'),
      onChange: (listener) => subscribe('fs:changed', listener)
    },
    search: {
      run: async () => null,
      cancel: async () => undefined,
      replace: async () => ({ files: 0, replaced: 0, failed: [] })
    },
    tasks: {
      run: () => unavailable('tasks.run'),
      stop: async () => undefined,
      onOutput: () => () => undefined,
      onExit: () => () => undefined
    },
    terminal: {
      create: () => unavailable('terminal.create'),
      write: () => undefined,
      resize: () => undefined,
      kill: async () => undefined,
      onData: () => () => undefined,
      onExit: () => () => undefined
    },
    git: {
      status: () => request('git:status'),
      init: async () => undefined,
      stage: async () => undefined,
      unstage: async () => undefined,
      discard: async () => undefined,
      commit: async () => undefined,
      branches: async () => [],
      checkout: async () => undefined,
      log: async () => [],
      diff: () => unavailable('git.diff'),
      show: async () => '',
      pull: async () => '',
      push: async () => ''
    },
    debug: {
      start: async () => undefined,
      stop: async () => undefined,
      continue: async () => undefined,
      pause: async () => undefined,
      next: async () => undefined,
      stepIn: async () => undefined,
      stepOut: async () => undefined,
      setBreakpoints: async () => [],
      threads: async () => [],
      stackTrace: async () => [],
      scopes: async () => [],
      variables: async () => [],
      evaluate: async () => '',
      onEvent: () => () => undefined
    },
    plugins: {
      list: async () => [],
      setEnabled: async () => undefined,
      openFolder: async () => undefined,
      fetch: () => unavailable('plugins.fetch')
    },
    lsp: {
      open: (file, languageId, text) => request('lsp:open', [file, languageId, text]),
      change: (file, text) => {
        void request('lsp:change', [file, text])
      },
      save: (file) => request('lsp:save', [file]),
      close: (file) => request('lsp:close', [file]),
      navigate: (kind, file, line, column) => request('lsp:navigate', [kind, file, line, column]),
      hover: (file, line, column) => request('lsp:hover', [file, line, column]),
      symbols: (file) => request('lsp:symbols', [file]),
      status: () => request('lsp:status'),
      restart: () => request('lsp:restart'),
      onStatus: () => () => undefined,
      onLog: () => () => undefined
    },
    codemap: {
      load: () => request('codemap:load'),
      chooseLibrary: () => request('codemap:chooseLibrary'),
      createLibrary: () => request('codemap:createLibrary'),
      useLibrary: (library) => request('codemap:useLibrary', [library]),
      pickRepository: () => request('codemap:pickRepository'),
      writeLayout: (file, patch) => request('codemap:writeLayout', [file, patch]),
      writeNode: (file, patch) => request('codemap:writeNode', [file, patch]),
      read: (target) => request('codemap:read', [target]),
      requestAccess: (folder, reason) => request('codemap:requestAccess', [folder, reason]),
      grants: () => request('codemap:grants'),
      revoke: (folder) => request('codemap:revoke', [folder]),
      onChange: (listener) => subscribe('codemap:changed', () => listener())
    },
    agent: {
      settings: () => request('agent:settings'),
      saveSettings: (settings) => request('agent:saveSettings', [settings]),
      setKey: (providerId, key) => request('agent:setKey', [providerId, key]),
      models: (providerId) => request('agent:models', [providerId]),
      start: (req) => request('agent:start', [req]),
      stop: (sessionId) => request('agent:stop', [sessionId]),
      sessions: () => request('agent:sessions'),
      session: (id) => request('agent:session', [id]),
      deleteSession: (id) => request('agent:deleteSession', [id]),
      applyChangeSet: (sessionId, changeSetId) => request('agent:applyChangeSet', [sessionId, changeSetId]),
      rejectChangeSet: (sessionId, changeSetId) => request('agent:rejectChangeSet', [sessionId, changeSetId]),
      knowledgeDir: () => request('agent:knowledgeDir'),
      pickRepos: () => request('agent:pickRepos'),
      pickDocs: () => request('agent:pickDocs'),
      onEvent: (listener) => subscribe('agent:event', listener)
    }
  }
  window.codemap = codemap
  ;(window as unknown as { lumen?: CodemapApi }).lumen = codemap
  window.addEventListener('message', (event: MessageEvent<HostResponse | HostEvent>) => {
    const message = event.data
    if (!message || typeof message !== 'object') return
    if (message.type === 'response') {
      const waiter = pending.get(message.requestId)
      if (!waiter) return
      pending.delete(message.requestId)
      if (message.ok) waiter.resolve(message.value)
      else waiter.reject(new Error(message.error ?? 'Request failed'))
      return
    }
    if (message.type === 'event') {
      for (const listener of listeners.get(message.channel) ?? []) listener(message.payload)
    }
  })
  installExternalOpen()
}

let externalOpenInstalled = false

function installExternalOpen(): void {
  if (externalOpenInstalled || typeof window.open !== 'function') return
  externalOpenInstalled = true
  const nativeOpen = window.open.bind(window)
  window.open = ((url?: string | URL, target?: string, features?: string): Window | null => {
    const value = url == null ? '' : String(url)
    if (/^https?:\/\//i.test(value)) {
      void openExternalUrl(value)
      return null
    }
    return nativeOpen(url as string | URL | undefined, target, features)
  }) as typeof window.open
}

export const installVscodeLumenBridge = installVscodeCodemapBridge

async function popupMenu(items: Parameters<CodemapApi['app']['popupMenu']>[0]): Promise<string | null> {
  const menu = items.some((item) => item.id === 'finder') ? withVsCodeOpen(items) : items
  const choice = await request<string | null>('app:popupMenu', [menu])
  if (choice !== '__open_vscode__') return choice
  const tab = getActiveTab()
  if (tab?.kind === 'file' && tab.path) await openInVSCode(tab.path, getState().cursor?.line)
  return null
}

function withVsCodeOpen(items: Parameters<CodemapApi['app']['popupMenu']>[0]): Parameters<CodemapApi['app']['popupMenu']>[0] {
  const reveal = items.findIndex((item) => item.id === 'reveal')
  const action = {
    id: '__open_vscode__',
    label: items.length > 0 && singleFileMenu(items) ? 'Open in VS Code' : 'Open Active File in VS Code'
  }
  if (reveal < 0) return [...items, action]
  return [...items.slice(0, reveal), action, ...items.slice(reveal)]
}

function singleFileMenu(items: Parameters<CodemapApi['app']['popupMenu']>[0]): boolean {
  const others = items.find((item) => item.id === 'others')
  return others?.enabled !== true
}

export function getWebviewPersistedState<T>(): T | undefined {
  return api().getState() as T | undefined
}

export function setWebviewPersistedState<T>(state: T): void {
  api().setState(state)
}

export function onHostMode(listener: (mode: 'map' | 'codemap') => void): Unsubscribe {
  return subscribe('host:mode', (payload) => {
    const mode = (payload as { mode?: 'map' | 'codemap' } | undefined)?.mode
    if (mode === 'map' || mode === 'codemap') listener(mode)
  })
}

export function onHostRevealProject(listener: (payload: { path: string }) => void): Unsubscribe {
  return subscribe('host:revealProject', (payload) => listener(payload as { path: string }))
}

export function onHostReveal(listener: (payload: { path: string; line: number }) => void): Unsubscribe {
  return subscribe('host:revealCode', listener)
}

export function onHostCursor(listener: (payload: { path: string; line: number }) => void): Unsubscribe {
  return subscribe('host:cursor', listener)
}

export function onHostSnapshot(listener: (snapshot: NavigationSnapshot) => void): Unsubscribe {
  return subscribe('host:snapshot', (payload) => listener(payload as NavigationSnapshot))
}

export function onHostWorkspace(listener: (payload: { root: string; name: string }) => void): Unsubscribe {
  return subscribe('host:workspace', listener)
}

export function onHostSidebarSide(listener: (side: 'left' | 'right') => void): Unsubscribe {
  return subscribe('host:sidebarSide', (payload) => {
    const side = (payload as { side?: string } | undefined)?.side
    if (side === 'left' || side === 'right') listener(side)
  })
}

export function openExternalUrl(url: string): Promise<void> {
  return request('openExternalUrl', [url])
}

export function openInVSCode(file: string, line?: number, beside = false): Promise<void> {
  return request('host:openInVSCode', [file, line ?? 1, beside])
}
