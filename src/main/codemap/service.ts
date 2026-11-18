import { watch, type FSWatcher } from 'node:fs'
import { access, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { CodemapLayoutPatch, CodemapNodePatch, CodemapLoad, CodemapRead } from '../../shared/types'
import { isInside } from '../../shared/paths'
import { loadLibrary } from './loadLibrary.mjs'
import { applyLayoutPatch, applyNodePatch } from './writeLayout'

// Code map support in the main process: finding the node library for the open folder,
// reading it, watching it, and reading code files the map points at.
//
// Reads are limited to the open folder plus folders the user explicitly granted in a
// native dialog. Grants are what let a map in ~/dev/shop show code from the Go module cache.

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'target', 'release', 'vendor', '__pycache__', '.venv', 'venv'])
const SCHEMA_PREFIX = /^\s*schema:\s*codemap\/v1\b/m
const MAX_SCANNED_DIRS = 600
const MAX_FILE_BYTES = 8 * 1024 * 1024

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

async function startsWithSchema(file: string): Promise<boolean> {
  try {
    const head = (await readFile(file, 'utf8')).slice(0, 400)
    return SCHEMA_PREFIX.test(head)
  } catch {
    return false
  }
}

/** A folder is a node library if it has a .codemapignore, a nodes/ folder, or a `<child>/<child>.yaml` node file. */
export async function isLibrary(dir: string): Promise<boolean> {
  if (await exists(path.join(dir, '.codemapignore'))) return true
  if (await exists(path.join(dir, 'nodes'))) {
    const nodes = await readdir(path.join(dir, 'nodes')).catch(() => [] as string[])
    if (nodes.some((name) => /\.ya?ml$/.test(name))) return true
  }
  for (const child of await subdirs(dir)) {
    const name = path.basename(child)
    for (const ext of ['yaml', 'yml']) if (await startsWithSchema(path.join(child, `${name}.${ext}`))) return true
  }
  return false
}

/** Node libraries in the folder itself or up to two levels below it, nearest first. */
export async function findLibraries(root: string): Promise<string[]> {
  if (await isLibrary(root)) return [root]
  const found: string[] = []
  let level = await subdirs(root)
  let scanned = 0
  for (let depth = 1; depth <= 2 && level.length; depth++) {
    const next: string[] = []
    for (const dir of level) {
      if (++scanned > MAX_SCANNED_DIRS) return found
      if (await isLibrary(dir)) found.push(dir)
      else if (depth < 2) next.push(...(await subdirs(dir)))
    }
    // Prefer the shallowest libraries; deeper ones are usually fixtures or copies.
    if (found.length) return found
    level = next
  }
  return found
}

// ---------- Access ----------

export class CodemapAccess {
  constructor(
    private readonly getRoot: () => string | null,
    private grants: string[]
  ) {}

  setGrants(grants: string[]): void {
    this.grants = grants
  }

  list(): string[] {
    return [...this.grants]
  }

  allowed(target: string): boolean {
    const root = this.getRoot()
    if (root && isInside(root, target)) return true
    return this.grants.some((grant) => isInside(grant, target))
  }
}

/** Folders too broad to grant in one click. */
export function grantable(folder: string): boolean {
  const normalized = path.resolve(folder)
  return normalized !== '/' && normalized !== homedir() && normalized !== path.dirname(homedir())
}

export async function resolveFolder(folder: string): Promise<string> {
  const real = await realpath(path.resolve(folder))
  if (!(await stat(real)).isDirectory()) throw new Error(`Not a folder: ${folder}`)
  return real
}

// ---------- Loading ----------

export async function loadCodemap(library: string): Promise<Omit<CodemapLoad, 'status' | 'candidates' | 'source'>> {
  const loaded = loadLibrary(library)
  return {
    library,
    docs: loaded.docs,
    links: loaded.links,
    requirements: loaded.requirements,
    todos: loaded.todos,
    errors: loaded.errors,
    fileCount: loaded.docs.length + loaded.links.length + loaded.requirements.length
  }
}

