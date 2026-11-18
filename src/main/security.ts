export const APP_SCHEME = 'codemap'
export const PLUGIN_SCHEME = 'codemap-plugin'
export const APP_ORIGIN = `${APP_SCHEME}://app`

// The renderer has no direct network access. Plugins that need HTTP go through
// `plugins.fetch`, which runs in the main process and checks the plugin's allowlist.
export function contentSecurityPolicy(devServer?: string): string {
  const devHttp = devServer ? new URL(devServer).origin : ''
  const devWs = devHttp ? devHttp.replace(/^http/, 'ws') : ''
  const self = `'self' ${PLUGIN_SCHEME}:`
  return [
    `default-src ${self}`,
    `script-src ${self}${devServer ? ` 'unsafe-inline' ${devHttp}` : ''}`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob:`,
    `font-src ${self} data:`,
    `worker-src 'self' blob:`,
    `connect-src ${self}${devServer ? ` ${devHttp} ${devWs}` : ''}`,
    `frame-src 'self' blob: ${PLUGIN_SCHEME}:`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`
  ].join('; ')
}

export function matchesNetworkRule(url: string, rules: string[] | undefined): boolean {
  if (!rules?.length) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  return rules.some((rule) => {
    let ruleUrl: URL
    try {
      ruleUrl = new URL(rule.replace('*.', 'wildcard-placeholder.'))
    } catch {
      return false
    }
    if (ruleUrl.protocol !== parsed.protocol) return false
    if (ruleUrl.port !== parsed.port) return false
    if (ruleUrl.hostname.startsWith('wildcard-placeholder.')) {
      const suffix = ruleUrl.hostname.slice('wildcard-placeholder'.length)
      return parsed.hostname.endsWith(suffix) && parsed.hostname.length > suffix.length
    }
    return ruleUrl.hostname === parsed.hostname
  })
}
