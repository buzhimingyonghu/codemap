import { execFile } from 'node:child_process'

// Apps launched from Finder get a minimal PATH. Load the login shell environment once so
// build commands find Homebrew, nvm, cargo, and friends just like in Terminal.
let cached: Promise<NodeJS.ProcessEnv> | null = null

const FALLBACK_PATH = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

function withFallbackPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const parts = new Set((env.PATH ?? '').split(':').filter(Boolean))
  for (const entry of FALLBACK_PATH) parts.add(entry)
  return { ...env, PATH: [...parts].join(':') }
}

function loadShellEnv(): Promise<NodeJS.ProcessEnv> {
  const shellPath = process.env.SHELL || '/bin/zsh'
  const marker = '__CODEMAP_ENV__'
  return new Promise((resolve) => {
    execFile(
      shellPath,
      ['-ilc', `printf '${marker}'; /usr/bin/env -0; printf '${marker}'`],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CODEMAP_RESOLVING_ENV: '1' } },
      (error, stdout) => {
        if (error) return resolve(withFallbackPath(process.env))
        const start = stdout.indexOf(marker)
        const end = stdout.lastIndexOf(marker)
        if (start < 0 || end <= start) return resolve(withFallbackPath(process.env))
        const env: NodeJS.ProcessEnv = {}
        for (const pair of stdout.slice(start + marker.length, end).split('\0')) {
          const index = pair.indexOf('=')
          if (index > 0) env[pair.slice(0, index)] = pair.slice(index + 1)
        }
        delete env.CODEMAP_RESOLVING_ENV
        resolve(withFallbackPath({ ...process.env, ...env }))
      }
    )
  })
}

export function getShellEnv(): Promise<NodeJS.ProcessEnv> {
  cached ??= loadShellEnv()
  return cached
}