export async function readCodemapFile(accessCheck: CodemapAccess, file: string): Promise<CodemapRead> {
  const absolute = path.resolve(file)
  let real = absolute
  try {
    real = await realpath(absolute)
  } catch {
    return { ok: false, reason: 'missing', message: absolute }
  }
  // Roots and grants are real paths, so a symlink cannot lead out of an allowed folder.
  if (!accessCheck.allowed(real)) return { ok: false, reason: 'access', folder: path.dirname(absolute) }
  try {
    const info = await stat(real)
    if (!info.isFile()) return { ok: false, reason: 'missing', message: absolute }
    if (info.size > MAX_FILE_BYTES) return { ok: false, reason: 'error', message: 'File is larger than 8 MB' }
    const buffer = await readFile(real)
    if (buffer.subarray(0, 8000).includes(0)) return { ok: false, reason: 'error', message: 'Binary file' }
    return { ok: true, path: absolute, text: buffer.toString('utf8') }
  } catch (error) {
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

// ---------- Watching ----------

// The library may live outside the open folder, so it gets its own watcher.
export class CodemapWatcher {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private dir: string | null = null
  /** Files we just wrote, with their content: a change to exactly that content is ours. */
  private ownWrites = new Map<string, string>()
  private pending = new Set<string>()

  constructor(private readonly onChange: () => void) {}

  /** `file` is about to be written with `content` by us; that change must not trigger a reload. */
  expectOwnWrite(file: string, content: string): void {
    this.ownWrites.set(file, content)
  }

  start(dir: string): void {
    if (this.dir === dir && this.watcher) return
    this.stop()
    this.dir = dir
    try {
      this.watcher = watch(dir, { recursive: true, persistent: false }, (_event, name) => {
        const file = name?.toString() ?? ''
        // YAML, the ignore file, and to-do notes (todo/*.md) reload the map.
        if (file && !/\.(ya?ml)$|(^|\/)\.codemapignore$|(^|\/)todo\/[^/]+\.md$/i.test(file)) return
        this.pending.add(file ? path.join(dir, file) : '')
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = null
          const files = [...this.pending]
          this.pending.clear()
          void this.isOwnOnly(files).then((own) => {
            if (!own) this.onChange()
          })
        }, 300)
      })
      this.watcher.on('error', () => this.stop())
    } catch {
      this.watcher = null
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    this.dir = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** True when every changed file still holds exactly what we wrote to it. */
  private async isOwnOnly(files: string[]): Promise<boolean> {
    if (!files.length || files.includes('')) return false
    for (const file of files) {
      const expected = this.ownWrites.get(file)
      if (expected === undefined) return false
      const now = await readFile(file, 'utf8').catch(() => null)
      if (now !== expected) {
        this.ownWrites.delete(file)
        return false
      }
    }
    return true
  }
}

/**
 * Writes layout / ports into a map's YAML file. Allowed only inside the open folder: folders
 * outside it were granted for reading, not writing.
 */
export async function writeCodemapLayout(
  root: string | null,
  library: string | null,
  file: string,
  patch: CodemapLayoutPatch,
  beforeWrite?: (file: string, content: string) => void
): Promise<void> {
  const real = await writableNodeFile(root, library, file)
  const text = await readFile(real, 'utf8')
  const next = applyLayoutPatch(text, patch)
  if (next === text) return
  beforeWrite?.(path.resolve(library!, file), next)
  if (real !== path.resolve(library!, file)) beforeWrite?.(real, next)
  await writeFile(real, next, 'utf8')
}

/** A node file of the library that may be written: inside the library and the open folder. */
async function writableNodeFile(root: string | null, library: string | null, file: string): Promise<string> {
  if (!root || !library) throw new Error('No code map is open')
  const real = await realpath(path.resolve(library, file))
  if (!isInside(library, real) || !/\.ya?ml$/.test(real)) throw new Error('Not a node file of this library')
  if (!isInside(root, real)) throw new Error('The node library is outside the open folder, so it cannot be edited')
  return real
}

/** Writes edited node fields into the node's YAML (the library reloads and re-checks after). */
export async function writeCodemapNode(root: string | null, library: string | null, file: string, patch: CodemapNodePatch): Promise<void> {
  const real = await writableNodeFile(root, library, file)
  const text = await readFile(real, 'utf8')
  const next = applyNodePatch(text, patch as { node: string; fields: Record<string, string | null> })
  if (next !== text) await writeFile(real, next, 'utf8')
}
