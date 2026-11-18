// End-to-end test for the code map: opens a parent folder holding a node library and
// its repositories, then drives the real app (maps, flows, details, code, permissions).
// Usage: npm run build && node tests/e2e/codemap.mjs
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '../..')
const artifacts = path.join(here, 'artifacts')
mkdirSync(artifacts, { recursive: true })

// work/
//   shop/                the folder opened in Codemap (like ~/dev/shop)
//     library/           node library (copied from the demo library)
//     demo-repos/        repositories for most nodes
//   outside/monorepo/    one repository outside the open folder (like the Go module cache)
const work = mkdtempSync(path.join(tmpdir(), 'codemap-codemap-'))
const shop = path.join(work, 'shop')
const library = path.join(shop, 'library')
const outside = path.join(work, 'outside')
const userData = path.join(work, 'user-data')
mkdirSync(userData, { recursive: true })
const demo = path.join(projectRoot, 'tests/fixtures/codemap-demo')
cpSync(path.join(demo, 'library'), library, { recursive: true })
cpSync(path.join(demo, 'demo-repos'), path.join(shop, 'demo-repos'), { recursive: true })
mkdirSync(outside, { recursive: true })
cpSync(path.join(demo, 'demo-repos/monorepo'), path.join(outside, 'monorepo'), { recursive: true })
rmSync(path.join(shop, 'demo-repos/monorepo'), { recursive: true, force: true })
// repo.local is relative to the YAML's folder: point inventory at the repository outside shop/.
const outsideRel = '../../../outside/monorepo'
const inventory = path.join(library, 'inventory-svc/inventory-svc.yaml')
writeFileSync(inventory, readFileSync(inventory, 'utf8').replace('../../demo-repos/monorepo', outsideRel))
const inventoryLinks = path.join(library, 'inventory-svc/links.yaml')
writeFileSync(inventoryLinks, readFileSync(inventoryLinks, 'utf8').replaceAll('../../demo-repos/monorepo', outsideRel))
// Give one edge two links, so the edge detail lists several collapsible link rows.
const systemMap = path.join(library, 'order-system/order-system.yaml')
writeFileSync(
  systemMap,
  readFileSync(systemMap, 'utf8').replace(
    '{ from: order-svc, to: inventory-svc, kind: call, via: inventory-svc.LockStock }',
    '{ from: order-svc, to: inventory-svc, kind: call, via: [inventory-svc.LockStock, inventory-svc.AddStock] }'
  )
)

const results = []
let page
const step = async (name, fn) => {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ok  ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`  FAIL ${name}: ${error.message}`)
    await page?.screenshot({ path: path.join(artifacts, 'codemap-failure.png') }).catch(() => undefined)
  }
}

const app = await electron.launch({ args: [projectRoot], env: { ...process.env, CODEMAP_E2E: '1', CODEMAP_USER_DATA: userData }, timeout: 30000 })
page = await app.firstWindow({ timeout: 60000 })
const consoleErrors = []
page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()))
page.on('pageerror', (error) => consoleErrors.push(error.message))
const shot = (name) => page.screenshot({ path: path.join(artifacts, `${name}.png`) })
// Answers the next native message box (the permission prompt) with `button`.
const answerDialog = (button) =>
  app.evaluate(({ dialog }, choice) => {
    globalThis.__dialogs = globalThis.__dialogs ?? []
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__dialogs.push(options.message)
      globalThis.__dialogOptions = options
      return { response: choice, checkboxChecked: false }
    }
  }, button)
const dialogs = () => app.evaluate(() => globalThis.__dialogs ?? [])
const openTab = (name) => page.locator(`.cm-tab[aria-controls="cm-tabpanel"]#cm-tab-${name}`).click()
// The editor layer must actually be on screen (opaque and on top), not just have an active tab.
const editorVisible = () =>
  page.waitForFunction(
    () => {
      const layer = document.querySelector('.code-map .map-editor')
      if (!layer) return false
      const style = getComputedStyle(layer)
      const rect = layer.getBoundingClientRect()
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return Number(style.opacity) > 0.95 && style.pointerEvents !== 'none' && Boolean(top && layer.contains(top))
    },
    null,
    { timeout: 5000 }
  )

