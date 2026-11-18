import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { MapIndex } from '../shared/types'
import { gitChurn, gitListFiles } from './gitService'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.build', 'build', 'dist', 'out', 'target', '.next', '.venv', 'venv', '__pycache__', 'DerivedData', '.idea', '.cache', '.codemap'])
const MAP_FILE_LIMIT = 20000
const HIDDEN_FILES = new Set(['.DS_Store'])

// Breadth-first file list used by Quick Open. Bounded so huge repos stay responsive.
export async function listWorkspaceFiles(root: string, limit = 20000): Promise<string[]> {
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
      if (entry.name === '.DS_Store') continue
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

// Everything the project map needs in one round trip: the file list (gitignore-aware inside a
// repository, so build output and vendored code stay off the map) plus recent git churn.
export async function mapIndex(root: string): Promise<MapIndex> {
  const { files: all, tracked } = await projectFiles(root, MAP_FILE_LIMIT + 1)
  let files = all
  const truncated = files.length > MAP_FILE_LIMIT
  if (truncated) files = files.slice(0, MAP_FILE_LIMIT)
  const churn = tracked ? await gitChurn().catch(() => ({})) : {}
  return { files, churn, truncated }
}

// Folder-relative project files: gitignore-aware inside a repository, otherwise a bounded walk
// that skips build output and dependency folders.
export async function projectFiles(root: string, limit: number): Promise<{ files: string[]; tracked: boolean }> {
  const tracked = await gitListFiles().catch(() => null)
  if (tracked) {
    const files = tracked.filter((file) => !file.split('/').some((part) => SKIP_DIRS.has(part) || HIDDEN_FILES.has(part)))
    return { files: files.slice(0, limit), tracked: true }
  }
  return { files: (await listWorkspaceFiles(root, limit)).map((file) => path.relative(root, file)), tracked: false }
}
