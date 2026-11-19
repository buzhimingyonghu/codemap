import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, cp, lstat, mkdir, readdir, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CHURN_FORMAT, parseChurn, parseStatusV2 } from '../../../src/shared/gitParse'
import { isInside, isValidEntryName } from '../../../src/shared/paths'
import type { DirEntry, GitStatus, MapIndex, TransferResult } from '../../../src/shared/types'

const MAP_FILE_LIMIT = 20000
const SKIP_DIRS = new Set(['.git', 'node_modules', '.build', 'build', 'dist', 'out', 'target', '.next', '.venv', 'venv', '__pycache__', 'DerivedData', '.idea', '.cache', '.lumen'])
const HIDDEN_FILES = new Set(['.DS_Store'])
const LIST_HIDDEN = new Set(['.git', '.DS_Store', 'node_modules', '.Trash', '.lumen', '.cache'])
const EMPTY_STATUS: GitStatus = {
  isRepo: false,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  detached: false,
  files: []
}

export interface ProjectMapHostOptions {
  trash?: (absPath: string) => Promise<void>
}

export class ProjectMapHost {
  constructor(
    private readonly getRoot: () => string | null,
    private readonly options: ProjectMapHostOptions = {}
  ) {}

  async mapIndex(): Promise<MapIndex> {
    const root = this.requireRoot()
    const tracked = await this.gitListFiles(root).catch(() => null)
    if (tracked) {
      const all = tracked.filter((file) => !file.split('/').some((part) => SKIP_DIRS.has(part) || HIDDEN_FILES.has(part)))
      const truncated = all.length > MAP_FILE_LIMIT
      const churn = await this.gitChurn(root).catch(() => ({}))
      return { files: truncated ? all.slice(0, MAP_FILE_LIMIT) : all, churn, truncated }
    }
    const walked = await listWorkspaceFiles(root, MAP_FILE_LIMIT + 1)
    const truncated = walked.length > MAP_FILE_LIMIT
    return {
      files: (truncated ? walked.slice(0, MAP_FILE_LIMIT) : walked).map((file) => toPosix(path.relative(root, file))),
      churn: {},
      truncated
    }
  }

  async gitStatus(): Promise<GitStatus> {
    const root = this.getRoot()
    if (!root) return EMPTY_STATUS
    try {
      const inside = (await git(root, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true })).trim()
      if (inside !== 'true') return EMPTY_STATUS
      return parseStatusV2(await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']))
    } catch {
      return EMPTY_STATUS
    }
  }

  async listDirectory(dir: string): Promise<DirEntry[]> {
    const absolute = await this.resolveInside(dir)
    const entries = await readdir(absolute, { withFileTypes: true })
    const result: DirEntry[] = []
    for (const entry of entries) {
      if (LIST_HIDDEN.has(entry.name)) continue
      const entryPath = path.join(absolute, entry.name)
      let isDirectory = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = (await stat(entryPath)).isDirectory()
        } catch {
          continue
        }
      }
      result.push({ name: entry.name, path: entryPath, kind: isDirectory ? 'directory' : 'file' })
    }
    return result.sort(compareEntries)
  }

  async listFiles(limit = 20000): Promise<string[]> {
    return listWorkspaceFiles(this.requireRoot(), limit)
  }

  async createEntry(parent: string, name: string, kind: 'file' | 'directory'): Promise<string> {
    if (!isValidEntryName(name)) throw new Error('Invalid name')
    const parentPath = await this.resolveInside(parent)
    const target = await this.resolveInside(path.join(parentPath, name))
    if (await exists(target)) throw new Error(`${name} already exists`)
    if (kind === 'directory') await mkdir(target)
    else await writeFile(target, '', { flag: 'wx' })
    return target
  }

  async renameEntry(target: string, newName: string): Promise<string> {
    if (!isValidEntryName(newName)) throw new Error('Invalid name')
    const root = this.requireRoot()
    const source = await this.resolveInside(target)
    if (pathsEqual(source, root)) throw new Error('Cannot rename the workspace root')
    const destination = await this.resolveInside(path.join(path.dirname(source), newName))
    if (pathsEqual(source, destination)) return destination
    if (await exists(destination)) throw new Error(`${newName} already exists`)
    await rename(source, destination)
    return destination
  }

  async trashEntry(target: string): Promise<void> {
    const root = this.requireRoot()
    const absolute = await this.resolveInside(target)
    if (pathsEqual(absolute, root)) throw new Error('Cannot delete the workspace root')
    if (this.options.trash) {
      await this.options.trash(absolute)
      return
    }
    await rm(absolute, { recursive: true, force: false })
  }

  async duplicateEntry(target: string): Promise<string> {
    const absolute = await this.resolveInside(target)
    return transferOne(absolute, path.dirname(absolute), 'copy')
  }

  async transferEntries(sources: string[], targetDir: string, mode: 'copy' | 'move'): Promise<TransferResult> {
    const root = this.requireRoot()
    const destination = await this.resolveInside(targetDir)
    if (!(await stat(destination)).isDirectory()) throw new Error('Paste target must be a folder')
    const created: string[] = []
    const failed: { path: string; error: string }[] = []
    for (const source of [...new Set(sources)]) {
      try {
        if (mode === 'move') {
          const sourcePath = await this.resolveInside(source)
          if (pathsEqual(sourcePath, root) || !(await isRealInside(root, sourcePath))) {
            throw new Error('Only files inside the open folder can be moved')
          }
        }
        created.push(await transferOne(path.resolve(root, source), destination, mode))
      } catch (error) {
        failed.push({ path: source, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { created, failed }
  }

  private requireRoot(): string {
    const root = this.getRoot()
    if (!root) throw new Error('No folder is open')
    return path.resolve(root)
  }

  private async resolveInside(target: string): Promise<string> {
    const root = this.requireRoot()
    const absolute = path.resolve(root, target)
    if (!isInside(root, absolute)) throw new Error(`Path is outside the open folder: ${target}`)
    if (!(await isRealInside(root, absolute))) throw new Error(`Path is outside the open folder: ${target}`)
    return absolute
  }

  private async gitListFiles(root: string): Promise<string[] | null> {
    const inside = (await git(root, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true })).trim()
    if (inside !== 'true') return null
    const top = await listRepoEntries(root, null)
    if (top === null) return null
    const seen = new Set(top)
    const files = [...top]
    const listed = new Set(top.filter((entry) => !entry.endsWith('/')))
    const add = (entry: string) => {
      if (!entry || seen.has(entry)) return
      seen.add(entry)
      files.push(entry)
    }
    for (const entry of top) {
      if (!entry.endsWith('/')) continue
      const dir = entry.slice(0, -1)
      if ([...listed].some((file) => file.startsWith(entry))) continue
      if (!(await isRepoRoot(root, dir))) continue
      for (const inner of (await listRepoEntries(root, dir)) ?? []) add(`${dir}/${inner}`)
    }
    return files.map(toPosix)
  }

  private async gitChurn(root: string): Promise<Record<string, number>> {
    const output = await git(
      root,
      ['log', '--max-count=120', '--no-merges', '--no-renames', '--relative', '--name-only', '-z', `--format=${CHURN_FORMAT}`],
      { allowFailure: true }
    )
    return parseChurn(output, Date.now() / 1000)
  }
}

async function listWorkspaceFiles(root: string, limit = 20000): Promise<string[]> {
  const result: string[] = []
  const queue: string[] = [root]
  while (queue.length && result.length < limit) {
    const dir = queue.shift() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (HIDDEN_FILES.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.endsWith('.xcodeproj') && !entry.name.endsWith('.dSYM')) queue.push(full)
      } else if (entry.isFile()) {
        result.push(full)
        if (result.length >= limit) break
      }
    }
  }
  return result
}

