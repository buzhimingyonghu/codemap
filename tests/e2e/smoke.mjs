// End-to-end smoke test: drives the real Electron app against a throwaway C project.
// Usage: npm run build && node tests/e2e/smoke.mjs [--app /path/to/Codemap.app]
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '../..')
const artifacts = path.join(here, 'artifacts')
mkdirSync(artifacts, { recursive: true })

const appArgIndex = process.argv.indexOf('--app')
const packagedApp = appArgIndex > 0 ? process.argv[appArgIndex + 1] : null

const work = mkdtempSync(path.join(tmpdir(), 'codemap-e2e-'))
const fixture = path.join(work, 'demo')
const userData = path.join(work, 'user-data')
mkdirSync(path.join(fixture, 'src'), { recursive: true })
mkdirSync(userData, { recursive: true })

const MAIN_C = `#include <stdio.h>
#include "math_utils.h"

int main(void) {
  int total = 0;
  for (int i = 1; i <= 3; i++) {
    total = add(total, i);
  }
  printf("total=%d\\n", total);
  return 0;
}
`
const MATH_H = `#ifndef MATH_UTILS_H
#define MATH_UTILS_H
int add(int a, int b);
#endif
`
const MATH_C = `#include "math_utils.h"

int add(int a, int b) {
  int sum = a + b;
  return sum;
}
`
writeFileSync(path.join(fixture, 'src/main.c'), MAIN_C)
writeFileSync(path.join(fixture, 'src/math_utils.h'), MATH_H)
writeFileSync(path.join(fixture, 'src/math_utils.c'), MATH_C)
writeFileSync(path.join(fixture, 'README.md'), '# Demo\n')
const git = (...args) => execFileSync('git', args, { cwd: fixture, stdio: 'pipe' }).toString()
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'e2e@codemap.local')
git('config', 'user.name', 'Codemap E2E')
git('add', '-A')
git('commit', '-q', '-m', 'Initial commit')

