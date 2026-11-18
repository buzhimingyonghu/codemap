// Pure path helpers used by both processes. Kept free of Node APIs so the renderer can import them.

export function normalizePath(input: string): string {
  if (!input) return ''
  const absolute = input.startsWith('/')
  const parts: string[] = []
  for (const part of input.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(part)
  }
  const joined = parts.join('/')
  return absolute ? `/${joined}` : joined || '.'
}

export function joinPath(...segments: string[]): string {
  return normalizePath(segments.filter(Boolean).join('/'))
}

export function basename(input: string): string {
  const normalized = normalizePath(input)
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

export function dirname(input: string): string {
  const normalized = normalizePath(input)
  const index = normalized.lastIndexOf('/')
  if (index < 0) return '.'
  if (index === 0) return '/'
  return normalized.slice(0, index)
}

export function extname(input: string): string {
  const name = basename(input)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index).toLowerCase() : ''
}

export function isInside(root: string, target: string): boolean {
  const normalizedRoot = normalizePath(root)
  const normalizedTarget = normalizePath(target)
  if (normalizedRoot === normalizedTarget) return true
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
  return normalizedTarget.startsWith(prefix)
}

export function relativePath(root: string, target: string): string {
  const normalizedRoot = normalizePath(root)
  const normalizedTarget = normalizePath(target)
  if (normalizedRoot === normalizedTarget) return ''
  if (!isInside(normalizedRoot, normalizedTarget)) return normalizedTarget
  const offset = normalizedRoot === '/' ? 1 : normalizedRoot.length + 1
  return normalizedTarget.slice(offset)
}

export function isValidEntryName(name: string): boolean {
  return Boolean(name) && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0')
}
