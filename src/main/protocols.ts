import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { protocol } from 'electron'
import { isInside } from '../shared/paths'
import { mimeFor } from './mime'
import { resolvePluginAsset } from './plugins'
import { APP_SCHEME, contentSecurityPolicy, PLUGIN_SCHEME } from './security'

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } },
    { scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
  ])
}

async function serveFile(file: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  try {
    const body = await readFile(file)
    return new Response(body, { status: 200, headers: { 'Content-Type': mimeFor(file), ...extraHeaders } })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

export function registerProtocolHandlers(rendererDir: string): void {
  const csp = contentSecurityPolicy()
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url)
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const file = path.resolve(rendererDir, `.${relative}`)
    if (!isInside(rendererDir, file)) return new Response('Forbidden', { status: 403 })
    return serveFile(file, { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' })
  })
  protocol.handle(PLUGIN_SCHEME, (request) => {
    const url = new URL(request.url)
    const file = resolvePluginAsset(url.hostname, url.pathname)
    if (!file) return new Response('Not found', { status: 404 })
    return serveFile(file, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  })
}
