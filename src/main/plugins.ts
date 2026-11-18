import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { app, shell } from 'electron'
import type { PluginDescriptor, PluginFetchInit, PluginFetchResponse, PluginManifest } from '../shared/types'
import { isInside } from '../shared/paths'
import { matchesNetworkRule, PLUGIN_SCHEME } from './security'
import { getAppState } from './settingsStore'

const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,63}$/
const MAX_FETCH_BYTES = 20 * 1024 * 1024

let discovered = new Map<string, PluginDescriptor>()

export function builtinPluginsDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'plugins') : path.join(app.getAppPath(), 'plugins')
}

export function userPluginsDir(): string {
  return path.join(app.getPath('userData'), 'plugins')
}

function validateManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== 'object') throw new Error('plugin.json must be an object')
  const manifest = raw as PluginManifest
  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) throw new Error('Invalid plugin id')
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('Missing plugin name')
  if (typeof manifest.version !== 'string') throw new Error('Missing plugin version')
  if (manifest.renderer !== undefined && typeof manifest.renderer !== 'string') throw new Error('renderer must be a path')
  return manifest
}

async function scan(dir: string, source: PluginDescriptor['source'], disabled: Set<string>): Promise<PluginDescriptor[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const result: PluginDescriptor[] = []
  for (const entry of entries.sort()) {
    const directory = path.join(dir, entry)
    try {
      if (!(await stat(directory)).isDirectory()) continue
    } catch {
      continue
    }
    try {
      const manifest = validateManifest(JSON.parse(await readFile(path.join(directory, 'plugin.json'), 'utf8')))
      const descriptor: PluginDescriptor = { manifest, directory, source, enabled: !disabled.has(manifest.id) }
      if (manifest.renderer) {
        const entryFile = path.resolve(directory, manifest.renderer)
        if (!isInside(directory, entryFile)) throw new Error('renderer must stay inside the plugin folder')
        descriptor.rendererUrl = `${PLUGIN_SCHEME}://${manifest.id}/${path.relative(directory, entryFile).split(path.sep).join('/')}`
      }
      result.push(descriptor)
    } catch (error) {
      result.push({
        manifest: { id: `invalid.${entry.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}`, name: entry, version: '0.0.0' },
        directory,
        source,
        enabled: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

export async function discoverPlugins(): Promise<PluginDescriptor[]> {
  await mkdir(userPluginsDir(), { recursive: true }).catch(() => undefined)
  const disabled = new Set((await getAppState()).disabledPlugins)
  const builtin = await scan(builtinPluginsDir(), 'builtin', disabled)
  const user = await scan(userPluginsDir(), 'user', disabled)
  const map = new Map<string, PluginDescriptor>()
  // User plugins with the same id override bundled ones, which makes it easy to fork a builtin.
  for (const descriptor of [...builtin, ...user]) map.set(descriptor.manifest.id, descriptor)
  discovered = map
  return [...map.values()]
}

export function resolvePluginAsset(pluginId: string, assetPath: string): string | null {
  const descriptor = discovered.get(pluginId)
  if (!descriptor || descriptor.error) return null
  const target = path.resolve(descriptor.directory, decodeURIComponent(assetPath).replace(/^\/+/, ''))
  return isInside(descriptor.directory, target) ? target : null
}

export async function openUserPluginsFolder(): Promise<void> {
  await mkdir(userPluginsDir(), { recursive: true })
  await shell.openPath(userPluginsDir())
}

export async function pluginFetch(pluginId: string, url: string, init: PluginFetchInit = {}): Promise<PluginFetchResponse> {
  const descriptor = discovered.get(pluginId)
  if (!descriptor || !descriptor.enabled) throw new Error(`Unknown or disabled plugin: ${pluginId}`)
  if (!matchesNetworkRule(url, descriptor.manifest.permissions?.network)) {
    throw new Error(`${pluginId} is not allowed to reach ${new URL(url).origin}. Add it to permissions.network in plugin.json.`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    // Node's fetch runs outside Chromium's session, so the renderer-wide network block does not apply here.
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
      redirect: 'error'
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_FETCH_BYTES) throw new Error('Response is larger than 20 MB')
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })
    return { status: response.status, statusText: response.statusText, headers, body: buffer.toString('utf8') }
  } finally {
    clearTimeout(timer)
  }
}
