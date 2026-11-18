import path from 'node:path'
import { app } from 'electron'

// The assistant's knowledge folder ships with the app: agent/ in this repository while
// developing, Resources/agent in the packaged app. CODEMAP_AGENT_DIR overrides it (tests).
export function knowledgeRoot(): string {
  if (process.env.CODEMAP_AGENT_DIR) return process.env.CODEMAP_AGENT_DIR
  return app.isPackaged ? path.join(process.resourcesPath, 'agent') : path.join(app.getAppPath(), 'agent')
}
