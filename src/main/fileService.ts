import { constants } from 'node:fs'
import { access, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { clipboard, ClipboardItem, shell } from 'electron'
import type { DirEntry, TransferResult } from '../shared/types'
import { isInside, isValidEntryName } from '../shared/paths'
import { getWorkspaceRoot, resolveInWorkspace } from './workspace'

const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024
const HIDDEN_NAMES = new Set(['.git', '.DS_Store', 'node_modules', '.Trash', '.codemap', '.cache'])

function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

export async function listDirectory(dir: string): Promise<DirEntry[]> {
  const absolute = resolveInWorkspace(dir)
  const entries = await readdir(absolute, { withFileTypes: true })
  const result: DirEntry[] = []
  for (const entry of entries) {
    if (HIDDEN_NAMES.has(entry.name)) continue
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

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000))
  return sample.includes(0)
}

export async function readTextFile(file: string): Promise<string> {
  const absolute = resolveInWorkspace(file)
  return readTextAt(absolute)
}

async function readTextAt(absolute: string): Promise<string> {
  const info = await stat(absolute)
  if (!info.isFile()) throw new Error('Only files can be opened')
  if (info.size > MAX_TEXT_FILE_BYTES) throw new Error('File is larger than 8 MB')
  const buffer = await readFile(absolute)
  if (looksBinary(buffer)) throw new Error('Binary files cannot be edited')
  return buffer.toString('utf8')
}

// Go-to-definition can land in SDK headers or toolchain sources outside the folder.
// Those are opened read-only, and only from well-known source locations.
const EXTERNAL_ROOTS = ['/Library/Developer/', '/Applications/Xcode.app/', '/opt/homebrew/', '/usr/local/include/', '/usr/include/']
const EXTERNAL_EXTENSIONS = /\.(h|hh|hpp|hxx|inc|ipp|tcc|c|cc|cpp|cxx|m|mm|swift|swiftinterface|modulemap|rs|go|py|pyi|ts|js)$/i

export async function readExternalTextFile(file: string): Promise<string> {
  const absolute = path.resolve(file)
  const real = await realpath(absolute).catch(() => absolute)
  const allowedRoot = EXTERNAL_ROOTS.some((root) => real.startsWith(root)) || /\/(\.cargo|\.rustup|go\/pkg\/mod|site-packages|node_modules)\//.test(real)
  if (!allowedRoot || !EXTERNAL_EXTENSIONS.test(real)) throw new Error('This location cannot be opened')
  return readTextAt(real)
}

export async function writeTextFile(file: string, content: string): Promise<void> {
  const absolute = resolveInWorkspace(file)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, content, 'utf8')
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function createEntry(parent: string, name: string, kind: 'file' | 'directory'): Promise<string> {
  if (!isValidEntryName(name)) throw new Error('Invalid name')
  const target = resolveInWorkspace(path.join(resolveInWorkspace(parent), name))
  if (await exists(target)) throw new Error(`${name} already exists`)
  if (kind === 'directory') await mkdir(target)
  else await writeFile(target, '', { flag: 'wx' })
  return target
}

export async function renameEntry(from: string, newName: string): Promise<string> {
  if (!isValidEntryName(newName)) throw new Error('Invalid name')
  const source = resolveInWorkspace(from)
  const target = resolveInWorkspace(path.join(path.dirname(source), newName))
  if (source === target) return target
  if (await exists(target)) throw new Error(`${newName} already exists`)
  await rename(source, target)
  return target
}

export async function trashEntry(target: string): Promise<void> {
  const absolute = resolveInWorkspace(target)
  try {
    await shell.trashItem(absolute)
  } catch {
    await rm(absolute, { recursive: true, force: false })
  }
}

export function revealEntry(target: string): void {
  shell.showItemInFolder(resolveInWorkspace(target))
}

// ---------- Copy, cut, paste, drag and drop ----------

// "name copy.ext", "name copy 2.ext", ... like Finder.
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
  if (info.isDirectory() && isInside(absoluteSource, targetDir)) {
    throw new Error(`Cannot put "${path.basename(source)}" inside itself`)
  }
  if (mode === 'move' && path.dirname(absoluteSource) === targetDir) return absoluteSource
  const target = await uniqueTarget(targetDir, path.basename(absoluteSource))
  if (mode === 'move') {
    try {
      await rename(absoluteSource, target)
      return target
    } catch (error) {
      // Different volume: fall back to copy + delete.
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    }
  }
  await cp(absoluteSource, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true })
  if (mode === 'move') await rm(absoluteSource, { recursive: true, force: true })
  return target
}

// Sources may come from anywhere (Finder, Desktop); the destination must be inside the
// open folder. Moving out of the folder is not offered, and moves only accept sources
// that are themselves inside the folder so Codemap never deletes files elsewhere.
export async function transferEntries(sources: string[], targetDir: string, mode: 'copy' | 'move'): Promise<TransferResult> {
  const destination = resolveInWorkspace(targetDir)
  if (!(await stat(destination)).isDirectory()) throw new Error('Paste target must be a folder')
  const root = getWorkspaceRoot()
  const created: string[] = []
  const failed: { path: string; error: string }[] = []
  for (const source of [...new Set(sources)]) {
    try {
      if (mode === 'move' && (!root || !isInside(root, path.resolve(source)))) throw new Error('Only files inside the open folder can be moved')
      created.push(await transferOne(source, destination, mode))
    } catch (error) {
      failed.push({ path: source, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { created, failed }
}

export async function duplicateEntry(source: string): Promise<string> {
  const absolute = resolveInWorkspace(source)
  return transferOne(absolute, path.dirname(absolute), 'copy')
}

// Reads file references Finder (or any app) put on the system clipboard. Finder writes one
// item per file, which Electron exposes as a CRLF-separated `text/uri-list`.
export async function readClipboardFiles(): Promise<string[]> {
  const items = await clipboard.read()
  const paths: string[] = []
  for (const item of items) {
    if (!item.types.includes('text/uri-list')) continue
    const text = await (await item.getType('text/uri-list')).text()
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('file://')) continue
      try {
        paths.push(decodeURIComponent(new URL(trimmed).pathname))
      } catch {
        /* skip malformed entries */
      }
    }
  }
  return [...new Set(paths)]
}

// Puts files on the system clipboard so they can be pasted into Finder as well.
export async function writeClipboardFiles(paths: string[]): Promise<void> {
  const absolute = paths.map((entry) => resolveInWorkspace(entry))
  const uriList = absolute.map((entry) => `file://${encodeURI(entry)}`).join('\r\n')
  await clipboard.write([new ClipboardItem({ 'text/uri-list': uriList, 'text/plain': absolute.join('\n') })])
}
