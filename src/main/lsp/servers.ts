import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface ServerSpec {
  id: string
  label: string
  languages: string[]
  command: string
  args: string[]
  candidates: string[]
  // Files that mark a project root. The nearest ancestor of an opened file containing one
  // becomes that server's workspace, so a parent folder holding many repositories gets one
  // server per repository instead of one huge workspace.
  rootMarkers: string[]
  // Extra install locations that toolchains use but users rarely add to PATH.
  toolchainDirs?: (env: NodeJS.ProcessEnv) => Promise<string[]>
}

const home = os.homedir()

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { env, timeout: 5000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null))
  })
}

// `go install` writes to $GOBIN, else $GOPATH/bin, else ~/go/bin. None of these are on PATH by default.
async function goBinDirs(env: NodeJS.ProcessEnv): Promise<string[]> {
  const dirs: string[] = []
  const gobin = env.GOBIN || (await run('go', ['env', 'GOBIN'], env))
  if (gobin) dirs.push(gobin)
  const gopath = env.GOPATH || (await run('go', ['env', 'GOPATH'], env))
  for (const entry of (gopath ?? '').split(':').filter(Boolean)) dirs.push(path.join(entry, 'bin'))
  dirs.push(path.join(home, 'go', 'bin'))
  return dirs
}

async function npmGlobalDirs(env: NodeJS.ProcessEnv): Promise<string[]> {
  const prefix = await run('npm', ['prefix', '-g'], env)
  return [prefix ? path.join(prefix, 'bin') : '', path.join(home, '.npm-global', 'bin'), path.join(home, 'Library', 'pnpm'), path.join(home, '.bun', 'bin')].filter(Boolean)
}

// Language servers that ship with Xcode Command Line Tools work out of the box.
// Others are picked up from the user's PATH when installed (brew, rustup, go install, npm).
export const SERVER_SPECS: ServerSpec[] = [
  {
    id: 'clangd',
    label: 'clangd',
    languages: ['c', 'cpp', 'objective-c', 'objective-cpp'],
    command: 'clangd',
    args: ['--background-index', '--header-insertion=never', '--log=error', '--pch-storage=memory'],
    rootMarkers: ['compile_commands.json', 'compile_flags.txt', 'CMakeLists.txt', 'Makefile', 'meson.build', '.clangd', '.git'],
    candidates: ['/Library/Developer/CommandLineTools/usr/bin/clangd', '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clangd', '/opt/homebrew/opt/llvm/bin/clangd']
  },
  {
    id: 'sourcekit-lsp',
    label: 'SourceKit-LSP',
    languages: ['swift'],
    command: 'sourcekit-lsp',
    args: [],
    rootMarkers: ['Package.swift', '.git'],
    candidates: ['/Library/Developer/CommandLineTools/usr/bin/sourcekit-lsp', '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/sourcekit-lsp']
  },
  {
    id: 'rust-analyzer',
    label: 'rust-analyzer',
    languages: ['rust'],
    command: 'rust-analyzer',
    args: [],
    candidates: [],
    rootMarkers: ['Cargo.toml', '.git'],
    toolchainDirs: async () => [path.join(home, '.cargo', 'bin')]
  },
  { id: 'gopls', label: 'gopls', languages: ['go'], command: 'gopls', args: [], candidates: [], rootMarkers: ['go.work', 'go.mod', '.git'], toolchainDirs: goBinDirs },
  {
    id: 'pyright',
    label: 'Pyright',
    languages: ['python'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    candidates: [],
    rootMarkers: ['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'setup.cfg', 'requirements.txt', '.git'],
    toolchainDirs: async (env) => [...(await npmGlobalDirs(env)), path.join(home, '.local', 'bin')]
  },
  {
    id: 'typescript-language-server',
    label: 'TypeScript',
    languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    candidates: [],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json', '.git'],
    toolchainDirs: npmGlobalDirs
  }
]

function which(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/which', [command], { env, timeout: 3000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null))
  })
}

async function firstExecutable(dirs: string[], command: string): Promise<string | null> {
  for (const dir of dirs) {
    const candidate = path.join(dir, command)
    try {
      await access(candidate)
      return candidate
    } catch {
      /* next */
    }
  }
  return null
}

const resolved = new Map<string, Promise<string | null>>()

export function resolveServerBinary(spec: ServerSpec, env: NodeJS.ProcessEnv): Promise<string | null> {
  let pending = resolved.get(spec.id)
  if (!pending) {
    pending = (async () => {
      for (const candidate of spec.candidates) {
        if (await firstExecutable([path.dirname(candidate)], path.basename(candidate))) return candidate
      }
      if (spec.id === 'clangd' || spec.id === 'sourcekit-lsp') {
        const fromXcrun = await run('xcrun', ['-f', spec.command], env)
        if (fromXcrun) return fromXcrun
      }
      const onPath = await which(spec.command, env)
      if (onPath) return onPath
      if (spec.toolchainDirs) return firstExecutable(await spec.toolchainDirs(env), spec.command)
      return null
    })()
    // Cache hits only; a miss is re-checked next time so installing a server takes effect without a relaunch.
    resolved.set(spec.id, pending)
    void pending.then((binary) => {
      if (!binary) resolved.delete(spec.id)
    })
  }
  return pending
}

export function specForLanguage(languageId: string): ServerSpec | undefined {
  return SERVER_SPECS.find((spec) => spec.languages.includes(languageId))
}

// Walks up from the file toward the open folder. Language markers anywhere up the chain win
// over `.git`, and within one pass the nearest directory wins, so a nested module is its own project.
export async function findProjectRoot(file: string, workspaceRoot: string, markers: string[]): Promise<string> {
  const stopAt = path.resolve(workspaceRoot)
  const strong = markers.filter((marker) => marker !== '.git')
  const passes = markers.includes('.git') ? [strong, ['.git']] : [strong]
  for (const set of passes) {
    let dir = path.dirname(path.resolve(file))
    while (dir === stopAt || dir.startsWith(`${stopAt}/`)) {
      for (const marker of set) {
        try {
          await access(path.join(dir, marker))
          return dir
        } catch {
          /* keep looking */
        }
      }
      if (dir === stopAt) break
      dir = path.dirname(dir)
    }
  }
  return stopAt
}
