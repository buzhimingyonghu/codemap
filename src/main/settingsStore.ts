import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { isLocale, localeFrom, type Locale } from '../shared/i18n'
import type { WorkspaceSettings } from '../shared/types'

interface AppState {
  recentFolders: string[]
  lastFolder: string | null
  theme: string
  locale: Locale | null
  disabledPlugins: string[]
  workspaces: Record<string, Partial<WorkspaceSettings>>
  /** Code map node library chosen per workspace root (absolute paths). */
  codemapLibraries: Record<string, string>
  /** Folders outside the open folder that the user allowed the code map to read. */
  codemapGrants: string[]
}

const DEFAULT_STATE: AppState = {
  recentFolders: [],
  lastFolder: null,
  theme: 'graphite',
  locale: null,
  disabledPlugins: [],
  workspaces: {},
  codemapLibraries: {},
  codemapGrants: []
}

let state: AppState | null = null
let writeChain: Promise<void> = Promise.resolve()

function statePath(): string {
  return path.join(app.getPath('userData'), 'state.json')
}

async function load(): Promise<AppState> {
  if (state) return state
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8')) as Partial<AppState>
    state = {
      ...DEFAULT_STATE,
      ...parsed,
      workspaces: { ...(parsed.workspaces ?? {}) },
      codemapLibraries: { ...(parsed.codemapLibraries ?? {}) },
      codemapGrants: Array.isArray(parsed.codemapGrants) ? parsed.codemapGrants.filter((entry) => typeof entry === 'string') : []
    }
  } catch {
    state = structuredClone(DEFAULT_STATE)
  }
  return state
}

function persist(): Promise<void> {
  const snapshot = JSON.stringify(state, null, 2)
  writeChain = writeChain
    .then(async () => {
      await mkdir(path.dirname(statePath()), { recursive: true })
      await writeFile(statePath(), snapshot, 'utf8')
    })
    .catch(() => undefined)
  return writeChain
}

export async function getAppState(): Promise<AppState> {
  return structuredClone(await load())
}

export async function rememberFolder(folder: string): Promise<string[]> {
  const current = await load()
  current.recentFolders = [folder, ...current.recentFolders.filter((entry) => entry !== folder)].slice(0, 10)
  current.lastFolder = folder
  await persist()
  return [...current.recentFolders]
}

export async function forgetLastFolder(): Promise<void> {
  const current = await load()
  current.lastFolder = null
  await persist()
}

export async function setTheme(theme: string): Promise<void> {
  const current = await load()
  current.theme = theme
  await persist()
}

/** The UI language: the user's choice, or the system language until they choose. */
export async function getLocale(): Promise<Locale> {
  const current = await load()
  if (isLocale(current.locale)) return current.locale
  // End-to-end tests assert on English UI text, so they run in English unless they pick one.
  if (process.env.CODEMAP_E2E === '1') return 'en'
  return localeFrom(app.getLocale())
}

export async function setLocale(locale: Locale): Promise<void> {
  const current = await load()
  current.locale = locale
  await persist()
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  const current = await load()
  const disabled = new Set(current.disabledPlugins)
  if (enabled) disabled.delete(id)
  else disabled.add(id)
  current.disabledPlugins = [...disabled]
  await persist()
}

export async function getCodemapLibrary(root: string): Promise<string | null> {
  return (await load()).codemapLibraries[root] ?? null
}

export async function setCodemapLibrary(root: string, library: string | null): Promise<void> {
  const current = await load()
  if (library) current.codemapLibraries[root] = library
  else delete current.codemapLibraries[root]
  await persist()
}

export async function getCodemapGrants(): Promise<string[]> {
  return [...(await load()).codemapGrants]
}

export async function setCodemapGrants(grants: string[]): Promise<void> {
  const current = await load()
  current.codemapGrants = [...new Set(grants)].sort()
  await persist()
}

export function defaultWorkspaceSettings(root: string): WorkspaceSettings {
  return {
    buildCommand: '',
    debug: { program: '', args: [], cwd: root, stopOnEntry: false, preLaunchBuild: true }
  }
}

export async function getWorkspaceSettings(root: string): Promise<WorkspaceSettings> {
  const current = await load()
  const saved = current.workspaces[root] ?? {}
  const defaults = defaultWorkspaceSettings(root)
  return {
    buildCommand: saved.buildCommand ?? defaults.buildCommand,
    debug: { ...defaults.debug, ...(saved.debug ?? {}) }
  }
}

export async function saveWorkspaceSettings(root: string, settings: WorkspaceSettings): Promise<WorkspaceSettings> {
  const current = await load()
  current.workspaces[root] = settings
  await persist()
  return settings
}
