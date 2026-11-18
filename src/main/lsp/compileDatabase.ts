import { access, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const C_FAMILY = new Set(['.c', '.cc', '.cpp', '.cxx', '.m', '.mm'])
const HEADER_DIRS = new Set(['include', 'inc', 'src', 'lib', 'source', 'headers'])
const SKIP = new Set(['.git', 'node_modules', 'build', 'out', 'dist', '.build', 'target', '.cache', 'DerivedData', '.codemap'])

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function scan(root: string, limit = 4000): Promise<{ sources: string[]; includeDirs: string[] }> {
  const sources: string[] = []
  const includeDirs = new Set<string>([root])
  const queue = [root]
  while (queue.length && sources.length < limit) {
    const dir = queue.shift() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    let hasHeader = false
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) queue.push(full)
        if (HEADER_DIRS.has(entry.name.toLowerCase())) includeDirs.add(full)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (C_FAMILY.has(ext)) sources.push(full)
        if (ext === '.h' || ext === '.hpp' || ext === '.hh') hasHeader = true
      }
    }
    if (hasHeader) includeDirs.add(dir)
  }
  return { sources, includeDirs: [...includeDirs] }
}

export type CompileDatabaseKind = 'compile_commands.json' | 'compile_flags.txt' | 'generated' | null

// clangd only indexes files it has compile commands for. Without them, go-to-definition
// from a .c file can only reach declarations in headers, never the implementation in
// another .c file. When a project has neither compile_commands.json nor compile_flags.txt,
// generate a best-effort database under .codemap/ so cross-file navigation works immediately.
export async function ensureCompileDatabase(root: string): Promise<{ kind: CompileDatabaseKind; dir: string | null }> {
  if (await exists(path.join(root, 'compile_commands.json'))) return { kind: 'compile_commands.json', dir: null }
  for (const candidate of ['build', 'out', 'cmake-build-debug', '.build']) {
    if (await exists(path.join(root, candidate, 'compile_commands.json'))) return { kind: 'compile_commands.json', dir: path.join(root, candidate) }
  }
  if (await exists(path.join(root, 'compile_flags.txt'))) return { kind: 'compile_flags.txt', dir: null }

  const { sources, includeDirs } = await scan(root)
  if (!sources.length) return { kind: null, dir: null }
  const flags = includeDirs.map((dir) => `-I${dir}`)
  const commands = sources.map((file) => {
    const ext = path.extname(file).toLowerCase()
    const cxx = ext === '.cc' || ext === '.cpp' || ext === '.cxx' || ext === '.mm'
    const lang = ext === '.m' ? ['-x', 'objective-c'] : ext === '.mm' ? ['-x', 'objective-c++'] : []
    return {
      directory: root,
      file,
      arguments: [cxx ? 'clang++' : 'clang', ...lang, cxx ? '-std=c++20' : '-std=c17', ...flags, '-c', file]
    }
  })
  const dir = path.join(root, '.codemap')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'compile_commands.json'), JSON.stringify(commands, null, 2))
  await writeFile(path.join(dir, '.gitignore'), '*\n')
  return { kind: 'generated', dir }
}
