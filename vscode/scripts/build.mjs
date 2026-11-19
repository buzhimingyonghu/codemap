import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBundledWorkers } from './workerCheck.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const external = ['vscode', 'electron']
await build({
  absWorkingDir: root,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external,
  sourcemap: true,
  logLevel: 'info'
})
await build({
  absWorkingDir: root,
  entryPoints: ['src/mcp/cli.ts'],
  outfile: 'dist/codemap-mcp.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external,
  sourcemap: true,
  logLevel: 'info'
})
cpSync(resolve(root, '../agent'), resolve(root, 'dist/agent'), { recursive: true })

const vite = spawnSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.config.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
})
if (vite.status !== 0) process.exit(vite.status ?? 1)

assertBundledWorkers(root)
for (const relative of ['dist/extension.cjs', 'dist/codemap-mcp.cjs', 'dist/agent/create/SOP.md']) {
  const file = resolve(root, relative)
  if (!existsSync(file)) throw new Error(`Missing packaged file: ${relative}`)
}
