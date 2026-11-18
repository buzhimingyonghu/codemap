import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { translate } from '../shared/i18n'
import { getAppState, getLocale } from './settingsStore'

function command(window: BrowserWindow | null, id: string): void {
  window?.webContents.send('menu:command', id)
}

export async function buildApplicationMenu(getWindow: () => BrowserWindow | null): Promise<void> {
  const state = await getAppState()
  const locale = await getLocale()
  const L = (text: string) => translate(locale, text)
  const item = (label: string, id: string, accelerator?: string): MenuItemConstructorOptions => ({
    label: L(label),
    accelerator,
    click: () => command(getWindow(), id)
  })
  const recent: MenuItemConstructorOptions[] = state.recentFolders.length
    ? [
        ...state.recentFolders.map((folder) => ({
          label: folder.replace(app.getPath('home'), '~'),
          click: () => command(getWindow(), `workspace.openRecent:${folder}`)
        })),
        { type: 'separator' as const },
        { label: L('Clear Menu'), click: () => app.clearRecentDocuments() }
      ]
    : [{ label: L('No Recent Folders'), enabled: false }]

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        item('Settings…', 'workbench.settings', 'Cmd+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: L('File'),
      submenu: [
        item('New File', 'file.new', 'Cmd+N'),
        item('Open Folder…', 'workspace.open', 'Cmd+O'),
        { label: L('Open Recent'), submenu: recent },
        { type: 'separator' },
        item('Save', 'file.save', 'Cmd+S'),
        item('Save All', 'file.saveAll', 'Alt+Cmd+S'),
        { type: 'separator' },
        item('Close Tab', 'editor.closeTab', 'Cmd+W'),
        item('Close Folder', 'workspace.close')
      ]
    },
    {
      label: L('Edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Find', 'editor.find', 'Cmd+F'),
        item('Replace', 'editor.replace', 'Alt+Cmd+F')
      ]
    },
    {
      label: L('View'),
      submenu: [
        item('Command Palette…', 'workbench.commandPalette', 'Shift+Cmd+P'),
        item('Go to File…', 'workbench.quickOpen', 'Cmd+P'),
        { type: 'separator' },
        item('Explorer', 'view.explorer', 'Shift+Cmd+E'),
        item('Search', 'view.search', 'Shift+Cmd+F'),
        item('Project Map', 'view.projectMap', 'Shift+Cmd+M'),
        item('Code Map', 'view.codeMap', 'Shift+Cmd+Y'),
        item('Source Control', 'view.git', 'Ctrl+Shift+G'),
        item('Run and Debug', 'view.debug', 'Shift+Cmd+D'),
        item('Plugins', 'view.plugins', 'Shift+Cmd+X'),
        { type: 'separator' },
        item('Toggle Sidebar', 'view.toggleSidebar', 'Cmd+B'),
        item('Toggle Panel', 'view.togglePanel', 'Cmd+J'),
        // Shown for discoverability; the renderer handles ⌃` itself (it must also work inside
        // the terminal and the editor), so the menu does not register the key.
        { ...item('Toggle Terminal', 'terminal.toggle', 'Ctrl+`'), registerAccelerator: false },
        item('New Terminal', 'terminal.new'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'toggleDevTools' }, { role: 'reload' }] as MenuItemConstructorOptions[]))
      ]
    },
    {
      label: L('Run'),
      submenu: [
        item('Build', 'task.build', 'Cmd+Shift+B'),
        item('Stop Build', 'task.stop'),
        { type: 'separator' },
        item('Start Debugging', 'debug.start', 'F5'),
        item('Stop Debugging', 'debug.stop', 'Shift+F5'),
        item('Step Over', 'debug.next', 'F10'),
        item('Step Into', 'debug.stepIn', 'F11'),
        item('Step Out', 'debug.stepOut', 'Shift+F11'),
        item('Toggle Breakpoint', 'debug.toggleBreakpoint', 'F9')
      ]
    },
    {
      label: L('Go'),
      submenu: [
        // The renderer handles ⌃- / ⌃⇧- itself so they also work in the terminal and in inputs;
        // the menu only shows the keys.
        { ...item('Back', 'editor.navigateBack', 'Ctrl+-'), registerAccelerator: false },
        { ...item('Forward', 'editor.navigateForward', 'Ctrl+Shift+-'), registerAccelerator: false },
        item('Go to Last Edit Location', 'editor.lastEdit'),
        { type: 'separator' },
        item('Go to File…', 'workbench.quickOpen'),
        item('Go to Symbol in File…', 'editor.goToSymbol', 'Shift+Cmd+O'),
        item('Go to Line…', 'editor.gotoLine', 'Ctrl+G'),
        { type: 'separator' },
        item('Go to Definition', 'editor.goToDefinition', 'F12'),
        item('Peek Definition', 'editor.peekDefinition', 'Alt+F12'),
        item('Go to Declaration', 'editor.goToDeclaration'),
        item('Go to Type Definition', 'editor.goToTypeDefinition'),
        item('Go to Implementation', 'editor.goToImplementation', 'Cmd+F12'),
        item('Find All References', 'editor.findReferences', 'Shift+F12')
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: L('Plugin Guide'), click: () => command(getWindow(), 'help.plugins') }, { label: L('Electron'), click: () => shell.openExternal('https://www.electronjs.org') }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
