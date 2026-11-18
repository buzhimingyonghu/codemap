import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: class {}, shell: {} }))

const { duplicateEntry, transferEntries } = await import('../../src/main/fileService')
const { setWorkspaceRoot, clearWorkspaceRoot } = await import('../../src/main/workspace')

let base: string
let root: string
let outside: string

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'codemap-transfer-')))
  root = path.join(base, 'workspace')
  outside = path.join(base, 'elsewhere')
  mkdirSync(path.join(root, 'src'), { recursive: true })
  mkdirSync(path.join(outside, 'lib', 'nested'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'main.c'), 'int main(void) { return 0; }\n')
  writeFileSync(path.join(outside, 'lib', 'util.c'), 'int util(void);\n')
  writeFileSync(path.join(outside, 'lib', 'nested', 'deep.h'), '#pragma once\n')
  writeFileSync(path.join(outside, 'notes.md'), '# notes\n')
  await setWorkspaceRoot(root)
})

afterEach(() => {
  clearWorkspaceRoot()
  rmSync(base, { recursive: true, force: true })
})

describe('transferEntries', () => {
  it('copies a folder from outside the workspace recursively', async () => {
    const result = await transferEntries([path.join(outside, 'lib')], root, 'copy')
    expect(result.failed).toEqual([])
    expect(result.created).toEqual([path.join(root, 'lib')])
    expect(readFileSync(path.join(root, 'lib', 'nested', 'deep.h'), 'utf8')).toBe('#pragma once\n')
    expect(existsSync(path.join(outside, 'lib'))).toBe(true)
  })

  it('copies several items at once and names conflicts like Finder', async () => {
    writeFileSync(path.join(root, 'notes.md'), 'existing\n')
    const result = await transferEntries([path.join(outside, 'notes.md'), path.join(outside, 'lib')], root, 'copy')
    expect(result.created).toEqual([path.join(root, 'notes copy.md'), path.join(root, 'lib')])
    const again = await transferEntries([path.join(outside, 'notes.md')], root, 'copy')
    expect(again.created).toEqual([path.join(root, 'notes copy 2.md')])
    expect(readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('existing\n')
  })

  it('moves within the workspace', async () => {
    mkdirSync(path.join(root, 'dest'))
    const result = await transferEntries([path.join(root, 'src', 'main.c')], path.join(root, 'dest'), 'move')
    expect(result.created).toEqual([path.join(root, 'dest', 'main.c')])
    expect(existsSync(path.join(root, 'src', 'main.c'))).toBe(false)
  })

  it('refuses to move files that live outside the workspace', async () => {
    const result = await transferEntries([path.join(outside, 'notes.md')], root, 'move')
    expect(result.created).toEqual([])
    expect(result.failed[0].error).toMatch(/inside the open folder/)
    expect(existsSync(path.join(outside, 'notes.md'))).toBe(true)
  })

  it('refuses to copy a folder into itself', async () => {
    const result = await transferEntries([path.join(root, 'src')], path.join(root, 'src'), 'copy')
    expect(result.failed[0].error).toMatch(/inside itself/)
  })

  it('refuses destinations outside the workspace', async () => {
    await expect(transferEntries([path.join(root, 'src', 'main.c')], outside, 'copy')).rejects.toThrow(/outside the open folder/)
  })

  it('reports missing sources without aborting the rest', async () => {
    const result = await transferEntries([path.join(outside, 'gone.txt'), path.join(outside, 'notes.md')], root, 'copy')
    expect(result.created).toEqual([path.join(root, 'notes.md')])
    expect(result.failed).toHaveLength(1)
  })
})

describe('duplicateEntry', () => {
  it('creates a sibling copy', async () => {
    expect(await duplicateEntry(path.join(root, 'src', 'main.c'))).toBe(path.join(root, 'src', 'main copy.c'))
    expect(await duplicateEntry(path.join(root, 'src'))).toBe(path.join(root, 'src copy'))
    expect(existsSync(path.join(root, 'src copy', 'main.c'))).toBe(true)
  })
})