try {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(1440, 900)
    window.center()
  })
  await page.waitForSelector('.welcome', { timeout: 20000 })
  await answerDialog(1)

  await step('open the parent folder and switch to the code map', async () => {
    await app.evaluate(({ BrowserWindow }, folder) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:command', `workspace.openRecent:${folder}`)
    }, shop)
    await page.waitForSelector('.view-title:has-text("shop")', { timeout: 15000 })
    await page.locator('.mode-switch button[aria-label="Code Map"]').click()
    await page.waitForSelector('.cm-node', { timeout: 15000 })
    const crumbs = await page.locator('.cm-crumb').allInnerTexts()
    if (!crumbs.join(' ').includes('订单系统')) throw new Error(`Expected the order system map, got ${crumbs}`)
    await page.locator('.cm-chip:not(.is-todo)').waitFor()
    await shot('codemap-01-system')
  })

  await step('play the order flow across a component', async () => {
    // The flow lives in the right-hand Flow tab: pick it, step twice from the canvas control.
    await openTab('flow')
    await page.locator('.cm-flow-select').selectOption({ label: '下单' })
    await page.locator('.cm-playpad button[aria-label="Next Step"]').click()
    await page.waitForFunction(() => document.querySelector('.cm-playpad-progress')?.textContent?.trim().startsWith('1 /'), null, { timeout: 5000 })
    await page.locator('.cm-playpad button[aria-label="Next Step"]').click()
    await page.waitForFunction(() => document.querySelector('.cm-playpad-progress')?.textContent?.trim().startsWith('2 /'), null, { timeout: 5000 })
    // The current step is highlighted in the list and expanded in place.
    await page.waitForSelector('.cm-step.is-current .cm-step-detail', { timeout: 5000 })
    if ((await page.locator('.cm-step').count()) < 3) throw new Error('The step list is not shown')
    if ((await page.locator('.cm-step.is-current .cm-step-no').innerText()) !== '2') throw new Error('Step 2 is not current')
    // Clicking another step jumps to it.
    await page.locator('.cm-step-row').nth(3).click()
    await page.waitForSelector('.cm-step:nth-child(4).is-current', { timeout: 5000 })
    await shot('codemap-02-flow')
  })

  await step('enter a component and see its code', async () => {
    // A single click only shows the details; a double-click goes in.
    await page.locator('.cm-node[data-id="order-svc"]').click()
    await page.waitForSelector('.cm-detail .cm-go', { timeout: 5000 })
    await page.waitForTimeout(400)
    if (![...(await page.locator('.cm-crumb').allInnerTexts())].join(' ').includes('订单系统')) throw new Error('A single click left the map')
    if ((await page.locator('.cm-crumb').count()) !== 1) throw new Error('A single click entered the node')
    await page.locator('.cm-node[data-id="order-svc"]').dblclick()
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-crumb')].some((el) => el.textContent?.includes('订单服务')), null, { timeout: 5000 })
    await page.waitForFunction(() => !document.querySelector('.cm-vp')?.style.opacity, null, { timeout: 5000 })
    await page.locator('.cm-node[data-id="order-svc.validate"]').click()
    // The code shows as one row; clicking it expands the excerpt in place.
    await page.locator('.cm-detail .cm-codelink-toggle').first().click()
    await page.waitForSelector('.cm-src tr.is-hl', { timeout: 5000 })
    const first = await page.locator('.cm-src tr.is-hl td').nth(1).innerText()
    if (!first.trim()) throw new Error('Anchored code line is empty')
    await shot('codemap-03-component')
  })

  await step('open the anchored code in the editor and come back', async () => {
    await page.locator('.cm-detail .cm-codelink-row button[aria-label="Open in Editor"]').first().click()
    await page.waitForSelector('.code-map.is-editing .tab.is-active:has-text("validate.go")', { timeout: 5000 })
    await editorVisible()
    await page.keyboard.press('Escape')
    await page.waitForSelector('.code-map:not(.is-editing)', { timeout: 5000 })
  })

  await step('show the editor code in the code map', async () => {
    await page.locator('.cm-src-head button[aria-label="Open in Editor"]').first().click()
    await page.waitForSelector('.code-map.is-editing', { timeout: 5000 })
    await page.waitForFunction(() => window.__codemapTest.placeCursor('func', 0), null, { timeout: 5000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'codemap.reveal'))
    await page.waitForSelector('.code-map:not(.is-editing) .cm-node.focus', { timeout: 5000 })
  })

  await step('a repository outside the folder asks for permission', async () => {
    // inventory-svc's code lives outside the open folder; its data types point into it.
    await page.locator('.cm-picker .cm-select').selectOption('order-svc')
    await page.waitForSelector('.cm-node[data-id="lock-stock"], .cm-node[data-id="order-svc.lock-stock"]', { timeout: 5000 })
    // A curve's bounding-box center is usually off the line, so dispatch the click on the path.
    await page.locator('.cm-hit[data-key*="inventory-svc"]').first().dispatchEvent('click')
    // A data card's code row expands into an excerpt; reading it outside the folder asks first.
    const footer = page.locator('.cm-codelink--foot .cm-codelink-toggle', { hasText: 'inventory' }).first()
    await footer.waitFor({ timeout: 5000 })
    // The first prompt is declined (button 1): the excerpt offers "Allow Reading" instead.
    await footer.click()
    await page.waitForSelector('.cm-codelink.is-open .cm-src-miss button', { timeout: 5000 })
    if (!(await dialogs()).length) throw new Error('No permission dialog was shown')
    await answerDialog(0)
    await page.locator('.cm-codelink.is-open .cm-src-miss button').click()
    await page.waitForSelector('.cm-codelink.is-open .cm-src tr.is-hl', { timeout: 5000 })
    const code = await page.locator('.cm-codelink.is-open .cm-src tr.is-hl').first().innerText()
    if (!code.includes('LockStock')) throw new Error(`Unexpected excerpt: ${code}`)
    await shot('codemap-04-data-excerpt')
    // Only one excerpt is open at a time.
    const second = page.locator('.cm-codelink--foot .cm-codelink-toggle').nth(1)
    await second.click()
    if ((await page.locator('.cm-codelink.is-open').count()) !== 1) throw new Error('More than one excerpt is open')
    await page.locator('.cm-codelink.is-open .cm-src-head button[aria-label="Open in Editor"]').click()
    await page.waitForSelector('.code-map.is-editing .tab.is-active:has-text("inventory.proto")', { timeout: 5000 })
    await editorVisible()
    const grants = await page.evaluate(() => window.codemap.codemap.grants())
    if (!grants.some((g) => g.endsWith('/outside/monorepo'))) throw new Error(`Unexpected grants ${grants}`)
    await shot('codemap-04-granted')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.code-map:not(.is-editing)', { timeout: 5000 })
  })

  await step('requirement layer shows changes and badges', async () => {
    await page.locator('.cm-picker .cm-select').selectOption('order-system')
    await page.waitForSelector('.cm-node[data-id="order-svc"]', { timeout: 5000 })

    // Edge detail: one collapsible row per link; rows open in place, several at once, and the
    // link name no longer navigates away.
    await page.locator('.cm-hit[data-key="order-svc->inventory-svc"]').dispatchEvent('click')
    await page.waitForSelector('.cm-detail .cm-apilist .cm-api', { timeout: 5000 })
    const rows = page.locator('.cm-detail .cm-api')
    if ((await rows.count()) !== 2) throw new Error(`Expected 2 link rows, got ${await rows.count()}`)
    if (await page.locator('.cm-detail .cm-api.is-open').count()) throw new Error('Link rows should start collapsed')
    if (await page.locator('.cm-detail .cm-dblock').count()) throw new Error('Data cards should be inside the rows')
    await rows.nth(0).locator('.cm-api-toggle').click()
    await rows.nth(1).locator('.cm-api-toggle').click()
    if ((await page.locator('.cm-detail .cm-api.is-open').count()) !== 2) throw new Error('Both link rows should be open')
    if ((await page.locator('.cm-detail .cm-title').first().innerText()).includes('LockStock')) throw new Error('Clicking a link jumped away')
    await rows.nth(0).locator('.cm-dblock').first().waitFor({ timeout: 5000 })
    await shot('codemap-04b-edge-links')
    await rows.nth(1).locator('.cm-api-toggle').click()
    if ((await page.locator('.cm-detail .cm-api.is-open').count()) !== 1) throw new Error('A row did not collapse')

    await openTab('req')
    await page.locator('.cm-req-toggle').first().click()
    await page.waitForSelector('.cm-node[data-id="order-svc"] .cm-badge', { timeout: 5000 })
    await shot('codemap-05-requirement')
    await page.locator('.cm-req-toggle').first().click()
    await page.waitForSelector('.cm-node[data-id="order-svc"] .cm-badge', { state: 'detached', timeout: 5000 })
  })

  await step('requirement report: changes by map, impact, neighbours', async () => {
    await page.locator('.cm-req-open').first().click()
    await page.waitForSelector('.cm-report', { timeout: 5000 })
    // Opening the report turns the layer on.
    await page.waitForSelector('.cm-node[data-id="order-svc"] .cm-badge', { timeout: 5000 })
    const maps = await page.locator('.cm-change-map').allInnerTexts()
    if (maps.length < 2) throw new Error(`Expected changes on several maps, got ${maps}`)
    if (!(await page.locator('.cm-neighbor').count())) throw new Error('No upstream / downstream listed')
    // A change with proposed code expands to show it.
    const withCode = page.locator('.cm-change', { hasText: '校验优惠券' }).first()
    await withCode.locator('.cm-change-toggle').click()
    await withCode.locator('.cm-change-body .is-add').first().waitFor({ timeout: 5000 })
    // Locating a change opens its map and selects the node.
    await withCode.locator('button[aria-label="Show on the map"]').click()
    await page.waitForSelector('.cm-node.focus[data-id="order-svc.check-coupon"]', { timeout: 5000 })
    await shot('codemap-05b-report')
    await page.locator('.cm-report-back').click()
    await page.locator('.cm-req-toggle').first().click()
  })

  await step('function map: struct card fills while the flow plays', async () => {
    await page.locator('.cm-picker .cm-select').selectOption('order-svc.build-order')
    await openTab('flow')
    await page.waitForSelector('.cm-struct .cm-field', { timeout: 5000 })
    // Each step animates; wait for it before the next click.
    for (let i = 1; i <= 8; i++) {
      await page.locator('.cm-playpad button[aria-label="Next Step"]').click()
      await page.waitForFunction((n) => document.querySelector('.cm-playpad-progress')?.textContent?.trim().startsWith(`${n} /`), i, { timeout: 5000 })
    }
    await page.waitForSelector('.cm-field.is-on', { timeout: 5000 })
    await page.locator('.cm-field').first().click()
    await page.waitForSelector('.cm-node.trace', { timeout: 5000 })
    await shot('codemap-06-function')
  })

  await step('edit layout: drag nodes and edge ends, then save once into the map YAML', async () => {
    const file = path.join(library, 'order-svc/order-svc.yaml')
    const original = readFileSync(file, 'utf8')
    await page.locator('.cm-picker .cm-select').selectOption('order-svc')
    await page.waitForSelector('.cm-node[data-id="order-svc.save"]', { timeout: 5000 })
    await page.waitForTimeout(600)
    const nodeBox = async (id) => page.locator(`.cm-node[data-id="${id}"] .cm-shape`).boundingBox()
    const edgePath = (key) => page.locator(`path.cm-edge[data-key="${key}"]`).getAttribute('d')
    const dragNode = async (id, dx, dy) => {
      const b = await nodeBox(id)
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
      await page.mouse.down()
      for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width / 2 + (i * dx) / 8, b.y + b.height / 2 + (i * dy) / 8)
      await page.mouse.up()
    }
    const waitFile = async (test, what) => {
      const deadline = Date.now() + 5000
      while (!test(readFileSync(file, 'utf8')) && Date.now() < deadline) await page.waitForTimeout(100)
      if (!test(readFileSync(file, 'utf8'))) {
        const bar = await page.locator('.cm-editbar').innerText().catch(() => '(no edit bar)')
        const toast = await page.locator('.toast, .notification').allInnerTexts().catch(() => [])
        throw new Error(`${what}\nbar: ${bar}\ntoasts: ${toast.join(' | ')}\nfile:\n${readFileSync(file, 'utf8').slice(0, 1500)}`)
      }
    }

    // Not editing: dragging a node only pans the map; nodes keep their places relative to each other.
    const gapOf = async () => {
      const [x, y] = [await nodeBox('order-svc.save'), await nodeBox('order-svc.validate')]
      return [x.x - y.x, x.y - y.y]
    }
    const gap0 = await gapOf()
    const idle = await nodeBox('order-svc.save')
    await page.mouse.move(idle.x + 20, idle.y + 15)
    await page.mouse.down()
    await page.mouse.move(idle.x + 140, idle.y + 95, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const gap1 = await gapOf()
    if (Math.abs(gap1[0] - gap0[0]) > 2 || Math.abs(gap1[1] - gap0[1]) > 2) throw new Error('A node moved outside edit mode')
    if (readFileSync(file, 'utf8') !== original) throw new Error('The file changed outside edit mode')
    await page.locator('.cm-canvas-actions button[aria-label="Fit Map"]').click()
    await page.waitForTimeout(450)

    await page.locator('.cm-canvas-actions button[aria-label="Edit Layout"]').click()
    await page.waitForSelector('.cm-editbar', { timeout: 5000 })
    if (!(await page.locator('.cm-canvas.is-editing').count())) throw new Error('The canvas is not in edit mode')

    const before = await nodeBox('order-svc.save')
    const edgeBefore = await edgePath('order-svc.build-order->order-svc.save')
    await dragNode('order-svc.save', 120, 80)
    const after = await nodeBox('order-svc.save')
    if (Math.abs(after.x - before.x) < 60) throw new Error(`Node did not move: ${before.x} → ${after.x}`)
    if ((await edgePath('order-svc.build-order->order-svc.save')) === edgeBefore) throw new Error('The edge did not follow the node')
    if ((await page.locator('.cm-detail .cm-title').first().innerText()).includes('落库')) throw new Error('A drag opened the node')
    // Drags only change the draft.
    await page.waitForTimeout(500)
    if (readFileSync(file, 'utf8') !== original) throw new Error('A drag wrote the file before Save')
    if (!(await page.locator('.cm-editbar-tag').innerText()).includes('unsaved')) throw new Error('No unsaved mark')

    // Select an edge: big handles sit exactly on both ends of the line as drawn.
    await page.locator('.cm-hit[data-key="order-svc.build-order->order-svc.save"]').dispatchEvent('click')
    await page.waitForSelector('.cm-port', { timeout: 5000 })
    const ends = await page.evaluate(() => {
      const el = document.querySelector('path.cm-edge[data-key="order-svc.build-order->order-svc.save"]')
      const len = el.getTotalLength()
      const m = el.getScreenCTM()
      const pt = (p) => ({ x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f })
      const dots = [...document.querySelectorAll('.cm-port-dot')].map((d) => {
        const r = d.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, size: r.width }
      })
      return { line: [pt(el.getPointAtLength(0)), pt(el.getPointAtLength(len))], dots }
    })
    for (let i = 0; i < 2; i++) {
      const d = Math.hypot(ends.dots[i].x - ends.line[i].x, ends.dots[i].y - ends.line[i].y)
      if (d > 1.5) throw new Error(`Handle ${i} is ${d.toFixed(1)}px off the line end`)
      if (ends.dots[i].size < 10) throw new Error(`Handle ${i} is too small: ${ends.dots[i].size}px`)
    }
    await shot('codemap-07-editing')
    const handle = await page.locator('.cm-port[data-end="1"] .cm-port-dot').boundingBox()
    const target = await nodeBox('order-svc.save')
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x - 2, target.y + target.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    if (readFileSync(file, 'utf8') !== original) throw new Error('A port drag wrote the file before Save')

    // ⌘Z undoes the port change in the draft, then Save writes the node move only.
    await page.locator('.cm-canvas').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Meta+z')
    await page.locator('.cm-hit[data-key="order-svc.build-order->order-svc.save"]').dispatchEvent('click')
    await page.waitForSelector('.cm-port', { timeout: 5000 })
    const handle2 = await page.locator('.cm-port[data-end="1"] .cm-port-dot').boundingBox()
    const target2 = await nodeBox('order-svc.save')
    await page.mouse.move(handle2.x + handle2.width / 2, handle2.y + handle2.height / 2)
    await page.mouse.down()
    await page.mouse.move(target2.x - 2, target2.y + target2.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.locator('.cm-editbar button:has-text("Save")').click()
    await waitFile((t) => /^layout:/m.test(t) && /ports: \[auto, left\]/.test(t), 'Save did not write layout and ports')
    const text = readFileSync(file, 'utf8')
    const layoutBlock = text.slice(text.indexOf('layout:'), text.indexOf('\n\n', text.indexOf('layout:')))
    if (!/\n  save: \[-?\d+, -?\d+\]/.test(layoutBlock) || !/\n  validate: \[/.test(layoutBlock)) throw new Error(`Unexpected layout block:\n${layoutBlock}`)
    const comments = (s) => s.split('\n').filter((l) => l.includes('#'))
    if (comments(text).join('\n') !== comments(original).join('\n')) throw new Error('Comments changed')
    await page.waitForSelector('.cm-editbar', { state: 'detached', timeout: 5000 })
    // No reload jump: the node stays where it was dropped.
    await page.waitForTimeout(800)
    const settled = await nodeBox('order-svc.save')
    if (Math.abs(settled.x - after.x) > 2 || Math.abs(settled.y - after.y) > 2) throw new Error('The map jumped after saving')
    await shot('codemap-07-dragged')

    // Cancel drops a draft; Reset Layout + Save restores the original file exactly.
    await page.locator('.cm-canvas-actions button[aria-label="Edit Layout"]').click()
    const saved = readFileSync(file, 'utf8')
    const beforeCancel = await nodeBox('order-svc.save')
    await dragNode('order-svc.save', -100, 0)
    await page.locator('.cm-editbar button:has-text("Cancel")').click()
    await page.waitForTimeout(300)
    const cancelled = await nodeBox('order-svc.save')
    if (Math.abs(cancelled.x - beforeCancel.x) > 2) throw new Error('Cancel did not put the node back')
    if (readFileSync(file, 'utf8') !== saved) throw new Error('Cancel changed the file')
    await page.locator('.cm-canvas-actions button[aria-label="Edit Layout"]').click()
    await page.locator('.cm-editbar button[aria-label="Reset Layout"]').click()
    await page.locator('.cm-editbar button:has-text("Save")').click()
    await waitFile((t) => t === original, 'Reset + Save did not restore the file')

    // With the requirement layer on: editing turns it off (positions belong to the base map),
    // port drags show at once, Cancel puts everything back and turns the layer on again.
    await openTab('req')
    const reqToggle = page.locator('.cm-req-toggle').first()
    if ((await reqToggle.getAttribute('aria-checked')) !== 'true') await reqToggle.click()
    await page.waitForFunction(() => document.querySelector('.cm-req-toggle')?.getAttribute('aria-checked') === 'true', null, { timeout: 5000 })
    await page.locator('.cm-canvas-actions button[aria-label="Edit Layout"]').click()
    await page.waitForFunction(() => document.querySelector('.cm-req-toggle')?.getAttribute('aria-checked') === 'false', null, { timeout: 5000 })
    const reqLine0 = await edgePath('order-svc.build-order->order-svc.save')
    const reqNode0 = await nodeBox('order-svc.save')
    await page.locator('.cm-hit[data-key="order-svc.build-order->order-svc.save"]').dispatchEvent('click')
    await page.waitForSelector('.cm-port', { timeout: 5000 })
    const h3 = await page.locator('.cm-port[data-end="1"] .cm-port-dot').boundingBox()
    const t3 = await nodeBox('order-svc.save')
    await page.mouse.move(h3.x + h3.width / 2, h3.y + h3.height / 2)
    await page.mouse.down()
    await page.mouse.move(t3.x + t3.width / 2, t3.y - 3, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    if ((await edgePath('order-svc.build-order->order-svc.save')) === reqLine0) throw new Error('The edge end did not move while editing')
    await dragNode('order-svc.save', 90, 40)
    await page.locator('.cm-editbar button:has-text("Cancel")').click()
    await page.waitForTimeout(400)
    const reqNode1 = await nodeBox('order-svc.save')
    if (Math.abs(reqNode1.x - reqNode0.x) > 2 || Math.abs(reqNode1.y - reqNode0.y) > 2) throw new Error('Cancel left the node where it was dragged')
    await openTab('req')
    await page.waitForFunction(() => document.querySelector('.cm-req-toggle')?.getAttribute('aria-checked') === 'true', null, { timeout: 5000 })
    if (readFileSync(file, 'utf8') !== original) throw new Error('Cancel with the requirement layer changed the file')
    await reqToggle.click()
    await page.waitForFunction(() => document.querySelector('.cm-req-toggle')?.getAttribute('aria-checked') === 'false', null, { timeout: 5000 })

    // Leaving with unsaved changes asks first (Return keeps editing); "Don't Save" drops them.
    await page.locator('.cm-canvas-actions button[aria-label="Edit Layout"]').click()
    await dragNode('order-svc.save', 80, 0)
    await answerDialog(1)
    await page.locator('.cm-picker .cm-select').selectOption('order-system')
    await page.waitForSelector('.cm-editbar', { state: 'detached', timeout: 5000 })
    if (readFileSync(file, 'utf8') !== original) throw new Error("Don't Save changed the file")
    const asked = await app.evaluate(() => globalThis.__dialogOptions)
    if (asked?.defaultId !== 2 || asked?.buttons?.[2] !== 'Cancel') throw new Error(`The leave prompt should default to Cancel: ${JSON.stringify(asked)}`)
  })

  await step('flow modes and heartbeats on business lines', async () => {
    await page.locator('.cm-picker .cm-select').selectOption('order-system')
    await page.waitForSelector('.cm-node[data-id="order-system.registry"]', { timeout: 5000 })
    await page.waitForTimeout(400)
    const active = () => page.locator('.cm-amb.is-active').count()
    // Focus (default): at rest no balls run, lines carrying data show the faint hint.
    if (!(await page.locator('.cm-canvas.flow-focus').count())) throw new Error('Focus is not the default flow mode')
    await page.locator('.cm-canvas').click({ position: { x: 5, y: 5 } })
    await page.mouse.move(2, 2)
    await page.waitForTimeout(200)
    if (await active()) throw new Error(`Balls run at rest: ${await active()}`)
    if (!(await page.locator('.cm-edge-hint').count())) throw new Error('No direction hints on lines')
    // Hover a node: only its outbound balls run.
    const box = await page.locator('.cm-node[data-id="order-svc"] .cm-shape').boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(200)
    const hovered = await page.evaluate(() => [...document.querySelectorAll('.cm-amb.is-active')].map((el) => el.dataset.key))
    const linked = await page.evaluate(() => [...document.querySelectorAll('path.cm-edge.is-linked')].map((el) => el.dataset.key))
    if (!hovered.length || !hovered.every((k) => linked.includes(k))) throw new Error(`Hover ran other balls: ${hovered}`)
    if (await page.locator('.cm-amb.is-active .cm-ball--ack').count()) throw new Error('Replies run on hover')
    // A selected line runs its request and its reply.
    await page.mouse.move(2, 2)
    await page.locator('.cm-hit[data-key="order-svc->inventory-svc"]').dispatchEvent('click')
    await page.waitForTimeout(200)
    const sel = await page.evaluate(() => [...document.querySelectorAll('.cm-amb.is-active')].map((el) => el.dataset.key))
    if (!sel.length || !sel.every((k) => k === 'order-svc->inventory-svc')) throw new Error(`Selected line balls: ${sel}`)
    if (!(await page.locator('.cm-amb.is-active .cm-ball--ack').count())) throw new Error('The selected line shows no reply')
    // All: every ball runs; Off: none.
    await page.locator('.cm-flowmode button:has-text("All")').click()
    await page.locator('.cm-canvas').click({ position: { x: 5, y: 5 } })
    if ((await active()) !== (await page.locator('.cm-amb').count())) throw new Error('All mode does not run every ball')
    await page.locator('.cm-flowmode button:has-text("Off")').click()
    if (await page.locator('.cm-amb:visible').count()) throw new Error('Off mode still shows balls')
    await page.locator('.cm-flowmode button:has-text("Focus")').click()
    // The heartbeat rides on the business line whose via has a heartbeat link.
    const hb = await page.evaluate(() => [...document.querySelectorAll('.cm-hb')].length)
    if (!hb) throw new Error('No heartbeat on the map')
    if (await page.locator('path.cm-hbline[data-key="inventory-svc->order-system.registry"]').count()) throw new Error('The heartbeat line is drawn as a heartbeat-only line')
    if (!(await page.locator('path.cm-edge[data-key="inventory-svc->order-system.registry"]').count())) throw new Error('The heartbeat line is not a business line')
    await page.locator('.cm-hit[data-key="inventory-svc->order-system.registry"]').dispatchEvent('click')
    await page.waitForSelector('.cm-detail .cm-hb-tag', { timeout: 5000 })
    await shot('codemap-08-flow-focus')
  })

  await step('edit a node in the details and save it into its YAML', async () => {
    const file = path.join(library, 'order-svc/order-svc.yaml')
    const original = readFileSync(file, 'utf8')
    await page.locator('.cm-picker .cm-select').selectOption('order-svc')
    await page.waitForSelector('.cm-node[data-id="order-svc.validate"]', { timeout: 5000 })
    await page.locator('.cm-node[data-id="order-svc.validate"]').click()
    await page.locator('.cm-detail button[aria-label="Edit Node"]').click()
    await page.waitForSelector('.cm-edit', { timeout: 5000 })
    // Cancel changes nothing.
    await page.locator('.cm-edit input').first().fill('临时')
    await page.locator('.cm-edit button:has-text("Cancel")').click()
    if (readFileSync(file, 'utf8') !== original) throw new Error('Cancel wrote the file')
    // Save: name and desc change, everything else in the file stays.
    await page.locator('.cm-detail button[aria-label="Edit Node"]').click()
    await page.locator('.cm-edit input').first().fill('参数校验 v2')
    await page.locator('.cm-edit textarea').fill('校验 UserId: 非空 # 必填')
    await page.locator('.cm-edit button:has-text("Save")').click()
    await page.waitForSelector('.cm-edit', { state: 'detached', timeout: 5000 })
    const text = readFileSync(file, 'utf8')
    if (!text.includes('name: 参数校验 v2')) throw new Error('name was not written')
    if (!text.includes('desc: "校验 UserId: 非空 # 必填"')) throw new Error(`desc was not written:\n${text.slice(0, 1200)}`)
    // One line changed (name) and one added (desc); every other line is kept as written.
    const before = original.split('\n')
    const after = text.split('\n')
    const removed = before.filter((line) => !after.includes(line))
    const added = after.filter((line) => !before.includes(line))
    if (removed.length !== 1 || added.length !== 2) throw new Error(`Unexpected edit: -${JSON.stringify(removed)} +${JSON.stringify(added)}`)
    await page.waitForFunction(() => document.querySelector('.cm-node[data-id="order-svc.validate"] .cm-name')?.textContent?.includes('v2'), null, { timeout: 8000 })
    await page.waitForFunction(() => document.querySelector('.cm-detail .cm-title')?.textContent?.includes('v2'), null, { timeout: 5000 })
    writeFileSync(file, original)
  })

  await step('loops, goroutines, listeners and timers', async () => {
    // order-svc: the line that starts the releaser goroutine is purple and stays purple on hover.
    await page.locator('.cm-picker .cm-select').selectOption('order-svc')
    await page.waitForSelector('.cm-node[data-id="order-svc.releaser"]', { timeout: 5000 })
    await page.waitForTimeout(400)
    const goLine = page.locator('path.cm-edge.async[data-key="order-svc.create-order->order-svc.releaser"]')
    if (!(await goLine.count())) throw new Error('The goroutine line is not marked async')
    const colour = () => goLine.evaluate((el) => getComputedStyle(el).stroke)
    const before = await colour()
    const box = await page.locator('.cm-node[data-id="order-svc.create-order"] .cm-shape').boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(250)
    if ((await colour()) !== before) throw new Error(`The goroutine line changed colour on hover: ${before} → ${await colour()}`)
    const tip = await page.locator('path.cm-hit[data-key="order-svc.create-order->order-svc.releaser"] title').textContent()
    if (tip !== 'Goroutine') throw new Error(`Goroutine tooltip: ${tip}`)
    if (await page.locator('.cm-amb[data-key="order-svc.create-order->order-svc.releaser"] .cm-ball--ack').count()) throw new Error('A goroutine line shows a reply')
    // Inside the releaser: one loop frame, a listener that ripples inside its box, a timer.
    await page.mouse.move(2, 2)
    await page.locator('.cm-node[data-id="order-svc.releaser"]').dblclick()
    await page.waitForSelector('.cm-loop-frame', { timeout: 8000 })
    await page.waitForFunction(() => !document.querySelector('.cm-vp')?.style.opacity, null, { timeout: 5000 })
    if ((await page.locator('.cm-loop-frame').count()) !== 1) throw new Error('Expected one loop frame')
    const frame = await page.locator('.cm-loop-frame rect').boundingBox()
    for (const id of ['wait', 'on-paid', 'on-tick', 'check', 'release']) {
      const b = await page.locator(`.cm-node[data-id="order-svc.releaser.${id}"] .cm-shape`).boundingBox()
      if (b.x < frame.x || b.y < frame.y || b.x + b.width > frame.x + frame.width || b.y + b.height > frame.y + frame.height) throw new Error(`${id} is outside the loop frame`)
    }
    const stop = await page.locator('.cm-node[data-id="order-svc.releaser.stop"] .cm-shape').boundingBox()
    if (stop.x > frame.x && stop.x + stop.width < frame.x + frame.width && stop.y > frame.y && stop.y + stop.height < frame.y + frame.height) throw new Error('The exit is inside the loop frame')
    const ripple = await page.locator('.cm-node.is-listen[data-id="order-svc.releaser.on-paid"] .cm-ripple').getAttribute('clip-path')
    if (!ripple?.startsWith('url(#cm-clip-')) throw new Error('The listener ripple is not clipped to its node')
    if (!(await page.locator('.cm-node.is-timer[data-id="order-svc.releaser.on-tick"]').getAttribute('style'))?.includes('--every:30s')) throw new Error('The timer period is not set')
    // A back line runs along the frame's left side, and its condition shows on the line.
    const back = await page.locator('path.cm-edge[data-key="order-svc.releaser.check->order-svc.releaser.wait"]').getAttribute('d')
    const lane = Number(/L([-\d.]+),/.exec(back)[1])
    const frameX = Number(await page.locator('.cm-loop-frame rect').getAttribute('x'))
    if (lane > frameX + 40) throw new Error(`The back line does not hug the frame: ${back}`)
    if (!(await page.locator('.cm-elabel', { hasText: '未付款' }).count())) throw new Error('The branch condition is not shown')
    await shot('codemap-09-loop')
    // Editing: dragging one node of the loop moves the whole loop.
    const file = path.join(library, 'order-svc/releaser/releaser.yaml')
    const original = readFileSync(file, 'utf8')
    await page.locator('.cm-canvas-actions button[aria-label="Edit Layout"]').click()
    await page.waitForSelector('.cm-editbar', { timeout: 5000 })
    // Compare layout coordinates (the shape's x / y in the SVG), not screen boxes: the first drag
    // freezes the map and may rescale the view.
    const world = () =>
      page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('.cm-node')]
            .filter((el) => el.dataset.id?.startsWith('order-svc.releaser.'))
            .map((el) => {
              const r = el.querySelector('.cm-shape').getBBox()
              const t = /translate\(([-\d.]+),([-\d.]+)\)/.exec(el.getAttribute('transform') ?? '')
              return [el.dataset.id.split('.').pop(), [r.x + r.width / 2 + (t ? Number(t[1]) : 0), r.y + r.height / 2 + (t ? Number(t[2]) : 0)]]
            })
        )
      )
    const loopStart = await world()
    const c0 = await page.locator('.cm-node[data-id="order-svc.releaser.check"] .cm-shape').boundingBox()
    await page.mouse.move(c0.x + c0.width / 2, c0.y + c0.height / 2)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(c0.x + c0.width / 2 + i * 10, c0.y + c0.height / 2 + i * 5)
    await page.mouse.up()
    await page.waitForTimeout(300)
    const loopEnd = await world()
    const delta = (id) => `${Math.round(loopEnd[id][0] - loopStart[id][0])},${Math.round(loopEnd[id][1] - loopStart[id][1])}`
    if (delta('check') === '0,0') throw new Error('The loop did not move')
    for (const id of ['wait', 'on-paid', 'on-tick', 'release']) if (delta(id) !== delta('check')) throw new Error(`The loop did not move as one: ${id} ${delta(id)}, check ${delta('check')}`)
    // Nodes outside the loop keep their place relative to each other's start, not to the loop.
    if (delta('stop') === delta('check')) throw new Error('A node outside the loop moved with it')
    await page.locator('.cm-editbar button:has-text("Save")').click()
    await page.waitForSelector('.cm-editbar', { state: 'detached', timeout: 5000 })
    const saved = readFileSync(file, 'utf8')
    if (!/^layout:/m.test(saved)) throw new Error('The loop drag was not saved')
    writeFileSync(file, original)
  })

  await step('to-dos: issues on nodes and notes in todo/', async () => {
    // order-system: the order-svc box counts its own note plus the issue inside it.
    await page.locator('.cm-picker .cm-select').selectOption('order-system')
    await page.waitForSelector('.cm-node[data-id="order-svc"]', { timeout: 5000 })
    const badge = page.locator('.cm-node[data-id="order-svc"] .cm-todo-badge text')
    if ((await badge.textContent()) !== '2') throw new Error(`order-svc to-do badge: ${await badge.textContent()}`)
    if (await page.locator('.cm-node[data-id="inventory-svc"] .cm-todo-badge').count()) throw new Error('A node without to-dos has a badge')
    // The toolbar chip lists every to-do, including the folder with no node yet.
    const chip = page.locator('.cm-chip.is-todo')
    if (!(await chip.innerText()).includes('3')) throw new Error(`To-do chip: ${await chip.innerText()}`)
    await chip.click()
    await page.waitForSelector('.cm-detail .cm-todo-group', { timeout: 5000 })
    if ((await page.locator('.cm-detail .cm-todo-group').count()) !== 3) throw new Error('Expected three groups (validate, order-svc, coupon-svc)')
    if (!(await page.locator('.cm-detail', { hasText: '拆出优惠券服务' }).count())) throw new Error('The folder without a node is missing')
    // A node's details: its own note opens in the editor.
    await page.locator('.cm-node[data-id="order-svc"]').click()
    await page.waitForSelector('.cm-detail .cm-todo-lab', { timeout: 5000 })
    await page.locator('.cm-detail .cm-todo.is-link', { hasText: '超时取消订单' }).click()
    await page.waitForSelector('.tab.is-active:has-text("超时取消订单.md")', { timeout: 8000 })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    // Inside order-svc: the issue on validate shows its code in place.
    await page.locator('.cm-node[data-id="order-svc"]').dblclick()
    await page.waitForSelector('.cm-node[data-id="order-svc.validate"] .cm-todo-badge', { timeout: 8000 })
    await page.locator('.cm-node[data-id="order-svc.validate"]').click()
    await page.locator('.cm-detail .cm-todo .cm-codelink-toggle').first().click()
    await page.waitForSelector('.cm-detail .cm-todo .cm-src tr.is-hl', { timeout: 5000 })
    const hl = await page.locator('.cm-detail .cm-todo .cm-src tr.is-hl td:first-child').allInnerTexts()
    if (hl.map((x) => x.trim()).join(',') !== '22,23,24,25,26') throw new Error(`Issue code shows the wrong lines: ${hl}`)
    await shot('codemap-10-todos')
    // The panel tab lists them too.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'codemap.problems'))
    await page.waitForSelector('.cm-problems-todos .problem-row', { timeout: 5000 })
    if ((await page.locator('.cm-problems-todos .problem-row').count()) !== 3) throw new Error('The panel does not list the three to-dos')
  })

  await step('library edits reload the map', async () => {
    const file = path.join(library, 'order-system/order-system.yaml')
    writeFileSync(file, readFileSync(file, 'utf8').replace('name: 订单系统', 'name: 订单系统 v2'))
    await page.locator('.cm-picker .cm-select').selectOption('order-system')
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-crumb')].some((el) => el.textContent?.includes('订单系统 v2')), null, { timeout: 10000 })
  })

  await step('code map checks panel lists issues and opens YAML', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'codemap.problems'))
    await page.waitForSelector('.cm-problems', { timeout: 5000 })
    await page.locator('.cm-problems .cm-toggle input').check()
    await page.locator('.cm-problems .problem-group:not(.cm-problems-todos) .problem-row').first().click()
    await page.waitForSelector('.tab.is-active:has-text(".yaml")', { timeout: 5000 })
    await shot('codemap-07-checks')
  })

  const unexpected = consoleErrors.filter((text) => !/net::ERR_BLOCKED_BY_CLIENT|Content Security Policy/.test(text))
  if (unexpected.length) console.log('  console errors:\n    ' + unexpected.slice(0, 10).join('\n    '))
} finally {
  await app.close().catch(() => undefined)
  rmSync(work, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} code map steps passed. Screenshots: ${artifacts}`)
process.exit(failed.length ? 1 : 0)
