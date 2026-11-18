import { getState, setState } from '../state/store'
import { t } from '../lib/i18n'
import { reportError, notify } from './ui'

let refreshing: Promise<void> | null = null

export function refreshGit(): Promise<void> {
  if (!getState().workspace) return Promise.resolve()
  refreshing ??= (async () => {
    try {
      const status = await window.codemap.git.status()
      setState({ git: status })
      if (status.isRepo) {
        const [branches, commits] = await Promise.all([window.codemap.git.branches(), window.codemap.git.log(60)])
        setState({ branches, commits })
      } else {
        setState({ branches: [], commits: [] })
      }
    } catch (error) {
      console.warn(error)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

export async function runGit<T>(label: string, action: () => Promise<T>, success?: string): Promise<T | undefined> {
  setState({ gitBusy: label })
  try {
    const result = await action()
    if (success) notify(success, 'success')
    return result
  } catch (error) {
    reportError(error, t('{label} failed', { label }))
    return undefined
  } finally {
    setState({ gitBusy: null })
    await refreshGit()
  }
}

export function gitDecoration(path: string): 'modified' | 'added' | 'deleted' | 'untracked' | 'conflicted' | null {
  const state = getState()
  const root = state.workspace?.root
  const git = state.git
  if (!root || !git?.isRepo) return null
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  let folderHit: 'modified' | null = null
  for (const file of git.files) {
    if (file.path === relative) {
      if (file.index === 'conflicted') return 'conflicted'
      if (file.worktree === 'untracked') return 'untracked'
      if (file.index === 'added') return 'added'
      if (file.worktree === 'deleted' || file.index === 'deleted') return 'deleted'
      return 'modified'
    }
    if (file.path.startsWith(`${relative}/`)) folderHit = 'modified'
  }
  return folderHit
}
