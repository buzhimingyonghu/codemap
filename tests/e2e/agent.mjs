// End-to-end test for the built-in AI assistant, against the local model gateway.
// Opens a copy of the demo library, asks a question (the map must follow), then asks for a
// rename (a change set must appear on the map and apply).
// Usage: npm run build && node tests/e2e/agent.mjs
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '../..')
const artifacts = path.join(here, 'artifacts')
mkdirSync(artifacts, { recursive: true })

const work = mkdtempSync(path.join(tmpdir(), 'codemap-agent-e2e-'))
const folder = path.join(work, 'shop')
const library = path.join(folder, 'library')
const userData = path.join(work, 'user-data')
mkdirSync(userData, { recursive: true })
const demo = path.join(projectRoot, 'tests/fixtures/codemap-demo')
cpSync(path.join(demo, 'library'), library, { recursive: true })
cpSync(path.join(demo, 'demo-repos'), path.join(folder, 'demo-repos'), { recursive: true })

const results = []
let page
const step = async (name, fn) => {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log('  ok  ' + name)
  } catch (error) {
    results.push({ name, ok: false })
    console.log('  FAIL ' + name + ': ' + error.message)
    await page?.screenshot({ path: path.join(artifacts, 'agent-failure.png') }).catch(() => undefined)
  }
}

const app = await electron.launch({ args: [projectRoot], env: { ...process.env, CODEMAP_E2E: '1', CODEMAP_USER_DATA: userData }, timeout: 30000 })
page = await app.firstWindow({ timeout: 60000 })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const shot = (name) => page.screenshot({ path: path.join(artifacts, name + '.png') })

try {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(1440, 900)
    window.center()
  })
  await page.waitForSelector('.welcome', { timeout: 20000 })

  await step('open the code map and the AI tab', async () => {
    await app.evaluate(({ BrowserWindow }, dir) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'workspace.openRecent:' + dir)
    }, folder)
    await page.waitForSelector('.view-title:has-text("shop")', { timeout: 15000 })
    await page.locator('.mode-switch button[aria-label="Code Map"]').click()
    await page.waitForSelector('.cm-node', { timeout: 15000 })
    await page.locator('#cm-tab-ai').click()
    await page.waitForSelector('.ag', { timeout: 5000 })
    await shot('agent-01-tab')
  })

  await step('build map: pick repositories and knowledge, guide shown', async () => {
    await page.locator('.ag-modes button', { hasText: /Build map/ }).click()
    await page.waitForSelector('.ag-sources.is-open', { timeout: 5000 })
    if (!(await page.locator('.ag-guide li').count())) throw new Error('No description guide')
    if (!(await page.locator('.ag-compose-bar .button--primary').isDisabled())) throw new Error('Send should wait for a repository')
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
    }, path.join(folder, 'demo-repos'))
    await page.locator('.ag-sources-add').first().click()
    await page.waitForSelector('.ag-source:has-text("demo-repos")', { timeout: 5000 })
    await page.locator('.ag-link-input').fill('https://wiki.example.com/p/2002')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.ag-source:has-text("wiki.example.com")', { timeout: 5000 })
    await page.locator('.ag-input').fill('test')
    if (await page.locator('.ag-compose-bar .button--primary').isDisabled()) throw new Error('Send should be enabled')
    await page.locator('.ag-input').fill('')
    await shot('agent-00-build')
    await page.locator('.ag-modes button', { hasText: /^Ask$/ }).click()
    if (await page.locator('.ag-sources').count()) throw new Error('Ask mode should not show repositories and knowledge')
  })

  await step('settings show the local gateway as connected', async () => {
    const s = await page.evaluate(() => window.codemap.agent.settings())
    const tt = s.providers.find((p) => p.id === 'local-gateway')
    if (!tt?.hasKey) throw new Error('Local gateway not detected')
  })

  await step('ask: the answer streams in and the map follows', async () => {
    await page.locator('.ag-modes button', { hasText: /^Ask$/ }).click()
    await page.locator('.ag-input').fill('下单时库存不足会怎么样？用两句话回答，并在地图上指出相关节点。')
    await page.locator('.ag-compose-bar .button--primary').click()
    await page.waitForSelector('.ag-steps', { timeout: 60000 })
    await page.waitForFunction(() => !document.querySelector('.ag-compose-bar .button:not(.button--primary)'), null, { timeout: 180000 })
    const text = await page.locator('.ag-msg.is-assistant .ag-text').last().innerText()
    if (!text.trim()) throw new Error('Empty answer')
    const lit = await page.locator('.cm-node.agent').count()
    const crumbs = await page.locator('.cm-crumb').allInnerTexts()
    console.log('    answer:', text.slice(0, 160).replace(/\n/g, ' '))
    console.log('    lit nodes:', lit, 'map:', crumbs.join(' > '))
    if (!lit) throw new Error('No node is lit on the map')
    await shot('agent-02-ask')
  })

  await step('adjust: a change set previews on the map and applies', async () => {
    await page.locator('.ag-head-tools button').nth(1).click()
    await page.locator('.ag-modes button', { hasText: /Adjust map/ }).click()
    await page.locator('.ag-input').fill('把 order-svc 里「落库」这个节点改名为「保存订单」，其他不动。')
    await page.locator('.ag-compose-bar .button--primary').click()
    await page.waitForSelector('.ag-set.is-proposed', { timeout: 180000 })
    await page.waitForFunction(() => !document.querySelector('.ag-compose-bar .button:not(.button--primary)'), null, { timeout: 180000 })
    const marked = await page.locator('.cm-node.req-mod').count()
    console.log('    nodes marked as changed on the map:', marked)
    await shot('agent-03-proposal')
    await page.locator('.ag-set.is-proposed').last().locator('.ag-set-actions .button--primary').click()
    await page.waitForSelector('.ag-set.is-applied', { timeout: 10000 })
    const text = readFileSync(path.join(library, 'order-svc/order-svc.yaml'), 'utf8')
    if (!text.includes('保存订单')) throw new Error('The rename was not written')
    if (!text.includes('# 第二个入口：消费支付成功事件')) throw new Error('Comments were lost')
    await page.waitForSelector('.cm-node:has-text("保存订单")', { timeout: 10000 })
    await shot('agent-04-applied')
  })

  await step('conversations are kept', async () => {
    const list = await page.evaluate(() => window.codemap.agent.sessions())
    if (list.length < 2) throw new Error('Expected two conversations, got ' + list.length)
  })

  await step('no page errors', async () => {
    if (errors.length) throw new Error(errors.join(' | '))
  })
} finally {
  await app.close()
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length ? failed.length + ' failed' : 'all passed')
process.exit(failed.length ? 1 : 0)
