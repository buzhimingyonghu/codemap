import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { GitBranch, GitCommit, GitDiffContent, GitStatus } from '../shared/types'
import { CHURN_FORMAT, LOG_FORMAT, parseBranches, parseChurn, parseLog, parseStatusV2 } from '../shared/gitParse'
import { getShellEnv } from './shellEnv'
import { requireWorkspaceRoot, resolveInWorkspace } from './workspace'

const EMPTY_STATUS: GitStatus = {
  isRepo: false,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  detached: false,
  files: []
}

class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null
  ) {
    super(message)
  }
}

async function git(args: string[], options: { allowFailure?: boolean; input?: string } = {}): Promise<string> {
  const cwd = requireWorkspaceRoot()
  const env = await getShellEnv()
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
        maxBuffer: 32 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error && !options.allowFailure) {
          const message = (stderr || stdout || error.message).trim()
          reject(new GitError(message, typeof error.code === 'number' ? error.code : null))
          return
        }
        resolve(stdout)
      }
    )
    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    }
  })
}

function repoRelative(target: string): string {
  const root = requireWorkspaceRoot()
  return path.relative(root, resolveInWorkspace(target))
}

export async function gitStatus(): Promise<GitStatus> {
  try {
    const inside = (await git(['rev-parse', '--is-inside-work-tree'], { allowFailure: true })).trim()
    if (inside !== 'true') return EMPTY_STATUS
    const output = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
    return parseStatusV2(output)
  } catch {
    return EMPTY_STATUS
  }
}

export async function gitInit(): Promise<void> {
  await git(['init'])
}

export async function gitStage(paths: string[]): Promise<void> {
  if (!paths.length) return
  await git(['add', '-A', '--', ...paths.map(repoRelative)])
}

export async function gitUnstage(paths: string[]): Promise<void> {
  if (!paths.length) return
  const relative = paths.map(repoRelative)
  const hasHead = (await git(['rev-parse', '--verify', 'HEAD'], { allowFailure: true })).trim()
  if (hasHead) await git(['restore', '--staged', '--', ...relative])
  else await git(['rm', '--cached', '-r', '--quiet', '--', ...relative])
}

export async function gitDiscard(paths: string[]): Promise<void> {
  if (!paths.length) return
  const status = await gitStatus()
  const relative = new Set(paths.map(repoRelative))
  const untracked = status.files.filter((file) => relative.has(file.path) && file.worktree === 'untracked').map((f) => f.path)
  const tracked = [...relative].filter((file) => !untracked.includes(file))
  if (tracked.length) await git(['restore', '--worktree', '--', ...tracked])
  if (untracked.length) await git(['clean', '-f', '--', ...untracked])
}

export async function gitCommit(message: string, amend = false): Promise<void> {
  const trimmed = message.trim()
  if (!trimmed && !amend) throw new Error('Commit message is empty')
  const args = ['commit', '--file=-']
  if (amend) args.push('--amend')
  await git(args, { input: trimmed })
}

export async function gitBranches(): Promise<GitBranch[]> {
  const output = await git(['for-each-ref', '--format=%(HEAD)\t%(refname)', 'refs/heads', 'refs/remotes'], { allowFailure: true })
  return parseBranches(output)
}

export async function gitCheckout(branch: string, create = false): Promise<void> {
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-')) throw new Error('Invalid branch name')
  if (create) {
    await git(['switch', '-c', branch])
    return
  }
  const local = (await gitBranches()).some((entry) => !entry.remote && entry.name === branch)
  if (local) await git(['switch', branch])
  else await git(['switch', '--track', branch])
}

export async function gitLog(limit = 80): Promise<GitCommit[]> {
  const output = await git(['log', `--max-count=${Math.min(Math.max(limit, 1), 500)}`, `--pretty=format:${LOG_FORMAT}`], {
    allowFailure: true
  })
  return parseLog(output)
}

async function readRevision(revision: string, relative: string): Promise<string> {
  try {
    return await git(['show', `${revision}:${relative}`])
  } catch {
    return ''
  }
}

// Returns the two sides for Monaco's diff editor. `staged` compares HEAD to the index,
// otherwise the index (or HEAD) is compared to the working tree.
export async function gitDiff(target: string, staged: boolean): Promise<GitDiffContent> {
  const relative = repoRelative(target)
  const absolute = resolveInWorkspace(target)
  if (staged) {
    return { path: absolute, original: await readRevision('HEAD', relative), modified: await readRevision('', relative) }
  }
  let modified = ''
  try {
    modified = await readFile(absolute, 'utf8')
  } catch {
    modified = ''
  }
  const indexVersion = await readRevision('', relative)
  return { path: absolute, original: indexVersion, modified }
}

export async function gitShowCommit(hash: string): Promise<string> {
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw new Error('Invalid commit')
  return git(['show', '--stat', '--patch', '--format=fuller', hash])
}

// How often each file changed recently, for the project map's heat. Paths are relative to the
// open folder, which may be a subfolder of the repository.
export async function gitChurn(limit = 120): Promise<Record<string, number>> {
  const args = ['log', `--max-count=${Math.min(Math.max(limit, 1), 1000)}`, '--no-merges', '--no-renames', '--relative', '--name-only', '-z', `--format=${CHURN_FORMAT}`]
  return parseChurn(await git(args, { allowFailure: true }), Date.now() / 1000)
}

// Tracked plus untracked-but-not-ignored files, relative to the open folder. Null outside a repo.
export async function gitListFiles(): Promise<string[] | null> {
  const inside = (await git(['rev-parse', '--is-inside-work-tree'], { allowFailure: true })).trim()
  if (inside !== 'true') return null
  const output = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'])
  return output.split('\0').filter(Boolean)
}

// Network operations are explicit user actions only. They reuse the user's own git
// credentials and never prompt inside the app.
export async function gitPull(): Promise<string> {
  return git(['pull', '--ff-only'])
}

export async function gitPush(): Promise<string> {
  const status = await gitStatus()
  if (!status.branch) throw new Error('Cannot push from a detached HEAD')
  if (status.upstream) return git(['push'])
  return git(['push', '--set-upstream', 'origin', status.branch])
}
