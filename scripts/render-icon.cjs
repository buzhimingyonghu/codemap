// Rendered by Electron (`electron scripts/render-icon.cjs`) to produce build/icon.png.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  })
  window.webContents.setZoomFactor(1)
  await window.loadFile(path.join(__dirname, 'icon.html'))
  await new Promise((resolve) => setTimeout(resolve, 300))
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  const out = path.join(__dirname, '..', 'build', 'icon.png')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, image.resize({ width: 1024, height: 1024 }).toPNG())
  console.log(out)
  app.quit()
})
