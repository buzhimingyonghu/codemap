// node-pty's npm package ships its macOS `spawn-helper` without the execute bit, so every
// terminal fails with "posix_spawnp failed". Restore it after install.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds')
if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, platform, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
for (const dir of ['build/Release', 'build/Debug']) {
  const helper = path.join(root, 'node_modules', 'node-pty', dir, 'spawn-helper')
  if (existsSync(helper)) chmodSync(helper, 0o755)
}
