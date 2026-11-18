// Builds build/icon.icns from scripts/icon.html using only Electron and macOS tools.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const png = path.join(root, 'build', 'icon.png')
const iconset = path.join(root, 'build', 'icon.iconset')

execFileSync(electronPath, [path.join(root, 'scripts', 'render-icon.cjs')], { stdio: 'inherit' })
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const pixels = size * scale
    const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`
    execFileSync('sips', ['-z', String(pixels), String(pixels), png, '--out', path.join(iconset, name)], { stdio: 'ignore' })
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'build', 'icon.icns')], { stdio: 'inherit' })
rmSync(iconset, { recursive: true, force: true })
console.log('build/icon.icns')
