import { executeCommand, hasCommand } from '../../../src/renderer/src/services/commands'
import { ensureCodeMap } from '../../../src/renderer/src/services/codeMap'
import { getState, setState } from '../../../src/renderer/src/state/store'
import { setExplorerMode, toggleProjectMap } from './wrappers/projectMap'

function meta(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey
}

export function installWebviewKeys(): void {
  window.addEventListener(
    'keydown',
    (event) => {
      const key = event.key.toLowerCase()
      let command: string | null = null
      if (meta(event) && event.altKey && !event.shiftKey && key === 's') command = 'file.saveAll'
      else if (meta(event) && !event.shiftKey && !event.altKey && key === 's') command = 'file.save'
      else if (meta(event) && !event.shiftKey && !event.altKey && key === 'w' && getState().mapEditorOpen) command = 'editor.closeTab'
      else if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === '-' || event.key === '_')) command = event.shiftKey ? 'editor.navigateForward' : 'editor.navigateBack'
      else if (meta(event) && event.shiftKey && !event.altKey && key === 'm') {
        event.preventDefault()
        event.stopPropagation()
        toggleProjectMap()
        return
      } else if (meta(event) && event.shiftKey && !event.altKey && key === 'y') {
        event.preventDefault()
        event.stopPropagation()
        setExplorerMode('codemap')
        void ensureCodeMap()
        return
      }
      else if (event.key === 'Escape' && getState().quickPick) setState({ quickPick: null })
      if (!command || !hasCommand(command)) return
      event.preventDefault()
      event.stopPropagation()
      void executeCommand(command).then(() => {
        if (command === 'editor.closeTab' && getState().tabs.length === 0) setState({ mapEditorOpen: false })
      })
    },
    true
  )
}
