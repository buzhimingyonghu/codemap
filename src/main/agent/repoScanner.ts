import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'out',
  'build',
  'target',
  '.next',
  'coverage',
  '.idea',
  '.vscode',
  '__pycache__',
  '.pytest_cache',
  'testdata',
  'fixtures'
])
const MAX_FILES = 5000
const MAX_FILE_BYTES = 1024 * 1024
const REPORT_CAP = 12_000
const CATEGORY_CAP = 2800

interface Hit {
  file: string
  line: number
  text: string
}

const SOURCE_RE = /\.(go|ts|tsx|js|jsx|mjs|cjs|py|java|rs|kt)$/i

const RULES: Array<{ bucket: keyof Buckets; re: RegExp }> = [
  { bucket: 'sync', re: /Register\w*Server|\.(GET|POST|PUT|DELETE|PATCH|Any)\s*\(|http\.HandleFunc|trpc\.NewServer|ipcMain\.handle|\bapp\.(get|post|put|delete|use)\s*\(|\brouter\.(get|post|put|delete|use)\s*\(|registerCommand|createServer|@(app|router)\.(get|post|put|delete|route)|@(Get|Post|Put|Delete|Request)Mapping|Router::new/ },
  { bucket: 'async', re: /\bConsume\b|\bSubscribe\b|\.Watch\s*\(|\bonEvent\b|\bKafka\b|\bRabbit\b|\bNATS\b|\bPulsar\b|\bchannel\b|\bconsumer\b/i },
  { bucket: 'timers', re: /time\.NewTicker|\bcron\.|\bsetInterval\s*\(|\bschedule\b|@Scheduled|\bdaemon\b/ },
  { bucket: 'storage', re: /\bCREATE\s+TABLE\b|\bgorm\.|\bprisma\b|\bdrizzle\b|\bredis\b|\bRedis\b|\bNew\w*Client\b|\bfetch\s*\(|\baxios\b|\bS3\b|\bOSS\b|\bCOS\b/ }
]

interface Buckets {
  sync: Hit[]
  async: Hit[]
  timers: Hit[]
  storage: Hit[]
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/')
}

function libraryLocal(repoDir: string, libraryDir: string | undefined, targetFolder: string | undefined): string | null {
  if (!libraryDir) return null
  const anchor = targetFolder ? path.join(libraryDir, targetFolder) : libraryDir
  const local = path.relative(anchor, repoDir).split(path.sep).join('/')
  return local || '.'
}

export async function readGitRemote(repoDir: string): Promise<string | null> {
  const text = await readFile(path.join(repoDir, '.git', 'config'), 'utf8').catch(() => '')
  if (!text) return null
  const origin = text.match(/\[remote\s+"origin"\]([\s\S]*?)(?:\n\s*\[|$)/)
  const block = origin?.[1] ?? text
  const url = block.match(/^\s*url\s*=\s*(.+)\s*$/m)
  return url?.[1]?.trim() || null
}

async function* walk(dir: string, root: string, budget: { files: number }, depth = 0): AsyncGenerator<string> {
  if (depth > 14 || budget.files >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (budget.files >= MAX_FILES) return
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name === 'test' || entry.name === 'tests' || entry.name === '__tests__') {
        const nested = await readdir(full).catch(() => [] as string[])
        if (nested.length > 400) continue
      }
      yield* walk(full, root, budget, depth + 1)
      continue
    }
    if (!entry.isFile() || !SOURCE_RE.test(entry.name)) continue
    budget.files++
    yield full
  }
}

function pushHit(bucket: Hit[], file: string, line: number, text: string): void {
  const key = `${file}:${line}:${text}`
  if (bucket.some((hit) => `${hit.file}:${hit.line}:${hit.text}` === key)) return
  bucket.push({ file, line, text })
}

function formatBucket(title: string, hint: string, hits: Hit[]): string {
  if (!hits.length) return `## ${title}\n${hint}\n- (none)\n`
  const groups = new Map<string, Hit[]>()
  for (const hit of hits) {
    const list = groups.get(hit.file) ?? []
    list.push(hit)
    groups.set(hit.file, list)
  }
  const lines = [`## ${title}`, hint]
  let used = lines.join('\n').length
  let kept = 0
  for (const [file, group] of groups) {
    const head = `- ${file}`
    if (used + head.length + 1 > CATEGORY_CAP && kept > 0) {
      lines.push(`- … ${hits.length - kept} more ${title.toLowerCase()} hits omitted`)
      break
    }
    lines.push(head)
    used += head.length + 1
    kept++
    for (const hit of group) {
      const row = `  - ${hit.line}: ${hit.text}`
      if (used + row.length + 1 > CATEGORY_CAP) {
        lines.push(`  - … remaining lines in ${file} omitted`)
        used = CATEGORY_CAP
        break
      }
      lines.push(row)
      used += row.length + 1
      kept++
    }
  }
  return lines.join('\n') + '\n'
}

function capReport(text: string): string {
  if (text.length <= REPORT_CAP) return text
  return text.slice(0, REPORT_CAP - 80).trimEnd() + '\n\n… [repo scan truncated; every listed file:line above is complete]\n'
}

export async function scanRepoEntrypoints(repoDir: string, libraryDir?: string, targetFolder?: string): Promise<string> {
  const root = path.resolve(repoDir)
  const info = await stat(root).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`Not a repository folder: ${root}`)
  const remote = await readGitRemote(root)
  const local = libraryLocal(root, libraryDir, targetFolder)
  const names = (await readdir(root, { withFileTypes: true }).catch(() => [])).map((entry) => entry.name).sort()
  const markers = ['go.mod', 'package.json', 'Cargo.toml', 'pyproject.toml', 'pom.xml'].filter((name) => names.includes(name))
  const langs = markers.map((name) => {
    if (name === 'go.mod') return 'Go'
    if (name === 'package.json') return 'TypeScript/JavaScript'
    if (name === 'Cargo.toml') return 'Rust'
    if (name === 'pyproject.toml') return 'Python'
    return 'Java'
  })
  const buckets: Buckets = { sync: [], async: [], timers: [], storage: [] }
  const budget = { files: 0 }
  for await (const file of walk(root, root, budget)) {
    let size = 0
    try {
      size = (await stat(file)).size
    } catch {
      continue
    }
    if (size > MAX_FILE_BYTES) continue
    let text = ''
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue
    const lines = text.split('\n')
    const fileRel = rel(root, file)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('#')) continue
      for (const rule of RULES) {
        if (!rule.re.test(line)) continue
        pushHit(buckets[rule.bucket], fileRel, i + 1, line.trim().slice(0, 180))
      }
    }
  }
  const top = names.filter((name) => name !== '.git').slice(0, 40)
  const localNote = local
    ? `repo.local (relative to <library>${targetFolder ? '/' + targetFolder.replace(/^\/+|\/+$/g, '') : ''}): \`${local}\`\nA node folder computes this as path.relative(<library>/<nodeFolder>, repo). Do not hand-count ../../.`
    : 'No library folder was given, so repo.local was not computed.'
  const body = [
    '# Repository entrypoints',
    '## Repository metadata',
    `- path: ${root}`,
    `- git remote: ${remote ?? '(none)'}`,
    `- ${localNote}`,
    `- top-level: ${top.join(', ') || '(empty)'}`,
    `- languages/frameworks: ${langs.join(', ') || 'not detected from marker files'}`,
    `- source files scanned: ${budget.files} (cap ${MAX_FILES}, files over 1MB skipped)`,
    '',
    formatBucket('Sync entrypoints', 'HTTP / RPC / IPC / CLI registrations.', buckets.sync),
    formatBucket('Async consumers and watchers', 'MQ, Kafka, etcd watch, and event-stream consumers.', buckets.async),
    formatBucket('Timers and background loops', 'Tickers, cron, schedules, and daemon loops.', buckets.timers),
    formatBucket('Storage and external clients', 'SQL/ORM, Redis, object storage, and outbound RPC/HTTP clients.', buckets.storage)
  ].join('\n')
  return capReport(`[PINNED_REPO_SCAN]\n${body}`)
}
