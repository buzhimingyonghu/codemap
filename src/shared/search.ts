// Text search shared by the main process (scanning files on disk) and the renderer (open,
// unsaved buffers and replacing inside editors), so both sides agree on what a match is.
// Pure and dependency-free.

export interface SearchQuery {
  pattern: string
  isRegex: boolean
  matchCase: boolean
  wholeWord: boolean
  /** Comma-separated globs, e.g. `src/**, *.ts`. Empty means everything. */
  include: string
  exclude: string
  maxResults?: number
}

export interface SearchMatch {
  /** 1-based, UTF-16 columns like Monaco. The end is exclusive. */
  line: number
  column: number
  endLine: number
  endColumn: number
  /** Line text split around the match, shortened for long lines. */
  before: string
  match: string
  after: string
}

export interface SearchFileResult {
  path: string
  relative: string
  matches: SearchMatch[]
}

export interface SearchResult {
  files: SearchFileResult[]
  total: number
  truncated: boolean
  durationMs: number
}

export interface ReplaceResult {
  files: number
  replaced: number
  failed: Array<{ path: string; error: string }>
}

export const DEFAULT_MAX_RESULTS = 2000

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Throws a readable error for an invalid regular expression.
export function buildSearchRegExp(query: Pick<SearchQuery, 'pattern' | 'isRegex' | 'matchCase' | 'wholeWord'>): RegExp {
  let source = query.isRegex ? query.pattern : escapeRegExp(query.pattern)
  // Lookarounds instead of \b so patterns that start or end with punctuation still work.
  if (query.wholeWord) source = `(?<![\\w])(?:${source})(?![\\w])`
  return new RegExp(source, `gm${query.matchCase ? '' : 'i'}`)
}

const BEFORE_CHARS = 40
const MATCH_CHARS = 200
const AFTER_CHARS = 120

// Every non-empty match in `text`, with positions and a one-line preview. Stops after `limit`.
export function findMatches(text: string, re: RegExp, limit = Infinity): SearchMatch[] {
  const matches: SearchMatch[] = []
  const pattern = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  let line = 1
  let lineStart = 0
  let scanned = 0
  // Advances the line counter up to `offset`, returning the line and its start offset.
  const locate = (offset: number) => {
    for (let i = scanned; i < offset; i++) {
      if (text.charCodeAt(i) === 10) {
        line++
        lineStart = i + 1
      }
    }
    scanned = Math.max(scanned, offset)
    return { line, lineStart }
  }
  let m: RegExpExecArray | null
  while (matches.length < limit && (m = pattern.exec(text))) {
    if (m[0].length === 0) {
      pattern.lastIndex++
      continue
    }
    const start = locate(m.index)
    const startLine = start.line
    const startOfLine = start.lineStart
    const endOffset = m.index + m[0].length
    // The end position may sit on a later line for multi-line regexes.
    let endLine = startLine
    let endLineStart = startOfLine
    for (let i = m.index; i < endOffset; i++) {
      if (text.charCodeAt(i) === 10) {
        endLine++
        endLineStart = i + 1
      }
    }
    let lineEnd = text.indexOf('\n', m.index)
    if (lineEnd < 0) lineEnd = text.length
    const firstLine = text.slice(m.index, Math.min(endOffset, lineEnd)).replace(/\r$/, '')
    let before = text.slice(startOfLine, m.index).trimStart()
    if (before.length > BEFORE_CHARS) before = `…${before.slice(-BEFORE_CHARS)}`
    let after = endLine === startLine ? text.slice(endOffset, lineEnd).replace(/\r$/, '') : ''
    if (after.length > AFTER_CHARS) after = `${after.slice(0, AFTER_CHARS)}…`
    matches.push({
      line: startLine,
      column: m.index - startOfLine + 1,
      endLine,
      endColumn: endOffset - endLineStart + 1,
      before,
      match: firstLine.length > MATCH_CHARS ? `${firstLine.slice(0, MATCH_CHARS)}…` : firstLine,
      after
    })
  }
  return matches
}

// Expands $&, $1, $<name>, and $$ in a regex replacement, plus \n and \t like VS Code.
export function expandReplacement(template: string, match: string, groups: Array<string | undefined>, named?: Record<string, string | undefined>): string {
  return template.replace(/\$(\$|&|<([^>]+)>|(\d{1,2}))|\\(n|t|\\)/g, (all, token, name, digits, escape) => {
    if (escape) return escape === 'n' ? '\n' : escape === 't' ? '\t' : '\\'
    if (token === '$') return '$'
    if (token === '&') return match
    if (name !== undefined) return named?.[name] ?? ''
    const index = Number(digits)
    if (index >= 1 && index <= groups.length) return groups[index - 1] ?? ''
    return all
  })
}

