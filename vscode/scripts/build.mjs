import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBundledWorkers } from './workerCheck.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await build({
  absWorkingDir: root,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info'
})

const vite = spawnSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.config.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
})
if (vite.status !== 0) process.exit(vite.status ?? 1)

assertBundledWorkers(root)
