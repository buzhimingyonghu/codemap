import path from 'node:path'
import { app, BrowserWindow, dialog, nativeTheme, session, shell } from 'electron'
import { attachWindow, getDirtyCount, registerIpc, shutdownServices } from './ipc'
import { buildApplicationMenu } from './menu'
import { registerPrivilegedSchemes, registerProtocolHandlers } from './protocols'
import { APP_ORIGIN, APP_SCHEME, contentSecurityPolicy, PLUGIN_SCHEME } from './security'

const devServer = process.env.ELECTRON_RENDERER_URL
const e2eUserData = process.env.CODEMAP_USER_DATA
if (e2eUserData) app.setPath('userData', e2eUserData)

app.setName('Codemap')
registerPrivilegedSchemes()

let mainWindow: BrowserWindow | null = null
let allowQuit = false

function rendererDir(): string {
  return path.join(__dirname, '../renderer')
}

function isAllowedRendererUrl(url: string): boolean {
  if (url.startsWith(`${APP_SCHEME}:`) || url.startsWith(`${PLUGIN_SCHEME}:`)) return true
  if (url.startsWith('devtools:') || url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return true
  if (devServer && url.startsWith(new URL(devServer).origin)) return true
  return false
}

// Offline by default: every request from web content that is not local is cancelled.
function lockDownNetwork(): void {
  const ses = session.defaultSession
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRendererUrl(details.url)
    callback({ cancel: !allowed })
  })
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write')
  })
  ses.setPermissionCheckHandler((_webContents, permission) => permission === 'clipboard-sanitized-write')
  if (devServer) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [contentSecurityPolicy(devServer)] }
      })
    })
  }
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 540,
    show: false,
    title: 'Codemap',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    vibrancy: 'under-window',
    visualEffectState: 'followWindow',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#00000000' : '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.CODEMAP_E2E === '1'
    }
  })
  mainWindow = window
  attachWindow(window)

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererUrl(url)) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.once('ready-to-show', () => {
    if (process.env.CODEMAP_E2E_HIDDEN !== '1') window.show()
  })
  window.on('close', async (event) => {
    if (allowQuit || getDirtyCount() === 0) return
    event.preventDefault()
    const count = getDirtyCount()
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      message: `You have ${count} unsaved ${count === 1 ? 'file' : 'files'}.`,
      detail: 'Your changes will be lost if you close without saving.',
      buttons: ['Close Without Saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (response === 0) {
      allowQuit = true
      window.close()
    }
  })
  window.on('closed', () => {
    mainWindow = null
  })

  if (devServer) await window.loadURL(devServer)
  else await window.loadURL(`${APP_ORIGIN}/index.html`)
}

app.whenReady().then(async () => {
  registerProtocolHandlers(rendererDir())
  lockDownNetwork()
  registerIpc()
  await buildApplicationMenu(() => mainWindow)
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('before-quit', () => {
  if (getDirtyCount() === 0) allowQuit = true
})

app.on('window-all-closed', () => {
  shutdownServices()
  app.quit()
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererUrl(url)) event.preventDefault()
  })
})