export interface TextEdit {
  offset: number
  length: number
  text: string
}

// One edit per non-empty match. Literal searches insert the replacement verbatim. `keep`
// (1-based line and column of the match start) limits which matches are replaced.
export function computeReplacements(text: string, re: RegExp, replacement: string, isRegex: boolean, keep?: (line: number, column: number) => boolean): TextEdit[] {
  const edits: TextEdit[] = []
  const pattern = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  let line = 1
  let lineStart = 0
  let scanned = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text))) {
    if (m[0].length === 0) {
      pattern.lastIndex++
      continue
    }
    if (keep) {
      for (; scanned < m.index; scanned++) {
        if (text.charCodeAt(scanned) === 10) {
          line++
          lineStart = scanned + 1
        }
      }
      if (!keep(line, m.index - lineStart + 1)) continue
    }
    edits.push({ offset: m.index, length: m[0].length, text: isRegex ? expandReplacement(replacement, m[0], m.slice(1), m.groups) : replacement })
  }
  return edits
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  let out = ''
  let cursor = 0
  for (const edit of edits) {
    out += text.slice(cursor, edit.offset) + edit.text
    cursor = edit.offset + edit.length
  }
  return out + text.slice(cursor)
}

export function replaceInText(text: string, re: RegExp, replacement: string, isRegex: boolean, keep?: (line: number, column: number) => boolean): { text: string; count: number } {
  const edits = computeReplacements(text, re, replacement, isRegex, keep)
  return { text: applyEdits(text, edits), count: edits.length }
}

// What one match turns into, for the inline preview. Regex replacements re-run the pattern on
// the matched text so $1 and named groups preview correctly (lookarounds aside).
export function previewReplacement(query: Pick<SearchQuery, 'pattern' | 'isRegex' | 'matchCase'>, replacement: string, matched: string): string {
  if (!query.isRegex) return replacement
  try {
    const m = new RegExp(query.pattern, query.matchCase ? '' : 'i').exec(matched)
    return m ? expandReplacement(replacement, m[0], m.slice(1), m.groups) : replacement
  } catch {
    return replacement
  }
}

// ---------- Globs ----------

// Splits on commas that are not inside `{a,b}` groups or escaped with a backslash.
function splitGlobs(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '\\' && i + 1 < input.length) {
      current += char + input[++i]
      continue
    }
    if (char === '{') depth++
    else if (char === '}') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += char
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

function globToRegExpSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '\\' && i + 1 < glob.length) out += escapeRegExp(glob[++i])
    else if (char === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else out += '.*'
      } else out += '[^/]*'
    } else if (char === '?') out += '[^/]'
    else if (char === '{') out += '(?:'
    else if (char === '}') out += ')'
    else if (char === ',') out += '|'
    else if (char === '[') {
      const close = glob.indexOf(']', i + 1)
      if (close > i) {
        out += `[${glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        i = close
      } else out += '\\['
    } else out += escapeRegExp(char)
  }
  return out
}

// VS Code style: `foo` or `*.ts` match at any depth; `./foo` and `src/foo` are anchored at the
// folder root. A pattern also matches everything beneath a folder it names. A backslash makes
// the next character literal. Returns null for an empty input.
export function compileGlobs(input: string): ((relative: string) => boolean) | null {
  const globs = splitGlobs(input)
  if (!globs.length) return null
  const sources = globs.map((glob) => {
    let pattern = glob.replace(/\/+$/, '')
    const anchored = /^\.?\//.test(pattern) || pattern.slice(0, -1).includes('/')
    pattern = pattern.replace(/^\.?\//, '')
    const body = globToRegExpSource(pattern)
    return `${anchored ? '' : '(?:.*/)?'}${body}(?:/.*)?`
  })
  const re = new RegExp(`^(?:${sources.join('|')})$`)
  return (relative) => re.test(relative)
}

/** An include pattern that matches exactly this folder-relative path (and what is inside it). */
export function scopeGlob(relative: string): string {
  return relative ? `./${relative.replace(/[\\*?[\]{},]/g, '\\$&')}` : ''
}

export function pathFilter(query: Pick<SearchQuery, 'include' | 'exclude'>): (relative: string) => boolean {
  const include = compileGlobs(query.include)
  const exclude = compileGlobs(query.exclude)
  return (relative) => (!include || include(relative)) && !(exclude && exclude(relative))
}
