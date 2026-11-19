import { statSync } from 'node:fs'
import path from 'node:path'

export function resolveAgentKnowledgeDir(extensionPath: string): string {
  const packaged = path.join(extensionPath, 'dist', 'agent')
  try {
    if (statSync(packaged).isDirectory()) return packaged
  } catch {
    // Development and tests keep the knowledge folder beside the extension.
  }
  return path.resolve(extensionPath, '..', 'agent')
}
