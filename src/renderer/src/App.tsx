import { useEffect, useState } from 'react'
import { registerBuiltins } from './builtins'
import { applyTheme } from './editor/themes'
import { handleDebugEvent } from './services/debug'
import { executeCommand, hasCommand } from './services/commands'
import { handleTaskExit, handleTaskOutput, applyMarkers } from './services/build'
import { onDidOpen, openFile } from './services/documents'
import { handleFsChanges, openFolderPath } from './services/workspace'
import { loadPlugins } from './plugins/host'
import { attachExistingModels, refreshServers, registerLanguageFeatures } from './services/lsp'
import { onDidOpenWorkspace } from './services/workspace'
import { invalidateFileCache } from './workbench/QuickPick'
import { getState, setState, useStore } from './state/store'
import { getActiveEditor } from './services/documents'
import { Workbench } from './workbench/Workbench'
import { setLocale, useLocale } from './lib/i18n'

registerBuiltins()
registerLanguageFeatures()

// Shortcuts that Electron's menu does not own (or that must also work when focus is in inputs).
function onGlobalKeyDown(event: KeyboardEvent): void {
  const meta = event.metaKey
  const key = event.key.toLowerCase()
  let command: string | null = null
  if (meta && !event.shiftKey && key === 'p') command = 'workbench.quickOpen'
  else if (meta && event.shiftKey && key === 'p') command = 'workbench.commandPalette'
  else if (meta && event.shiftKey && key === 'f') command = 'view.search'
  // ⌃` / ⌃⇧` work everywhere, including inside the editor and the terminal itself.
  else if (event.ctrlKey && !meta && event.code === 'Backquote') command = event.shiftKey ? 'terminal.new' : 'terminal.toggle'
  else if (event.ctrlKey && !meta && !event.altKey && event.code === 'Minus') command = event.shiftKey ? 'editor.navigateForward' : 'editor.navigateBack'
  else if (event.key === 'Escape' && getState().quickPick) setState({ quickPick: null })
  if (command) {
    event.preventDefault()
    event.stopPropagation()
    void executeCommand(command)
  }
}

// Mouse side buttons go back and forward, as in browsers and VS Code.
function onMouseButton(event: MouseEvent): void {
  if (event.button !== 3 && event.button !== 4) return
  event.preventDefault()
  if (event.type === 'mouseup') void executeCommand(event.button === 3 ? 'editor.navigateBack' : 'editor.navigateForward')
}

export function App() {
  const [ready, setReady] = useState(false)
  // Re-rendering here re-renders the whole tree (nothing below is memoized), so every label
  // switches language in place without remounting the editor or the map.
  useLocale()

  useEffect(() => {
    let disposed = false
    const unsubscribers = [
      window.codemap.app.onMenuCommand((command) => {
        if (command.startsWith('workspace.openRecent:')) {
          void openFolderPath(command.slice('workspace.openRecent:'.length))
          return
        }
        if (hasCommand(command)) void executeCommand(command)
      }),
      window.codemap.fs.onChange((paths) => {
        invalidateFileCache()
        handleFsChanges(paths)
      }),
      window.codemap.tasks.onOutput((output) => handleTaskOutput(output.taskId, output.stream, output.text)),
      window.codemap.tasks.onExit((exit) => handleTaskExit(exit.taskId, exit.code, exit.signal, exit.durationMs)),
      window.codemap.debug.onEvent(handleDebugEvent)
    ]
    const markers = onDidOpen.on(() => applyMarkers())
    const lspWorkspace = onDidOpenWorkspace.on(() => {
      void refreshServers()
      attachExistingModels()
    })
    window.addEventListener('keydown', onGlobalKeyDown, true)
    window.addEventListener('mousedown', onMouseButton, true)
    window.addEventListener('mouseup', onMouseButton, true)
    // Files dropped outside the explorer: open ones from the folder in the editor, and
    // never let Chromium navigate the window to a file:// URL.
    const preventDrop = (event: DragEvent) => {
      if (event.defaultPrevented) return
      event.preventDefault()
      if (event.type !== 'drop') return
      const root = getState().workspace?.root
      for (const file of [...(event.dataTransfer?.files ?? [])]) {
        const path = window.codemap.fs.pathForFile(file)
        if (root && path.startsWith(`${root}/`)) void openFile(path)
      }
    }
    window.addEventListener('dragover', preventDrop)
    window.addEventListener('drop', preventDrop)

    void (async () => {
      const [info, state] = await Promise.all([window.codemap.app.info(), window.codemap.app.state()])
      if (disposed) return
      applyTheme(state.theme)
      setLocale(state.locale)
      setState({ appInfo: info, theme: state.theme, recentFolders: state.recentFolders })
      if (info.e2e) {
        // Test-only introspection, enabled solely when launched with CODEMAP_E2E=1.
        const events: string[] = []
        useStore.subscribe((next, prev) => {
          if (next.sidebarView !== prev.sidebarView) events.push(`${prev.sidebarView}->${next.sidebarView}`)
          if (next.debug.state !== prev.debug.state) events.push(`debug:${prev.debug.state}->${next.debug.state}`)
          if (events.length > 50) events.shift()
        })
        // Moves the cursor onto the first occurrence of `text` in the active editor.
        const placeCursor = (text: string, offset = 0) => {
          const editor = getActiveEditor()
          const match = editor?.getModel()?.findNextMatch(text, { lineNumber: 1, column: 1 }, false, true, null, false)
          if (!editor || !match) return false
          editor.setPosition({ lineNumber: match.range.startLineNumber, column: match.range.startColumn + offset })
          editor.focus()
          return true
        }
        Object.assign(window, { __codemapTest: { getState, events, placeCursor } })
      }
      setReady(true)
      await loadPlugins()
      if (state.lastFolder && !info.e2e) await openFolderPath(state.lastFolder)
    })()

    return () => {
      disposed = true
      for (const unsubscribe of unsubscribers) unsubscribe()
      markers.dispose()
      lspWorkspace.dispose()
      window.removeEventListener('keydown', onGlobalKeyDown, true)
      window.removeEventListener('mousedown', onMouseButton, true)
      window.removeEventListener('mouseup', onMouseButton, true)
      window.removeEventListener('dragover', preventDrop)
      window.removeEventListener('drop', preventDrop)
    }
  }, [])

  if (!ready) return <div className="boot" />
  return <Workbench />
}