async function listRepoEntries(root: string, dir: string | null): Promise<string[] | null> {
  const base = dir ? ['-C', dir] : []
  const tracked = await git(root, [...base, 'ls-files', '-z', '-s', '--cached', '--exclude-standard', '--recurse-submodules'], { allowFailure: true })
  const staged = tracked || (await git(root, [...base, 'ls-files', '-z', '-s', '--cached', '--exclude-standard'], { allowFailure: true }))
  const untracked = await git(root, [...base, 'ls-files', '-z', '--others', '--exclude-standard'], { allowFailure: true })
  if (!staged && !untracked) return null
  const entries: string[] = []
  for (const record of staged.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const mode = record.slice(0, record.indexOf(' '))
    const file = record.slice(tab + 1)
    entries.push(mode === '160000' ? `${file}/` : file)
  }
  for (const entry of untracked.split('\0')) if (entry) entries.push(entry)
  return entries
}

async function isRepoRoot(root: string, dir: string): Promise<boolean> {
  try {
    await access(path.join(root, dir, '.git'))
    return true
  } catch {
    return false
  }
}

function git(cwd: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
        maxBuffer: 32 * 1024 * 1024
      },
      (error, stdout) => {
        if (error) {
          if (options.allowFailure) {
            resolve('')
            return
          }
          const stderr = (error as NodeJS.ErrnoException & { stderr?: string }).stderr
          reject(new Error((stderr || stdout || error.message).trim()))
          return
        }
        resolve(stdout)
      }
    )
  })
}

function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function uniqueTarget(dir: string, name: string): Promise<string> {
  const first = path.join(dir, name)
  if (!(await exists(first))) return first
  const ext = path.extname(name)
  const stem = ext && !name.startsWith('.') ? name.slice(0, -ext.length) : name
  const suffix = ext && !name.startsWith('.') ? ext : ''
  for (let index = 1; index < 1000; index++) {
    const candidate = path.join(dir, `${stem} copy${index === 1 ? '' : ` ${index}`}${suffix}`)
    if (!(await exists(candidate))) return candidate
  }
  throw new Error(`Too many copies of ${name}`)
}

async function transferOne(source: string, targetDir: string, mode: 'copy' | 'move'): Promise<string> {
  const absoluteSource = path.resolve(source)
  const info = await lstat(absoluteSource).catch(() => null)
  if (!info) throw new Error(`${path.basename(source)} no longer exists`)
  if (info.isDirectory() && isInside(absoluteSource, targetDir)) throw new Error(`Cannot put "${path.basename(source)}" inside itself`)
  if (mode === 'move' && path.dirname(absoluteSource) === targetDir) return absoluteSource
  const target = await uniqueTarget(targetDir, path.basename(absoluteSource))
  if (mode === 'move') {
    try {
      await rename(absoluteSource, target)
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    }
  }
  await cp(absoluteSource, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true })
  if (mode === 'move') await rm(absoluteSource, { recursive: true, force: true })
  return target
}

async function isRealInside(root: string, target: string): Promise<boolean> {
  const realRoot = await realpath(root).catch(() => path.resolve(root))
  let current = path.resolve(target)
  const seen = new Set<string>()
  while (!seen.has(current)) {
    seen.add(current)
    if (!isInside(realRoot, current) && !isInside(path.resolve(root), current)) return false
    let info
    try {
      info = await lstat(current)
    } catch {
      current = path.dirname(current)
      continue
    }
    if (info.isSymbolicLink()) {
      const link = await readlink(current)
      current = path.resolve(path.dirname(current), link)
      continue
    }
    const real = await realpath(current).catch(() => current)
    return isInside(realRoot, real)
  }
  return false
}

function pathsEqual(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}
