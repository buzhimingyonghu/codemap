import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/app.css'
import './vscode.css'
import { installVscodeLumenBridge } from './installBridge'
import { CodeMapShell } from './shell'

installVscodeLumenBridge()

const host = document.getElementById('root')
const dataset = host?.dataset
const root = dataset?.workspaceRoot ?? ''
const name = dataset?.workspaceName || (root ? root.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace' : 'workspace')

CodeMapShell.boot(root, name)

createRoot(host as HTMLElement).render(
  <StrictMode>
    <CodeMapShell root={root} name={name} />
  </StrictMode>
)
