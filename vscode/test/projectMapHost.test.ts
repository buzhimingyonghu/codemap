import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ProjectMapHost } from '../src/host/projectMap'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Lumen', GIT_AUTHOR_EMAIL: 'lumen@example.com', GIT_COMMITTER_NAME: 'Lumen', GIT_COMMITTER_EMAIL: 'lumen@example.com' } }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function initRepo(): Promise<string> {
  const root = await tempDir('lumen-map-')
  await git(root, ['init', '-b', 'main'])
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\nsecret/\n')
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src', 'app.ts'), 'export const value = 1\n')
  await writeFile(path.join(root, 'ignored.txt'), 'hidden\n')
  await git(root, ['add', '.gitignore', 'src/app.ts'])
  await git(root, ['commit', '-m', 'initial'])
  await writeFile(path.join(root, 'src', 'app.ts'), 'export const value = 2\n')
  await writeFile(path.join(root, 'src', 'new.ts'), 'export const extra = true\n')
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}\n')
  await writeFile(path.join(root, '.DS_Store'), 'junk')
  return root
}

describe('mapIndex and gitStatus', () => {
  test('respects gitignore and reports churn plus working tree changes', async () => {
    const root = await initRepo()
    const host = new ProjectMapHost(() => root)
    const index = await host.mapIndex()
    expect(index.truncated).toBe(false)
    expect(index.files).toEqual(expect.arrayContaining(['src/app.ts', 'src/new.ts', '.gitignore']))
    expect(index.files.some((file) => file === 'ignored.txt' || file.startsWith('node_modules/') || file === '.DS_Store')).toBe(false)
    expect(index.churn['src/app.ts']).toBeGreaterThan(0)

    const status = await host.gitStatus()
    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    const byPath = Object.fromEntries(status.files.map((file) => [file.path, file]))
    expect(byPath['src/app.ts']?.worktree).toBe('modified')
    expect(byPath['src/new.ts']?.worktree).toBe('untracked')
    expect(byPath['ignored.txt']).toBeUndefined()
  })

  test('walks a plain folder without git metadata', async () => {
    const root = await tempDir('lumen-plain-')
    await mkdir(path.join(root, 'docs'))
    await writeFile(path.join(root, 'docs', 'notes.md'), '# notes\n')
    await mkdir(path.join(root, 'dist'), { recursive: true })
    await writeFile(path.join(root, 'dist', 'bundle.js'), 'built')
    const host = new ProjectMapHost(() => root)

    const index = await host.mapIndex()
    expect(index).toMatchObject({ truncated: false, churn: {} })
    expect(index.files).toContain('docs/notes.md')
    expect(index.files.some((file) => file.startsWith('dist/'))).toBe(false)
    await expect(host.gitStatus()).resolves.toMatchObject({ isRepo: false, branch: null, files: [] })
    expect((await host.listFiles()).map((file) => path.relative(root, file))).toEqual(['docs/notes.md'])
  })

  test('returns an empty status when no folder is open', async () => {
    const host = new ProjectMapHost(() => null)
    await expect(host.gitStatus()).resolves.toMatchObject({ isRepo: false, files: [] })
    await expect(host.mapIndex()).rejects.toThrow(/No folder is open/)
  })
})

describe('workspace file operations', () => {
  test('creates, renames, duplicates, transfers, and trashes entries inside the root', async () => {
    const root = await tempDir('lumen-files-')
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'foo.ts'), 'one\n')
    const trashed: string[] = []
    const host = new ProjectMapHost(() => root, { trash: async (absPath) => void trashed.push(absPath) })

    const created = await host.createEntry(path.join(root, 'src'), 'bar.ts', 'file')
    expect(created).toBe(path.join(root, 'src', 'bar.ts'))
    await expect(readFile(created, 'utf8')).resolves.toBe('')
    const folder = await host.createEntry(root, 'dest', 'directory')
    expect(folder).toBe(path.join(root, 'dest'))

    const renamed = await host.renameEntry(created, 'baz.ts')
    expect(renamed).toBe(path.join(root, 'src', 'baz.ts'))
    const firstCopy = await host.duplicateEntry(renamed)
    const secondCopy = await host.duplicateEntry(renamed)
    expect(firstCopy).toBe(path.join(root, 'src', 'baz copy.ts'))
    expect(secondCopy).toBe(path.join(root, 'src', 'baz copy 2.ts'))

    const copiedDir = await host.duplicateEntry(path.join(root, 'src'))
    expect(copiedDir).toBe(path.join(root, 'src copy'))
    await expect(readFile(path.join(copiedDir, 'foo.ts'), 'utf8')).resolves.toBe('one\n')

    const moved = await host.transferEntries([renamed], folder, 'move')
    expect(moved).toEqual({ created: [path.join(root, 'dest', 'baz.ts')], failed: [] })
    const copied = await host.transferEntries([path.join(root, 'src', 'foo.ts'), path.join(root, 'missing.txt')], folder, 'copy')
    expect(copied.created).toEqual([path.join(root, 'dest', 'foo.ts')])
    expect(copied.failed).toHaveLength(1)

    const listed = await host.listDirectory(root)
    expect(listed.map((entry) => [entry.kind, entry.name])).toEqual([
      ['directory', 'dest'],
      ['directory', 'src'],
      ['directory', 'src copy']
    ])

    await host.trashEntry(folder)
    expect(trashed).toEqual([folder])
  })

  test('rejects names and paths that escape the workspace root', async () => {
    const base = await tempDir('lumen-escape-')
    const root = path.join(base, 'workspace')
    const outside = path.join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(path.join(root, 'keep.txt'), 'stay\n')
    await writeFile(path.join(outside, 'secret.txt'), 'no\n')
    await symlink(outside, path.join(root, 'link'))
    const host = new ProjectMapHost(() => root)

    await expect(host.createEntry(root, '../escape.txt', 'file')).rejects.toThrow(/Invalid name/)
    await expect(host.renameEntry(root, 'renamed')).rejects.toThrow(/workspace root/)
    await expect(host.trashEntry(root)).rejects.toThrow(/workspace root/)
    await expect(host.listDirectory(path.join(root, '..', 'outside'))).rejects.toThrow(/outside the open folder/)
    await expect(host.createEntry(path.join(root, 'link'), 'planted.txt', 'file')).rejects.toThrow(/outside the open folder/)

    const moved = await host.transferEntries([path.join(outside, 'secret.txt')], root, 'move')
    expect(moved.created).toEqual([])
    expect(moved.failed[0]?.error).toMatch(/outside the open folder/)
    await expect(readFile(path.join(outside, 'secret.txt'), 'utf8')).resolves.toBe('no\n')
    await expect(host.transferEntries([path.join(root, 'keep.txt')], outside, 'copy')).rejects.toThrow(/outside the open folder/)
  })
})
