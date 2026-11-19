import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { IpcResult, CodemapApi, Unsubscribe } from '../shared/api'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.value
}

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api: CodemapApi = {
  app: {
    info: () => invoke('app:info'),
    state: () => invoke('app:state'),
    setTheme: (theme) => invoke('app:setTheme', theme),
    setLocale: (locale) => invoke('app:setLocale', locale),
    setDirtyCount: (count) => ipcRenderer.send('app:setDirtyCount', count),
    confirm: (options) => invoke('app:confirm', options),
    popupMenu: (items) => invoke('app:popupMenu', items),
    onMenuCommand: (listener) => subscribe('menu:command', listener)
  },
  workspace: {
    openDialog: () => invoke('workspace:openDialog'),
    open: (path) => invoke('workspace:open', path),
    close: () => invoke('workspace:close'),
    getSettings: () => invoke('workspace:getSettings'),
    saveSettings: (settings) => invoke('workspace:saveSettings', settings),
    pickFile: () => invoke('workspace:pickFile')
  },
  fs: {
    list: (dir) => invoke('fs:list', dir),
    read: (file) => invoke('fs:read', file),
    readExternal: (file) => invoke('fs:readExternal', file),
    write: (file, content) => invoke('fs:write', file, content),
    create: (parent, name, kind) => invoke('fs:create', parent, name, kind),
    rename: (from, newName) => invoke('fs:rename', from, newName),
    trash: (path) => invoke('fs:trash', path),
    reveal: (path) => invoke('fs:reveal', path),
    transfer: (sources, targetDir, mode) => invoke('fs:transfer', sources, targetDir, mode),
    duplicate: (path) => invoke('fs:duplicate', path),
    readClipboardFiles: () => invoke('fs:readClipboardFiles'),
    writeClipboardFiles: (paths) => invoke('fs:writeClipboardFiles', paths),
    // Files dropped from Finder only expose their real path through webUtils in the preload.
    pathForFile: (file) => webUtils.getPathForFile(file),
    listFiles: (limit) => invoke('fs:listFiles', limit),
    mapIndex: () => invoke('fs:mapIndex'),
    onChange: (listener) => subscribe('fs:changed', listener)
  },
  search: {
    run: (query, skip) => invoke('search:run', query, skip),
    cancel: () => invoke('search:cancel'),
    replace: (query, replacement, targets) => invoke('search:replace', query, replacement, targets)
  },
  tasks: {
    run: (command) => invoke('task:run', command),
    stop: (taskId) => invoke('task:stop', taskId),
    onOutput: (listener) => subscribe('task:output', listener),
    onExit: (listener) => subscribe('task:exit', listener)
  },
  terminal: {
    create: (cols, rows) => invoke('terminal:create', cols, rows),
    // Keystrokes and resizes are fire-and-forget: no round trip per key.
    write: (id, data) => ipcRenderer.send('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
    kill: (id) => invoke('terminal:kill', id),
    onData: (listener) => subscribe('terminal:data', listener),
    onExit: (listener) => subscribe('terminal:exit', listener)
  },
  git: {
    status: () => invoke('git:status'),
    init: () => invoke('git:init'),
    stage: (paths) => invoke('git:stage', paths),
    unstage: (paths) => invoke('git:unstage', paths),
    discard: (paths) => invoke('git:discard', paths),
    commit: (message, amend) => invoke('git:commit', message, amend),
    branches: () => invoke('git:branches'),
    checkout: (name, create) => invoke('git:checkout', name, create),
    log: (limit) => invoke('git:log', limit),
    diff: (path, staged) => invoke('git:diff', path, staged),
    show: (hash) => invoke('git:show', hash),
    pull: () => invoke('git:pull'),
    push: () => invoke('git:push')
  },
  debug: {
    start: (config) => invoke('debug:start', config),
    stop: () => invoke('debug:stop'),
    continue: (threadId) => invoke('debug:continue', threadId),
    pause: (threadId) => invoke('debug:pause', threadId),
    next: (threadId) => invoke('debug:next', threadId),
    stepIn: (threadId) => invoke('debug:stepIn', threadId),
    stepOut: (threadId) => invoke('debug:stepOut', threadId),
    setBreakpoints: (path, lines) => invoke('debug:setBreakpoints', path, lines),
    threads: () => invoke('debug:threads'),
    stackTrace: (threadId) => invoke('debug:stackTrace', threadId),
    scopes: (frameId) => invoke('debug:scopes', frameId),
    variables: (reference) => invoke('debug:variables', reference),
    evaluate: (expression, frameId) => invoke('debug:evaluate', expression, frameId),
    onEvent: (listener) => subscribe('debug:event', listener)
  },
  plugins: {
    list: () => invoke('plugins:list'),
    setEnabled: (id, enabled) => invoke('plugins:setEnabled', id, enabled),
    openFolder: () => invoke('plugins:openFolder'),
    fetch: (pluginId, url, init) => invoke('plugins:fetch', pluginId, url, init)
  },
  lsp: {
    open: (path, languageId, text) => invoke('lsp:open', path, languageId, text),
    change: (path, text) => ipcRenderer.send('lsp:change', path, text),
    save: (path) => invoke('lsp:save', path),
    close: (path) => invoke('lsp:close', path),
    navigate: (kind, path, line, column) => invoke('lsp:navigate', kind, path, line, column),
    hover: (path, line, column) => invoke('lsp:hover', path, line, column),
    symbols: (path) => invoke('lsp:symbols', path),
    status: () => invoke('lsp:status'),
    restart: (serverId) => invoke('lsp:restart', serverId),
    onStatus: (listener) => subscribe('lsp:status', () => listener()),
    onLog: (listener) => subscribe('lsp:log', listener)
  },
  codemap: {
    load: () => invoke('codemap:load'),
    chooseLibrary: () => invoke('codemap:chooseLibrary'),
    useLibrary: (path) => invoke('codemap:useLibrary', path),
    createLibrary: () => invoke('codemap:createLibrary'),
    pickRepository: () => invoke('codemap:pickRepository'),
    writeLayout: (file, patch) => invoke('codemap:writeLayout', file, patch),
    writeNode: (file, patch) => invoke('codemap:writeNode', file, patch),
    read: (path) => invoke('codemap:read', path),
    requestAccess: (folder, reason) => invoke('codemap:requestAccess', folder, reason),
    grants: () => invoke('codemap:grants'),
    revoke: (folder) => invoke('codemap:revoke', folder),
    onChange: (listener) => subscribe('codemap:changed', () => listener())
  },
  agent: {
    settings: () => invoke('agent:settings'),
    saveSettings: (settings) => invoke('agent:saveSettings', settings),
    setKey: (providerId, key) => invoke('agent:setKey', providerId, key),
    models: (providerId) => invoke('agent:models', providerId),
    testConnection: (providerId, model) => invoke('agent:testConnection', providerId ?? null, model),
    start: (request) => invoke('agent:start', request),
    stop: (sessionId) => invoke('agent:stop', sessionId),
    sessions: () => invoke('agent:sessions'),
    session: (id) => invoke('agent:session', id),
    deleteSession: (id) => invoke('agent:deleteSession', id),
    applyChangeSet: (sessionId, changeSetId) => invoke('agent:applyChangeSet', sessionId, changeSetId),
    rejectChangeSet: (sessionId, changeSetId) => invoke('agent:rejectChangeSet', sessionId, changeSetId),
    knowledgeDir: () => invoke('agent:knowledgeDir'),
    pickRepos: () => invoke('agent:pickRepos'),
    pickDocs: () => invoke('agent:pickDocs'),
    onEvent: (listener) => subscribe('agent:event', listener)
  }
}

contextBridge.exposeInMainWorld('codemap', api)
