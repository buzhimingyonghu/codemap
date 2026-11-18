import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { isInside } from '../shared/paths'

// Single source of truth for "which folder is open" in the main process.
// Every file, git, and task operation resolves paths through here so the
// renderer and plugins can never reach outside the open workspace.
let currentRoot: string | null = null

export async function setWorkspaceRoot(root: string): Promise<string> {
  const resolved = await realpath(path.resolve(root))
  const info = await stat(resolved)
  if (!info.isDirectory()) throw new Error(`Not a folder: ${root}`)
  currentRoot = resolved
  return resolved
}

export function getWorkspaceRoot(): string | null {
  return currentRoot
}

export function requireWorkspaceRoot(): string {
  if (!currentRoot) throw new Error('No folder is open')
  return currentRoot
}

export function clearWorkspaceRoot(): void {
  currentRoot = null
}

export function resolveInWorkspace(target: string): string {
  const root = requireWorkspaceRoot()
  const absolute = path.resolve(root, target)
  if (!isInside(root, absolute)) throw new Error(`Path is outside the open folder: ${target}`)
  return absolute
}

export function toWorkspaceRelative(target: string): string {
  const root = requireWorkspaceRoot()
  const absolute = resolveInWorkspace(target)
  return path.relative(root, absolute) || '.'
}
