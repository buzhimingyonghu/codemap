import type { PluginDescriptor } from '@shared/types'
import { getTheme } from '../editor/themes'
import { Emitter, type Disposable } from '../lib/events'
import { executeCommand, registerCommand } from '../services/commands'
import {
  getActiveEditor,
  getActiveTab,
  getDocumentText,
  onDidChangeActive,
  onDidSave,
  openFile
} from '../services/documents'
import { notify, prompt } from '../services/ui'
import { registerView, showView } from '../services/views'
import { onDidChangeFiles, onDidOpenWorkspace } from '../services/workspace'
import { getState, setState, type PluginRuntime } from '../state/store'
import type { PluginContext, PluginModule } from './api'
import { getService, onServiceRegistered, provideService } from './services'

interface ActivePlugin {
  module: PluginModule
  context: PluginContext
}

const active = new Map<string, ActivePlugin>()
export const onDidChangeTheme = new Emitter<{ id: string; appearance: 'dark' | 'light' }>()

function track<T extends Disposable>(ctx: PluginContext, disposable: T): T {
  ctx.subscriptions.push(disposable)
  return disposable
}

function createContext(descriptor: PluginDescriptor): PluginContext {
  const { manifest } = descriptor
  const storageKey = `plugin:${manifest.id}`
  const scoped = (id: string) => (id.includes('.') ? id : `${manifest.id}.${id}`)
  const ctx: PluginContext = {
    id: manifest.id,
    version: manifest.version,
    subscriptions: [],
    commands: {
      register: (id, run, meta) => {
        const fullId = scoped(id)
        const declared = manifest.contributes?.commands?.find((command) => command.id === fullId || command.id === id)
        return track(
          ctx,
          registerCommand(fullId, run, {
            title: meta?.title ?? declared?.title ?? fullId,
            keybinding: meta?.keybinding ?? declared?.keybinding,
            category: manifest.name,
            source: manifest.id
          })
        )
      },
      execute: (id, ...args) => executeCommand(id, ...args)
    },
    views: {
      register: (id, options) =>
        track(
          ctx,
          registerView({
            id: scoped(id),
            title: options.title,
            location: options.location,
            icon: options.icon ?? 'puzzle',
            source: manifest.id,
            mount: options.mount,
            order: 200
          })
        ),
      show: (id) => showView(scoped(id))
    },
    workspace: {
      get current() {
        return getState().workspace
      },
      readFile: (path) => window.codemap.fs.read(path),
      writeFile: (path, content) => window.codemap.fs.write(path, content),
      list: (dir) => window.codemap.fs.list(dir),
      findFiles: (limit) => window.codemap.fs.listFiles(limit),
      onDidOpen: (listener) => track(ctx, onDidOpenWorkspace.on(listener)),
      onDidChangeFiles: (listener) => track(ctx, onDidChangeFiles.on(listener))
    },
    editor: {
      get activePath() {
        const tab = getActiveTab()
        return tab?.kind === 'file' ? (tab.path ?? null) : null
      },
      getText: (path) => {
        const target = path ?? ctx.editor.activePath
        return target ? getDocumentText(target) : null
      },
      getSelection: () => {
        const editor = getActiveEditor()
        const model = editor?.getModel()
        const selection = editor?.getSelection()
        if (!editor || !model || !selection) return null
        return {
          path: model.uri.path,
          text: model.getValueInRange(selection),
          startLine: selection.startLineNumber,
          endLine: selection.endLineNumber
        }
      },
      open: (path, line) => openFile(path, line ? { line } : undefined),
      insertText: (text) => {
        const editor = getActiveEditor()
        const selection = editor?.getSelection()
        if (!editor || !selection) return
        editor.executeEdits(manifest.id, [{ range: selection, text, forceMoveMarkers: true }])
        editor.focus()
      },
      onDidChangeActive: (listener) => track(ctx, onDidChangeActive.on(listener)),
      onDidSave: (listener) => track(ctx, onDidSave.on(listener))
    },
    git: {
      status: () => window.codemap.git.status()
    },
    ui: {
      notify: (message, kind) => notify(message, kind),
      prompt: (title, options) => prompt(title, options),
      get theme() {
        const theme = getTheme(getState().theme)
        return { id: theme.id, appearance: theme.appearance }
      },
      onDidChangeTheme: (listener) => track(ctx, onDidChangeTheme.on(listener))
    },
    services: {
      provide: (name, implementation) => track(ctx, provideService(name, implementation)),
      get: (name) => getService(name),
      onDidRegister: (name, listener) => track(ctx, onServiceRegistered(name, listener))
    },
    storage: {
      get: (key, fallback) => {
        try {
          const raw = localStorage.getItem(`${storageKey}:${key}`)
          return raw === null ? fallback : JSON.parse(raw)
        } catch {
          return fallback
        }
      },
      set: (key, value) => localStorage.setItem(`${storageKey}:${key}`, JSON.stringify(value))
    },
    net: {
      fetch: (url, init) => window.codemap.plugins.fetch(manifest.id, url, init)
    }
  }
  return ctx
}

function updateRuntime(id: string, patch: Partial<PluginRuntime>): void {
  setState({
    plugins: getState().plugins.map((runtime) => (runtime.descriptor.manifest.id === id ? { ...runtime, ...patch } : runtime))
  })
}

async function activate(descriptor: PluginDescriptor): Promise<void> {
  const id = descriptor.manifest.id
  if (active.has(id) || !descriptor.rendererUrl) return
  try {
    const module = (await import(/* @vite-ignore */ `${descriptor.rendererUrl}?t=${Date.now()}`)) as PluginModule
    if (typeof module.activate !== 'function') throw new Error('Plugin entry must export activate(ctx)')
    const context = createContext(descriptor)
    active.set(id, { module, context })
    await module.activate(context)
    updateRuntime(id, { active: true, error: undefined })
  } catch (error) {
    await deactivate(id)
    updateRuntime(id, { active: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function deactivate(id: string): Promise<void> {
  const plugin = active.get(id)
  if (!plugin) return
  active.delete(id)
  try {
    await plugin.module.deactivate?.()
  } catch (error) {
    console.warn(error)
  }
  for (const disposable of plugin.context.subscriptions.splice(0)) {
    try {
      disposable.dispose()
    } catch (error) {
      console.warn(error)
    }
  }
  updateRuntime(id, { active: false })
}

export async function loadPlugins(): Promise<void> {
  let descriptors: PluginDescriptor[] = []
  try {
    descriptors = await window.codemap.plugins.list()
  } catch (error) {
    console.warn(error)
  }
  for (const id of [...active.keys()]) await deactivate(id)
  setState({
    plugins: descriptors.map((descriptor) => ({ descriptor, active: false, error: descriptor.error }))
  })
  for (const descriptor of descriptors) {
    if (descriptor.enabled && !descriptor.error) await activate(descriptor)
  }
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  await window.codemap.plugins.setEnabled(id, enabled)
  await loadPlugins()
}
