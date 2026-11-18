import type { GitBranch, GitCommit, GitFileChange, GitFileState, GitStatus } from './types'

function codeToState(code: string): GitFileState | null {
  switch (code) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    case 'U':
      return 'conflicted'
    default:
      return null
  }
}

// Parses `git status --porcelain=v2 --branch -z`.
export function parseStatusV2(output: string): GitStatus {
  const status: GitStatus = {
    isRepo: true,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    files: []
  }
  const records = output.split('\0')
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length)
      status.detached = head === '(detached)'
      status.branch = status.detached ? null : head
    } else if (record.startsWith('# branch.upstream ')) {
      status.upstream = record.slice('# branch.upstream '.length)
    } else if (record.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(record)
      if (match) {
        status.ahead = Number(match[1])
        status.behind = Number(match[2])
      }
    } else if (record.startsWith('1 ')) {
      const parts = record.split(' ')
      const xy = parts[1]
      status.files.push({ path: parts.slice(8).join(' '), index: codeToState(xy[0]), worktree: codeToState(xy[1]) })
    } else if (record.startsWith('2 ')) {
      const parts = record.split(' ')
      const xy = parts[1]
      const originalPath = records[++index]
      status.files.push({
        path: parts.slice(9).join(' '),
        originalPath,
        index: codeToState(xy[0]),
        worktree: codeToState(xy[1])
      })
    } else if (record.startsWith('u ')) {
      const parts = record.split(' ')
      status.files.push({ path: parts.slice(10).join(' '), index: 'conflicted', worktree: 'conflicted' })
    } else if (record.startsWith('? ')) {
      status.files.push({ path: record.slice(2), index: null, worktree: 'untracked' })
    }
  }
  status.files.sort((a, b) => a.path.localeCompare(b.path))
  return status
}

export function isStaged(change: GitFileChange): boolean {
  return change.index !== null && change.index !== 'conflicted'
}

export function isUnstaged(change: GitFileChange): boolean {
  return change.worktree !== null
}

export function parseBranches(output: string): GitBranch[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [head, refName] = line.split('\t')
      const remote = refName.startsWith('refs/remotes/')
      const name = refName.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '')
      return { name, current: head === '*', remote }
    })
    .filter((branch) => !branch.name.endsWith('/HEAD'))
}

export const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e'

export function parseLog(output: string): GitCommit[] {
  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, author, date, subject] = record.split('\x1f')
      return { hash, shortHash, author, date, subject }
    })
}

export const CHURN_FORMAT = '%x01%ct'
const CHURN_HALF_LIFE_DAYS = 30
// Commits touching more files than this (initial imports, mass renames, reformatting) say
// nothing about where work happens, so they do not count toward churn.
const CHURN_MAX_FILES_PER_COMMIT = 40

// Parses `git log --name-only -z --format=%x01%ct`. Every commit that touched a file adds a
// weight that halves every 30 days; the result is scaled so the busiest file is 1.
export function parseChurn(output: string, nowSeconds: number): Record<string, number> {
  const raw: Record<string, number> = {}
  let max = 0
  for (const record of output.split('\x01')) {
    if (!record) continue
    const [header, ...names] = record.split('\0')
    const time = Number(header.trim())
    if (!header.trim() || !Number.isFinite(time)) continue
    const files = names.map((name) => name.replace(/^\n+/, '')).filter(Boolean)
    if (files.length > CHURN_MAX_FILES_PER_COMMIT) continue
    const weight = Math.pow(0.5, Math.max(0, nowSeconds - time) / 86400 / CHURN_HALF_LIFE_DAYS)
    for (const file of files) {
      raw[file] = (raw[file] ?? 0) + weight
      if (raw[file] > max) max = raw[file]
    }
  }
  if (max) for (const file of Object.keys(raw)) raw[file] = Math.round((raw[file] / max) * 1000) / 1000
  return raw
}
