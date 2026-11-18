// Opens a real parent folder in the built app and walks every map of its node library.
// Read-only: user data goes to a temp folder, and folder permission prompts are accepted there.
// Usage: npm run build && node tests/e2e/codemap-real.mjs <folder>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '../..')
const artifacts = path.join(here, 'artifacts')
mkdirSync(artifacts, { recursive: true })
if (!process.argv[2]) {
  console.error('Usage: node tests/e2e/codemap-real.mjs <folder>')
  process.exit(2)
}
const folder = path.resolve(process.argv[2])
const userData = mkdtempSync(path.join(tmpdir(), 'codemap-codemap-real-'))

const app = await electron.launch({ args: [projectRoot], env: { ...process.env, CODEMAP_E2E: '1', CODEMAP_USER_DATA: userData }, timeout: 30000 })
const page = await app.firstWindow({ timeout: 60000 })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
let failed = false
try {
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 900)
    globalThis.__asked = []
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__asked.push(options.detail.split('\n')[0])
      return { response: 0, checkboxChecked: false }
    }
  })
  await page.waitForSelector('.welcome', { timeout: 20000 })
  await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', `workspace.openRecent:${target}`), folder)
  await page.waitForSelector(`.view-title:has-text("${path.basename(folder)}")`, { timeout: 15000 })
  await page.locator('.mode-switch button[aria-label="Code Map"]').click()
  await page.waitForSelector('.cm-node', { timeout: 20000 })
  console.log('library', await page.evaluate(() => window.codemap.codemap.load().then((l) => [l.status, l.library, l.fileCount])))
  console.log('checks:', await page.locator('.cm-chip:not(.is-todo)').innerText())
  const picker = page.locator('.cm-picker .cm-select')
  const maps = await picker.locator('option').evaluateAll((els) => els.map((el) => el.value))
  for (const id of maps) {
    await picker.selectOption(id)
    await page.waitForFunction((map) => document.querySelector('.cm-picker .cm-select')?.value === map, id)
    await page.waitForTimeout(500)
    const nodes = await page.locator('.cm-node').count()
    const blank = await page.locator('.cm-canvas').evaluate((svg) => svg.getBBox().width === 0)
    await page.locator('#cm-tab-flow').click()
    const flows = await page.locator('.cm-flow-select option').count()
    console.log(`map ${id}: ${nodes} nodes, ${flows} flows, ${await page.locator('.cm-step').count()} steps in the first`)
    if (!nodes || blank) failed = true
    await page.screenshot({ path: path.join(artifacts, `codemap-real-${id}.png`) })
    // Every node with code: its excerpt must load (excerpts are collapsed rows; expand each one).
    const ids = await page.locator('.cm-node:not(.drill):not(.miss)').evaluateAll((els) => els.map((el) => el.dataset.id))
    for (const node of ids) {
      await page.locator(`.cm-node[data-id="${node}"] .cm-shape`).dispatchEvent('click')
      await page.waitForTimeout(120)
      const toggle = page.locator('.cm-detail .cm-codelink-toggle').first()
      if (!(await toggle.count())) continue
      await toggle.click()
      await page.waitForSelector('.cm-codelink.is-open .cm-src-body, .cm-codelink.is-open .cm-src-miss:not(.is-muted)', { timeout: 5000 }).catch(() => undefined)
      const miss = await page.locator('.cm-src-miss:not(.is-muted)').allInnerTexts()
      if (miss.length) {
        failed = true
        console.log(`  ${node}: ${miss.join(' | ')}`)
      }
    }
  }
  console.log('permission prompts:', await app.evaluate(() => globalThis.__asked))
  if (errors.length) {
    failed = true
    console.log('page errors:', errors.slice(0, 5))
  }
} catch (error) {
  failed = true
  console.log('FAIL', error.message)
  await page.screenshot({ path: path.join(artifacts, 'codemap-real-failure.png') }).catch(() => undefined)
} finally {
  await app.close().catch(() => undefined)
  rmSync(userData, { recursive: true, force: true })
}
console.log(failed ? 'real library: problems found' : 'real library: ok')
process.exit(failed ? 1 : 0)
