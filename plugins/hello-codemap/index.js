// A complete Codemap plugin in plain JavaScript. No build step is required:
// Codemap loads this file as an ES module and calls activate(ctx).
//
// Everything a plugin can do goes through `ctx` (see src/renderer/src/plugins/api.ts).
// Disposables returned by ctx.* are tracked automatically and cleaned up on disable.

const STYLE = `
  .hl-root { padding: 6px 14px 16px; display: flex; flex-direction: column; gap: 14px; }
  .hl-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .hl-stat { padding: 10px 12px; border-radius: 8px; background: var(--bg-hover); border: 1px solid var(--border-subtle); }
  .hl-stat b { display: block; font-size: 20px; font-weight: 600; color: var(--fg-primary); font-variant-numeric: tabular-nums; }
  .hl-stat span { font-size: 11px; color: var(--fg-muted); text-transform: uppercase; }
  .hl-bars { display: flex; flex-direction: column; gap: 6px; }
  .hl-bar { display: grid; grid-template-columns: 54px 1fr 36px; align-items: center; gap: 8px; font-size: 12px; color: var(--fg-secondary); }
  .hl-track { height: 6px; border-radius: 3px; background: var(--bg-active); overflow: hidden; }
  .hl-fill { height: 100%; border-radius: 3px; background: var(--accent); transform-origin: left; animation: hl-grow 600ms var(--ease-out) both; }
  .hl-bar:nth-child(2n) .hl-fill { background: var(--accent-2); }
  .hl-num { text-align: right; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
  .hl-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--fg-muted); margin: 0; }
  .hl-empty { color: var(--fg-muted); }
  @keyframes hl-grow { from { transform: scaleX(0); } }
`

function extensionOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : '(none)'
}

export function activate(ctx) {
  ctx.commands.register('insertTimestamp', () => {
    ctx.editor.insertText(new Date().toISOString())
  })

  ctx.commands.register('countLines', () => {
    const text = ctx.editor.getText()
    if (text === null) {
      ctx.ui.notify('Open a file first', 'warning')
      return
    }
    ctx.ui.notify(`${text.split('\n').length} lines`, 'info')
  })

  ctx.views.register('stats', {
    title: 'Workspace Stats',
    location: 'sidebar',
    icon: 'code',
    mount(element) {
      const style = document.createElement('style')
      style.textContent = STYLE
      const root = document.createElement('div')
      root.className = 'hl-root'
      element.append(style, root)

      let cancelled = false
      const render = async () => {
        if (!ctx.workspace.current) {
          root.innerHTML = '<p class="hl-empty">Open a folder to see stats.</p>'
          return
        }
        const files = await ctx.workspace.findFiles(20000)
        const status = await ctx.git.status()
        if (cancelled) return
        const counts = new Map()
        for (const file of files) counts.set(extensionOf(file), (counts.get(extensionOf(file)) ?? 0) + 1)
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        const max = top[0]?.[1] ?? 1
        root.replaceChildren()
        const grid = document.createElement('div')
        grid.className = 'hl-grid'
        for (const [label, value] of [
          ['Files', files.length],
          ['Changed', status.isRepo ? status.files.length : '-']
        ]) {
          const stat = document.createElement('div')
          stat.className = 'hl-stat'
          const number = document.createElement('b')
          number.textContent = String(value)
          const caption = document.createElement('span')
          caption.textContent = label
          stat.append(number, caption)
          grid.append(stat)
        }
        const title = document.createElement('p')
        title.className = 'hl-title'
        title.textContent = 'File types'
        const bars = document.createElement('div')
        bars.className = 'hl-bars'
        for (const [ext, count] of top) {
          const row = document.createElement('div')
          row.className = 'hl-bar'
          row.innerHTML = `<span></span><div class="hl-track"><div class="hl-fill"></div></div><span class="hl-num"></span>`
          row.children[0].textContent = ext
          row.querySelector('.hl-fill').style.width = `${Math.max(4, (count / max) * 100)}%`
          row.children[2].textContent = String(count)
          bars.append(row)
        }
        root.append(grid, title, bars)
      }

      void render()
      const subscriptions = [ctx.workspace.onDidOpen(() => void render()), ctx.editor.onDidSave(() => void render())]
      return () => {
        cancelled = true
        for (const subscription of subscriptions) subscription.dispose()
      }
    }
  })
}

export function deactivate() {}
