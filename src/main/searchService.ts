import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  buildSearchRegExp,
  DEFAULT_MAX_RESULTS,
  findMatches,
  pathFilter,
  replaceInText,
  type ReplaceResult,
  type SearchFileResult,
  type SearchQuery,
  type SearchResult
} from '../shared/search'
import { projectFiles } from './fileIndex'
import { requireWorkspaceRoot, resolveInWorkspace } from './workspace'

const FILE_LIMIT = 50000
const MAX_FILE_BYTES = 4 * 1024 * 1024
const CONCURRENCY = 24

// Text if the first 8 KB has no NUL byte, the same heuristic git and ripgrep use.
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0)
}

async function readText(file: string): Promise<string | null> {
  const info = await stat(file)
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return null
  const buffer = await readFile(file)
  return looksBinary(buffer) ? null : buffer.toString('utf8')
}

export class SearchService {
  // Each run bumps the generation; older runs notice and stop reading files.
  private generation = 0

  cancel(): void {
    this.generation++
  }

  /** `skip` lists absolute paths the renderer searches itself (unsaved editors). */
  async search(query: SearchQuery, skip: string[] = []): Promise<SearchResult | null> {
    const generation = ++this.generation
    const started = Date.now()
    const root = requireWorkspaceRoot()
    const re = buildSearchRegExp(query)
    const limit = query.maxResults ?? DEFAULT_MAX_RESULTS
    const accept = pathFilter(query)
    const skipped = new Set(skip)
    const { files } = await projectFiles(root, FILE_LIMIT)
    const candidates = files.filter((relative) => accept(relative) && !skipped.has(path.join(root, relative)))
    const found = new Map<number, SearchFileResult>()
    let total = 0
    let truncated = false
    let next = 0
    const worker = async () => {
      while (next < candidates.length && !truncated && generation === this.generation) {
        const index = next++
        const relative = candidates[index]
        const absolute = path.join(root, relative)
        let text: string | null
        try {
          text = await readText(absolute)
        } catch {
          continue
        }
        if (text === null || generation !== this.generation) continue
        const matches = findMatches(text, re, limit - total + 1)
        if (!matches.length) continue
        if (total + matches.length > limit) {
          truncated = true
          matches.length = Math.max(0, limit - total)
        }
        total += matches.length
        if (matches.length) found.set(index, { path: absolute, relative, matches })
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    if (generation !== this.generation) return null
    // Workers finish out of order; report files in the order the project lists them.
    const ordered = [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, file]) => file)
    return { files: ordered, total, truncated, durationMs: Date.now() - started }
  }

  // Replaces only the matches the user still sees, identified by where each match starts.
  // A match that moved since the search (the file changed on disk) is left alone.
  async replace(query: SearchQuery, replacement: string, targets: Array<{ path: string; positions: Array<[number, number]> }>): Promise<ReplaceResult> {
    const re = buildSearchRegExp(query)
    const result: ReplaceResult = { files: 0, replaced: 0, failed: [] }
    for (const target of targets) {
      try {
        const absolute = resolveInWorkspace(target.path)
        const text = await readText(absolute)
        if (text === null) throw new Error('Not a text file')
        const wanted = new Set(target.positions.map(([line, column]) => `${line}:${column}`))
        const next = replaceInText(text, re, replacement, query.isRegex, (line, column) => wanted.has(`${line}:${column}`))
        if (!next.count) continue
        await writeFile(absolute, next.text, 'utf8')
        result.files++
        result.replaced += next.count
      } catch (error) {
        result.failed.push({ path: target.path, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  }
}
