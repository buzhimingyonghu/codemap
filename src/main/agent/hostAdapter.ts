import { createRequire } from 'node:module'
import path from 'node:path'
import type { AgentSettings } from '../../shared/agent'

// Host boundary for the agent runtime. Electron and a VS Code extension each install an
// adapter; nothing under src/main/agent imports electron while the module is evaluated.

export interface AgentHostAdapter {
  userDataDir(): string
  knowledgeDir(): string
  getSecret?(providerId: string): Promise<string | null>
  setSecret?(providerId: string, secret: string | null): Promise<void>
  hasSecret?(providerId: string): Promise<boolean>
  loadSettingsOverride?(): Promise<Partial<AgentSettings> | null> | Partial<AgentSettings> | null
  saveSettingsOverride?(settings: AgentSettings): Promise<void> | void
}

interface ElectronApp {
  isPackaged: boolean
  getAppPath(): string
  getPath(name: string): string
}

interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

interface ElectronModule {
  app: ElectronApp
  safeStorage: ElectronSafeStorage
}

let adapter: AgentHostAdapter | null = null
let cachedElectron: ElectronModule | null = null
let electronPromise: Promise<ElectronModule | null> | null = null

export function configureAgentHost(next: AgentHostAdapter | null): void {
  adapter = next
}

export function getAgentHost(): AgentHostAdapter | null {
  return adapter
}

function asElectron(mod: unknown): ElectronModule | null {
  if (!mod || typeof mod !== 'object') return null
  const loaded = mod as Partial<ElectronModule>
  return loaded.app && loaded.safeStorage ? (loaded as ElectronModule) : null
}

/** Inside the Electron process, require('electron') is the API. Elsewhere it is a path or missing. */
function electronSync(): ElectronModule | null {
  if (adapter) return null
  if (cachedElectron) return cachedElectron
  if (!process.versions.electron) return null
  try {
    const loaded = asElectron(createRequire(import.meta.url)('electron'))
    if (loaded) cachedElectron = loaded
    return loaded
  } catch {
    return null
  }
}

/**
 * Loads electron only when no host adapter is installed. Dynamic import is what Vitest mocks;
 * the resolved module is cached for the synchronous path helpers.
 */
export function loadElectron(): Promise<ElectronModule | null> {
  if (adapter) return Promise.resolve(null)
  if (cachedElectron) return Promise.resolve(cachedElectron)
  const sync = electronSync()
  if (sync) return Promise.resolve(sync)
  if (!electronPromise) {
    electronPromise = import('electron')
      .then((mod) => {
        const loaded = asElectron(mod)
        if (loaded) cachedElectron = loaded
        return loaded
      })
      .catch(() => null)
  }
  return electronPromise
}

/** Resolves electron before a synchronous path lookup. Safe to call more than once. */
export async function ensureElectronHost(): Promise<void> {
  await loadElectron()
}

export async function electronSafeStorage(): Promise<ElectronSafeStorage | null> {
  return (await loadElectron())?.safeStorage ?? null
}

export function userDataDir(): string {
  if (adapter) return adapter.userDataDir()
  return electronSync()?.app.getPath('userData') ?? path.resolve(process.cwd(), 'agent-data')
}

export function knowledgeDir(): string {
  if (process.env.CODEMAP_AGENT_DIR) return process.env.CODEMAP_AGENT_DIR
  if (adapter) return adapter.knowledgeDir()
  const electron = electronSync()
  if (!electron) return path.resolve(process.cwd(), 'agent')
  return electron.app.isPackaged ? path.join(process.resourcesPath, 'agent') : path.join(electron.app.getAppPath(), 'agent')
}