const results = []
const step = async (name, fn) => {
  const started = Date.now()
  try {
    await fn()
    results.push({ name, ok: true, ms: Date.now() - started })
    console.log(`  ok  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
    console.log(`  FAIL ${name}: ${error.message}`)
    await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => undefined)
    const toasts = await page?.locator('.toast').allInnerTexts().catch(() => [])
    if (toasts?.length) console.log(`  toasts: ${toasts.join(' | ')}`)
    const snapshot = await page
      ?.evaluate(() => {
        const t = window.__codemapTest
        if (!t) return null
        const s = t.getState()
        return { sidebarView: s.sidebarView, debug: { state: s.debug.state, frames: s.debug.frames.length }, events: t.events.slice(-10) }
      })
      .catch(() => null)
    if (snapshot) console.log(`  state: ${JSON.stringify(snapshot)}`)
    throw error
  }
}

const launchOptions = packagedApp
  ? { executablePath: path.join(packagedApp, 'Contents/MacOS', path.basename(packagedApp, '.app')), args: [] }
  : { args: [projectRoot] }

const app = await electron.launch({
  ...launchOptions,
  env: {
    ...process.env,
    CODEMAP_E2E: '1',
    CODEMAP_USER_DATA: userData,
    // Reproduce a Finder launch where ~/go/bin is not on PATH; gopls must be found via GOPATH.
    ...(process.env.CODEMAP_E2E_GOPLS ? { GOPATH: path.dirname(path.dirname(process.env.CODEMAP_E2E_GOPLS)), GOPROXY: 'off' } : {})
  },
  timeout: 30000
})
var page = await app.firstWindow()
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(error.message))

const shot = (name) => page.screenshot({ path: path.join(artifacts, `${name}.png`) })
const expectText = async (selector, text, timeout = 15000) => {
  await page.locator(selector).filter({ hasText: text }).first().waitFor({ timeout })
}
// Expands a tree folder only if it is collapsed, so repeated runs never toggle it shut.
const expandFolder = async (name) => {
  const row = page.locator('.tree-row[aria-expanded]', { hasText: name }).first()
  await row.waitFor()
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click()
  await page.locator(`.tree-row[aria-expanded="true"]`, { hasText: name }).first().waitFor()
}
// Activity bar items toggle the sidebar, so only click when the view is not already showing.
const showView = async (label) => {
  const item = page.locator(`.activity-item[aria-label="${label}"]`)
  await item.waitFor()
  if ((await item.getAttribute('aria-pressed')) !== 'true') await item.click()
  await page.locator(`.activity-item[aria-label="${label}"][aria-pressed="true"]`).waitFor()
}

try {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(1440, 900)
    window.center()
  })
  await page.waitForSelector('.welcome', { timeout: 20000 })

  await step('welcome screen renders', async () => {
    await expectText('.welcome h1', 'Codemap')
    await shot('01-welcome')
  })

  await step('open folder', async () => {
    await page.evaluate(async (folder) => {
      const info = await window.codemap.workspace.open(folder)
      return info
    }, fixture)
    // Drive the renderer through its menu command path so state updates like a real open.
    await app.evaluate(({ BrowserWindow }, folder) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:command', `workspace.openRecent:${folder}`)
    }, fixture)
    await expectText('.tree-row', 'src')
    await expectText('.view-title', 'demo')
  })

  await step('expand tree and open file', async () => {
    await expandFolder('src')
    await page.locator('.tree-row', { hasText: 'main.c' }).click()
    await page.waitForSelector('.tab.is-active:has-text("main.c")')
    await page.waitForSelector('.monaco-editor .view-lines')
    await expectText('.monaco-editor .view-lines', 'printf')
    await expectText('.statusbar', 'C')
  })

  await step('configure build and debug', async () => {
    await page.evaluate(async () => {
      const settings = await window.codemap.workspace.getSettings()
      settings.buildCommand = 'mkdir -p build && clang -g -O0 -Wall src/main.c src/math_utils.c -o build/demo'
      settings.debug.program = 'build/demo'
      settings.debug.preLaunchBuild = true
      await window.codemap.workspace.saveSettings(settings)
    })
    // Re-open so the renderer reloads settings from the main process.
    await app.evaluate(({ BrowserWindow }, folder) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:command', `workspace.openRecent:${folder}`)
    }, fixture)
    // Re-opening closes every tab; wait for that so we act on the fresh tree.
    await page.waitForSelector('.tab', { state: 'detached' })
    await expandFolder('src')
    await page.locator('.tree-row', { hasText: 'main.c' }).click()
    await page.waitForSelector('.tab.is-active:has-text("main.c")')
  })

  await step('edit, dirty marker, save', async () => {
    await page.locator('.monaco-editor .view-lines').click()
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.type('// edited in Codemap\n')
    await page.waitForSelector('.tab.is-active.is-dirty')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.save'))
    await page.waitForSelector('.tab.is-active:not(.is-dirty)')
    const disk = readFileSync(path.join(fixture, 'src/main.c'), 'utf8')
    if (!disk.includes('// edited in Codemap')) throw new Error('Saved content not on disk')
  })

  await step('build failure shows clickable diagnostics', async () => {
    writeFileSync(path.join(fixture, 'src/math_utils.c'), MATH_C.replace('return sum;', 'return sum'))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'task.build'))
    await page.waitForSelector('.panel-tab.is-active:has-text("Problems")', { timeout: 30000 })
    await expectText('.problem-row', "expected ';'")
    await shot('02-build-error')
    await page.locator('.problem-row').first().click()
    await page.waitForSelector('.tab.is-active:has-text("math_utils.c")')
    // `return sum` is line 5; clang reports the missing semicolon right after it.
    await expectText('.statusbar', 'Ln 5, Col 13')
  })

  await step('build success', async () => {
    writeFileSync(path.join(fixture, 'src/math_utils.c'), MATH_C)
    await page.waitForTimeout(400)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'task.build'))
    await expectText('.statusbar', 'Built in', 30000)
    await page.locator('.panel-tab', { hasText: 'Output' }).click()
    await expectText('.output-line', 'Build succeeded')
  })

  await step('git panel shows change, stage and commit', async () => {
    await showView('Source Control')
    await expectText('.git-file', 'main.c')
    await shot('03-git')
    await page.locator('.commit-input').fill('Edit main.c from Codemap')
    await page.locator('.section-header', { hasText: 'Changes' }).hover()
    await page.locator('.section-header', { hasText: 'Changes' }).locator('[aria-label="Stage All"]').click()
    await expectText('.section-header', 'Staged Changes')
    await page.locator('.commit-button').click()
    await expectText('.commit-subject', 'Edit main.c from Codemap')
    const log = git('log', '--oneline', '-1')
    if (!log.includes('Edit main.c from Codemap')) throw new Error(`git log: ${log}`)
  })

  await step('diff view opens for a modified file', async () => {
    writeFileSync(path.join(fixture, 'README.md'), '# Demo\n\nChanged.\n')
    await expectText('.git-file', 'README.md', 15000)
    await page.locator('.git-file', { hasText: 'README.md' }).locator('.git-file-name').click()
    await page.waitForSelector('.tab.is-active.kind-diff')
    await page.waitForSelector('.monaco-diff-editor')
  })

  await step('breakpoint stops with call stack and variables', async () => {
    await showView('Explorer')
    await page.locator('.tree-row', { hasText: 'math_utils.c' }).click()
    await page.waitForSelector('.tab.is-active:has-text("math_utils.c")')
    // Click the glyph margin next to line 4 (`int sum = a + b;`), exactly like a user would.
    const lineNumber = page.locator('.monaco-editor .line-numbers', { hasText: /^4$/ }).first()
    await lineNumber.waitFor()
    const box = await lineNumber.boundingBox()
    const glyph = await page.locator('.monaco-editor .glyph-margin').first().boundingBox()
    if (!box || !glyph) throw new Error('Gutter not found')
    await page.mouse.click(glyph.x + glyph.width / 2, box.y + box.height / 2)
    await page.waitForSelector('.bp-glyph:not(.bp-glyph--hint)')
    await expectText('.breakpoint-row', 'math_utils.c').catch(() => undefined)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'debug.start'))
    await page.waitForSelector('.stack-frame', { timeout: 45000 })
    await expectText('.stack-frame', 'add')
    await expectText('.stack-frame', 'main')
    await expectText('.var-row', 'sum')
    await page.waitForSelector('.debug-current-line')
    await expectText('.breakpoint-row', 'math_utils.c')
    await shot('04-debug')
  })

  await step('step and continue to exit', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'debug.next'))
    await page.waitForSelector('.debug-status.status-stopped', { timeout: 15000 })
    // Remove the breakpoint from the Breakpoints section, then continue to the end.
    await page.locator('.section-header', { hasText: 'Breakpoints' }).hover()
    await page.locator('.section-header', { hasText: 'Breakpoints' }).locator('[aria-label="Remove All Breakpoints"]').click()
    await page.waitForSelector('.bp-glyph', { state: 'detached' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'debug.start'))
    await page.locator('.panel-tab', { hasText: 'Debug Console' }).click()
    await expectText('.console-line', 'total=6', 30000)
  })

  await step('command palette and quick open', async () => {
    await page.keyboard.press('Meta+Shift+P')
    await page.waitForSelector('.quickpick')
    await page.keyboard.type('theme paper')
    await expectText('.qp-item', 'Paper')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'paper')
    await shot('05-paper-theme')
    await page.keyboard.press('Meta+P')
    await page.waitForSelector('.quickpick')
    await page.keyboard.type('mathh')
    await page.waitForSelector('.qp-item.is-selected:has-text("math_utils.h")', { timeout: 15000 }).catch(async (error) => {
      const value = await page.locator('.qp-input input').inputValue().catch(() => '?')
      const items = await page.locator('.qp-item').allInnerTexts().catch(() => [])
      console.log(`  quick open query=${JSON.stringify(value)} items=${JSON.stringify(items.slice(0, 5))}`)
      throw error
    })
    await page.keyboard.press('Enter')
    await page.waitForSelector('.tab.is-active:has-text("math_utils.h")')
    await page.keyboard.press('Meta+Shift+P')
    await page.keyboard.type('theme graphite')
    await page.keyboard.press('Enter')
  })

  await step('search across files, jump to a match, and replace', async () => {
    await page.keyboard.press('Meta+Shift+F')
    await page.waitForSelector('.search-view .search-input:focus')
    await page.keyboard.type('add(')
    await expectText('.search-summary', '3 results in 3 files', 15000)
    await page.locator('.search-match', { hasText: 'total = add' }).click()
    await page.waitForSelector('.tab.is-active:has-text("main.c")')
    await page.locator('.search-toggle[aria-label="Use Regular Expression"]').click()
    await page.locator('.search-view .search-input').first().fill('int (\\w+)\\(int a')
    await expectText('.search-summary', '2 results in 2 files', 15000)
    await page.locator('.search-replace-toggle').click()
    await page.locator('.search-view .search-input[aria-label="Replace"]').fill('long $1(int a')
    await expectText('.search-match ins', 'long add(int a')
    await shot('16-search')
    await page.locator('.search-file', { hasText: 'math_utils.c' }).hover()
    await page.locator('.search-file', { hasText: 'math_utils.c' }).locator('[aria-label="Replace All in File"]').click()
    await expectText('.search-summary', '1 result in 1 file', 15000)
    const disk = readFileSync(path.join(fixture, 'src/math_utils.c'), 'utf8')
    if (!disk.includes('long add(int a, int b)')) throw new Error(`replace did not write: ${disk}`)
    writeFileSync(path.join(fixture, 'src/math_utils.c'), MATH_C)
    await page.locator('.search-toggle[aria-label="Use Regular Expression"]').click()
    await page.locator('.search-replace-toggle').click()
    await page.locator('.view-actions [aria-label="Clear Search Results"]').click()
  })

  await step('go to definition across files via clangd', async () => {
    await showView('Explorer')
    await page.locator('.tree-row', { hasText: 'main.c' }).click()
    await page.waitForSelector('.tab.is-active:has-text("main.c")')
    await page.waitForSelector('.status-item.lsp-ready', { timeout: 30000 })
    // `total = add(total, i);` is line 7. Put the cursor inside `add` and run Go to Definition.
    const placeOnCall = () => page.evaluate(() => window.__codemapTest.placeCursor('add(total', 1))
    if (!(await placeOnCall())) throw new Error('call site not found')
    await expectText('.statusbar', 'Ln 7')
    // clangd may still be indexing; retry until it resolves to the implementation file.
    const deadline = Date.now() + 30000
    while (true) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'editor.goToDefinition'))
      const landed = await page
        .waitForSelector('.tab.is-active:has-text("math_utils.c")', { timeout: 2500 })
        .then(() => true)
        .catch(() => false)
      if (landed) break
      if (Date.now() > deadline) throw new Error('Definition did not resolve to math_utils.c')
      await page.locator('.tab', { hasText: 'main.c' }).first().click()
      await placeOnCall()
    }
    await expectText('.statusbar', 'Ln 3')
    await shot('07-definition')
    await page.keyboard.press('Control+Minus')
    await page.waitForSelector('.tab.is-active:has-text("main.c")')
    await expectText('.statusbar', 'Ln 7')
    await page.keyboard.press('Control+Shift+Minus')
    await page.waitForSelector('.tab.is-active:has-text("math_utils.c")')
    await expectText('.statusbar', 'Ln 3')
    await page.locator('.tab', { hasText: 'main.c' }).first().click()
    await page.waitForSelector('.tab.is-active:has-text("main.c")')
  })

  await step('back and forward follow tab switches and long jumps', async () => {
    const longFile = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    writeFileSync(path.join(fixture, 'long.txt'), longFile)
    await page.keyboard.press('Meta+P')
    await page.waitForSelector('.quickpick')
    await page.keyboard.type('long.txt')
    await page.waitForSelector('.qp-item.is-selected:has-text("long.txt")', { timeout: 15000 })
    await page.keyboard.press('Enter')
    await page.waitForSelector('.tab.is-active:has-text("long.txt")')
    await page.evaluate(() => window.__codemapTest.placeCursor('line 70'))
    await expectText('.statusbar', 'Ln 70')
    await page.locator('.tab', { hasText: 'math_utils.h' }).first().click()
    await page.waitForSelector('.tab.is-active:has-text("math_utils.h")')
    const back = page.locator('.nav-cluster [aria-label^="Go Back"]')
    const forward = page.locator('.nav-cluster [aria-label^="Go Forward"]')
    await back.click()
    await page.waitForSelector('.tab.is-active:has-text("long.txt")')
    await expectText('.statusbar', 'Ln 70')
    await back.click()
    await expectText('.statusbar', 'Ln 1,')
    await back.click()
    await page.waitForSelector('.tab.is-active:has-text("main.c")')
    await forward.click()
    await page.waitForSelector('.tab.is-active:has-text("long.txt")')
    await expectText('.statusbar', 'Ln 1,')
    await forward.click()
    await expectText('.statusbar', 'Ln 70')
    await forward.click()
    await page.waitForSelector('.tab.is-active:has-text("math_utils.h")')
    if (await forward.isEnabled()) throw new Error('forward should be exhausted')
    // Rapid presses are queued and each lands where it should.
    await page.keyboard.press('Control+Minus')
    await page.keyboard.press('Control+Minus')
    await expectText('.statusbar', 'Ln 1,')
    await page.waitForSelector('.tab.is-active:has-text("long.txt")')
    // The mouse's side buttons move the same way.
    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 4 })))
    await expectText('.statusbar', 'Ln 70')
    await page.locator('.tab', { hasText: 'long.txt' }).first().click()
    await page.waitForSelector('.tab.is-active:has-text("long.txt")')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'editor.closeTab'))
    await page.waitForFunction(() => ![...document.querySelectorAll('.tab')].some((tab) => tab.textContent?.includes('long.txt')))
    rmSync(path.join(fixture, 'long.txt'))
    await page.locator('.tab', { hasText: 'main.c' }).first().click()
    await page.waitForSelector('.tab.is-active:has-text("main.c")')
    // Places in a deleted file are skipped, never reopened.
    await page.keyboard.press('Control+Minus')
    await page.waitForFunction(() => !document.querySelector('.tab.is-active')?.textContent?.includes('main.c'))
    if (await page.locator('.tab', { hasText: 'long.txt' }).count()) throw new Error('back reopened a deleted file')
    await page.locator('.tab', { hasText: 'main.c' }).first().click()
    await page.waitForSelector('.tab.is-active:has-text("main.c")')
  })

  await step('hover and find references', async () => {
    await page.evaluate(() => window.__codemapTest.placeCursor('add(total', 1))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'editor.showHover'))
    await page.waitForSelector('.monaco-hover-content:has-text("add")', { timeout: 15000 })
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.__codemapTest.placeCursor('add(total', 1))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'editor.findReferences'))
    await page.waitForSelector('.zone-widget .reference-zone-widget, .peekview-widget', { timeout: 15000 })
    await shot('08-references')
    await page.keyboard.press('Escape')
  })

  await step('example plugin is active and its view renders', async () => {
    await showView('Plugins')
    await expectText('.plugin-card', 'Hello Codemap')
    await page.waitForSelector('.plugin-card:has-text("Hello Codemap") .plugin-state.is-active', { timeout: 15000 })
    await showView('Workspace Stats')
    await expectText('.plugin-view', 'Files', 15000)
    await shot('06-plugin')
  })

  await step('renderer network is blocked', async () => {
    const blocked = await page.evaluate(async () => {
      try {
        await fetch('https://example.com', { mode: 'no-cors' })
        return false
      } catch {
        return true
      }
    })
    if (!blocked) throw new Error('Renderer was able to reach the network')
  })

  await step('terminal runs commands in the open folder, in several sessions', async () => {
    const visible = '.terminal-host:not([hidden]) .xterm-rows'
    const shows = (text) => page.waitForFunction(([sel, t]) => (document.querySelector(sel)?.textContent ?? '').includes(t), [visible, text], { timeout: 15000 })
    await page.keyboard.press('Control+Backquote')
    await page.waitForSelector(visible, { timeout: 15000 })
    await page.locator('.terminal-host:not([hidden])').click()
    await page.keyboard.type('echo TERM_$((6*7)); pwd\n')
    await shows('TERM_42')
    await shows(fixture)
    await page.locator('.panel-actions .terminal-new').click()
    await page.waitForSelector('.terminal-list .terminal-tab:nth-child(1)')
    await page.waitForFunction(() => document.querySelectorAll('.terminal-list .terminal-tab').length === 2)
    await page.keyboard.type('echo SECOND_SHELL\n')
    await shows('SECOND_SHELL')
    await page.locator('.terminal-list .terminal-tab').first().click()
    await shows('TERM_42')
    await shot('15-terminal')
    await page.locator('.panel-actions .terminal-kill').click()
    await page.locator('.panel-actions .terminal-kill').click()
    await page.waitForSelector('.terminal-view .panel-empty')
    // Back to the panel layout the following steps expect.
    await page.locator('.panel-tab', { hasText: 'Debug Console' }).click()
  })

  await step('paste a folder copied in Finder, then copy and duplicate inside', async () => {
    // A folder outside the workspace, put on the system clipboard the way Finder does (⌘C).
    const external = path.join(work, 'external-lib')
    mkdirSync(path.join(external, 'include'), { recursive: true })
    writeFileSync(path.join(external, 'include', 'ext.h'), 'int ext(void);\n')
    writeFileSync(path.join(external, 'ext.c'), '#include "include/ext.h"\nint ext(void) { return 7; }\n')
    await app.evaluate(async ({ clipboard, ClipboardItem }, uri) => {
      await clipboard.write([new ClipboardItem({ 'text/uri-list': uri })])
    }, `file://${external}`)
    await showView('Explorer')
    await page.locator('.tree-row', { hasText: 'README.md' }).first().click()
    await page.locator('.tree').focus()
    await page.keyboard.press('Meta+V')
    await expectText('.tree-row', 'external-lib')
    const copied = readFileSync(path.join(fixture, 'external-lib', 'include', 'ext.h'), 'utf8')
    if (copied !== 'int ext(void);\n') throw new Error('Nested file was not copied')
    if (!readFileSync(path.join(external, 'ext.c'), 'utf8')) throw new Error('Source should be untouched')
    // Copy a file inside the workspace and paste into another folder; conflicting names get "copy".
    await page.locator('.tree-row', { hasText: 'README.md' }).first().click()
    await page.keyboard.press('Meta+C')
    await page.locator('.tree-row', { hasText: 'README.md' }).first().click()
    await page.keyboard.press('Meta+V')
    await expectText('.tree-row', 'README copy.md')
    await page.locator('.tree-row', { hasText: 'external-lib' }).first().click()
    await page.keyboard.press('Meta+D')
    await expectText('.tree-row', 'external-lib copy')
    // Finder should be able to paste what Codemap copied.
    const clip = await app.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read()
      for (const item of items) if (item.types.includes('text/uri-list')) return (await item.getType('text/uri-list')).text()
      return ''
    })
    if (!clip.includes('README.md')) throw new Error(`Clipboard did not contain the copied file: ${clip}`)
    await shot('10-paste')
  })

  await step('drag a file inside the tree moves it into a folder', async () => {
    const source = page.locator('.tree-row', { hasText: 'README copy.md' }).first()
    const target = page.locator('.tree-row', { hasText: 'external-lib copy' }).first()
    await source.dragTo(target)
    const moved = path.join(fixture, 'external-lib copy', 'README copy.md')
    const deadline = Date.now() + 5000
    while (!existsSync(moved)) {
      if (Date.now() > deadline) throw new Error('File was not moved on disk')
      await page.waitForTimeout(100)
    }
    if (existsSync(path.join(fixture, 'README copy.md'))) throw new Error('Original should be gone after a move')
  })

  await step('drop a folder from Finder onto a tree folder copies it', async () => {
    const dropped = path.join(work, 'from-finder')
    mkdirSync(path.join(dropped, 'deep'), { recursive: true })
    writeFileSync(path.join(dropped, 'deep', 'a.txt'), 'from finder\n')
    const target = page.locator('.tree-row', { hasText: /^src$/ }).first()
    const box = await target.boundingBox()
    if (!box) throw new Error('src row not visible')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    // CDP drag events carry real file paths, exactly like an OS drag from Finder.
    const cdp = await page.context().newCDPSession(page)
    const data = { items: [], files: [dropped], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x, y, data })
    const copied = path.join(fixture, 'src', 'from-finder', 'deep', 'a.txt')
    const deadline = Date.now() + 5000
    while (!existsSync(copied)) {
      if (Date.now() > deadline) throw new Error('Dropped folder was not copied into src')
      await page.waitForTimeout(100)
    }
    if (!existsSync(dropped)) throw new Error('Source folder outside the workspace must be left in place')
    await expectText('.tree-row', 'from-finder')
  })

  await step('project map: dive into a folder, land on a file, lift off', async () => {
    await page.locator('.mode-switch [aria-label="Project Map"]').click()
    await page.waitForSelector('.map-canvas', { timeout: 20000 })
    await page.waitForFunction(() => window.__codemapProjectMap?.settled())
    const thread = await page.evaluate(() => window.__codemapProjectMap.layoutThread())
    if (thread !== 'worker') throw new Error(`Map layout ran on the ${thread} thread`)
    await shot('11-map')
    // Clicking a territory enters that folder.
    const src = await page.evaluate(() => window.__codemapProjectMap.point('src'))
    await page.mouse.click(src.x, src.y)
    await page.waitForFunction(() => window.__codemapProjectMap.focus() === 'src')
    await expectText('.map-trail button.is-current', 'src')
    await page.waitForFunction(() => window.__codemapProjectMap.settled(), null, { timeout: 5000 })
    // Clicking a town lands on the file and raises the editor over the map.
    const town = await page.evaluate(() => window.__codemapProjectMap.point('src/math_utils.h'))
    await page.mouse.click(town.x, town.y)
    await page.waitForSelector('.project-map.is-editing .tab.is-active:has-text("math_utils.h")', { timeout: 10000 })
    await page.waitForFunction(() => document.activeElement?.closest('.map-editor .monaco-editor'))
    await shot('12-map-editor')
    // Esc lifts off back to the same folder; usage history turned the file into a peak.
    await page.keyboard.press('Escape')
    await page.waitForSelector('.project-map:not(.is-editing)')
    await expectText('.map-hot button', 'math_utils.h')
    if ((await page.evaluate(() => window.__codemapProjectMap.focus())) !== 'src') throw new Error('Lift-off should return to src')
    // Esc again surfaces to the world; the file tree comes back in classic mode.
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.__codemapProjectMap.focus() === '')
    // A folder full of numbered files groups them by prefix: entering it shows the first
    // district at reading zoom, the index jumps between districts, and visits are counted.
    mkdirSync(path.join(fixture, 'migrations'), { recursive: true })
    const verbs = ['add', 'alter', 'create', 'update']
    for (let i = 1; i <= 60; i++) writeFileSync(path.join(fixture, 'migrations', `${String(i).padStart(4, '0')}_${verbs[i % 4]}_table_${i}.sql`), '-- noop\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'Add migrations')
    await page.waitForFunction(() => window.__codemapProjectMap?.engine.tree.byRel.has('migrations'), null, { timeout: 15000 })
    await page.waitForFunction(() => window.__codemapProjectMap.settled())
    const folder = await page.evaluate(() => window.__codemapProjectMap.point('migrations'))
    await page.mouse.click(folder.x, folder.y)
    await page.waitForFunction(() => window.__codemapProjectMap.focus() === 'migrations')
    await page.waitForSelector('.map-index button:has-text("alter")')
    await page.locator('.map-index button', { hasText: 'update' }).click()
    await page.mouse.move(2, 300)
    await page.waitForFunction(() => window.__codemapProjectMap.district() === 'update', null, { timeout: 5000 })
    await page.waitForFunction(() => window.__codemapProjectMap.settled())
    await shot('13-map-prefixes')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.__codemapProjectMap.focus() === '')
    await page.waitForSelector('.map-hot button[title="migrations"]')
    // One setting decides how dense every level opens; changing it reframes the map at once.
    // Re-enter migrations (60 files) so the setting is below its item count either way.
    await page.evaluate(() => window.__codemapProjectMap.engine.enter(window.__codemapProjectMap.engine.tree.byRel.get('migrations')))
    await page.mouse.move(2, 300)
    await page.waitForFunction(() => window.__codemapProjectMap.settled())
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'workbench.settings'))
    await page.waitForSelector('.sheet input.range')
    // Reset to the default (40), step down with the stepper, then type the minimum (10): the
    // level's opening zoom must go up. Compares the computed zoom, not a remembered view.
    const reset = page.locator('.sheet [aria-label^="Reset to"]')
    if (await reset.isEnabled()) await reset.click()
    await page.mouse.move(2, 300)
    await page.waitForFunction(() => window.__codemapProjectMap.settled())
    const before = await page.evaluate(() => window.__codemapProjectMap.engine.readZoom())
    const value = page.locator('.sheet .stepper-value')
    for (const expected of ['35', '30']) {
      await page.locator('.sheet .stepper [aria-label="Fewer"]').click()
      await page.waitForFunction((v) => document.querySelector('.sheet .stepper-value')?.value === v, expected, { timeout: 5000 })
    }
    if ((await value.inputValue()) !== '30') throw new Error('Stepper did not lower the setting')
    await value.fill('10')
    await page.waitForFunction(() => window.__codemapProjectMap.engine.itemsPerScreen === 10, null, { timeout: 5000 })
    await shot('14-map-density-setting')
    await page.keyboard.press('Escape')
    await page.mouse.move(2, 300)
    await page.waitForFunction((k) => window.__codemapProjectMap.settled() && window.__codemapProjectMap.engine.readZoom() > k * 1.05 && window.__codemapProjectMap.engine.cam.k > k * 1.05, before, { timeout: 10000 })
    // Leave the default for anything that runs later.
    await page.evaluate(() => window.__codemapProjectMap.engine.setItemsPerScreen(40))
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.__codemapProjectMap.focus() === '')
    await page.locator('.mode-switch [aria-label="File Tree"]').click()
    await page.waitForSelector('.tree-row')
  })

  await step('go to definition in a Go repo opened via its parent folder', async () => {
    if (!process.env.CODEMAP_E2E_GOPLS) {
      console.log('  (skipped: set CODEMAP_E2E_GOPLS=/path/to/gopls to run)')
      return
    }
    // Parent folder with a Go module one level down, like ~/dev/shop/order-svc.
    const parent = path.join(work, 'parent')
    const repo = path.join(parent, 'svc')
    mkdirSync(path.join(repo, 'utils'), { recursive: true })
    mkdirSync(path.join(repo, 'sinks'), { recursive: true })
    writeFileSync(path.join(repo, 'go.mod'), 'module example.com/svc\n\ngo 1.22\n')
    writeFileSync(path.join(repo, 'utils', 'errors.go'), 'package utils\n\nfunc IsRetry(reason string) bool {\n\treturn reason != ""\n}\n')
    writeFileSync(path.join(repo, 'sinks', 'sink.go'), 'package sinks\n\nimport "example.com/svc/utils"\n\nfunc Handle(r string) bool {\n\treturn utils.IsRetry(r)\n}\n')
    await app.evaluate(({ BrowserWindow }, folder) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:command', `workspace.openRecent:${folder}`)
    }, parent)
    await page.waitForSelector('.view-title:has-text("parent")', { timeout: 15000 }).catch(() => undefined)
    await showView('Explorer')
    await expectText('.tree-row', 'svc')
    await expandFolder('svc')
    await expandFolder('sinks')
    await page.locator('.tree-row', { hasText: 'sink.go' }).click()
    await page.waitForSelector('.tab.is-active:has-text("sink.go")')
    await page.waitForSelector('.status-item.lsp-ready', { timeout: 60000 })
    const deadline = Date.now() + 60000
    while (true) {
      await page.evaluate(() => window.__codemapTest.placeCursor('IsRetry(r)', 1))
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'editor.goToDefinition'))
      const landed = await page
        .waitForSelector('.tab.is-active:has-text("errors.go")', { timeout: 3000 })
        .then(() => true)
        .catch(() => false)
      if (landed) break
      if (Date.now() > deadline) throw new Error('gopls did not resolve the definition')
      await page.locator('.tab', { hasText: 'sink.go' }).first().click()
    }
    await expectText('.statusbar', 'Ln 3')
    await shot('09-go-definition')
  })

  const unexpected = consoleErrors.filter((text) => !/net::ERR_BLOCKED_BY_CLIENT|Failed to fetch|example\.com|Content Security Policy/.test(text))
  if (unexpected.length) {
    console.log('  console errors:\n    ' + unexpected.slice(0, 10).join('\n    '))
  }
} finally {
  await app.close().catch(() => undefined)
  rmSync(work, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed. Screenshots: ${artifacts}`)
process.exit(failed.length ? 1 : 0)
