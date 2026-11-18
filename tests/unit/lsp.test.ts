import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureCompileDatabase } from '../../src/main/lsp/compileDatabase'
import { toHover, toLocations, toSymbols } from '../../src/main/lsp/convert'

describe('LSP result conversion', () => {
  it('converts Location, Location[], and LocationLink[] to 1-based positions', () => {
    const location = { uri: 'file:///w/a.c', range: { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } } }
    expect(toLocations(location)).toEqual([{ path: '/w/a.c', line: 3, column: 5, endLine: 3, endColumn: 8 }])
    expect(toLocations([location, location])).toHaveLength(2)
    const link = {
      targetUri: 'file:///w/b.c',
      targetRange: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
      targetSelectionRange: { start: { line: 1, character: 4 }, end: { line: 1, character: 7 } }
    }
    expect(toLocations([link])[0]).toMatchObject({ path: '/w/b.c', line: 2, column: 5 })
    expect(toLocations(null)).toEqual([])
    expect(toLocations([{ uri: 'untitled:1', range: location.range }])).toEqual([])
  })

  it('decodes percent-encoded file URIs', () => {
    expect(toLocations({ uri: 'file:///w/my%20dir/a.c', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } })[0].path).toBe('/w/my dir/a.c')
  })

  it('normalizes hover contents', () => {
    expect(toHover({ contents: { kind: 'markdown', value: '**int** add' } })?.contents).toEqual(['**int** add'])
    expect(toHover({ contents: [{ language: 'c', value: 'int add(int, int)' }, 'doc'] })?.contents).toEqual(['```c\nint add(int, int)\n```', 'doc'])
    expect(toHover({ contents: '' })).toBeNull()
    expect(toHover(null)).toBeNull()
  })

  it('converts hierarchical and flat symbols', () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } }
    const hierarchical = toSymbols([{ name: 'S', kind: 23, range, selectionRange: range, children: [{ name: 'x', kind: 8, range, selectionRange: range }] }])
    expect(hierarchical[0]).toMatchObject({ name: 'S', kind: 23, line: 1, endLine: 5 })
    expect(hierarchical[0].children?.[0].name).toBe('x')
    const flat = toSymbols([{ name: 'add', kind: 12, location: { uri: 'file:///a.c', range } }])
    expect(flat[0]).toMatchObject({ name: 'add', kind: 12 })
  })
})

describe('ensureCompileDatabase', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('generates commands with include dirs when the project has none', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codemap-cdb-'))
    mkdirSync(path.join(dir, 'src'))
    mkdirSync(path.join(dir, 'include'))
    writeFileSync(path.join(dir, 'src/main.c'), '')
    writeFileSync(path.join(dir, 'src/util.cpp'), '')
    writeFileSync(path.join(dir, 'include/util.h'), '')
    const result = await ensureCompileDatabase(dir)
    expect(result.kind).toBe('generated')
    const commands = JSON.parse(readFileSync(path.join(dir, '.codemap/compile_commands.json'), 'utf8'))
    expect(commands).toHaveLength(2)
    const c = commands.find((entry: any) => entry.file.endsWith('main.c'))
    const cpp = commands.find((entry: any) => entry.file.endsWith('util.cpp'))
    expect(c.arguments[0]).toBe('clang')
    expect(cpp.arguments[0]).toBe('clang++')
    expect(c.arguments).toContain(`-I${path.join(dir, 'include')}`)
    expect(readFileSync(path.join(dir, '.codemap/.gitignore'), 'utf8')).toBe('*\n')
  })

  it('respects an existing compile_commands.json or compile_flags.txt', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codemap-cdb-'))
    writeFileSync(path.join(dir, 'a.c'), '')
    mkdirSync(path.join(dir, 'build'))
    writeFileSync(path.join(dir, 'build/compile_commands.json'), '[]')
    expect(await ensureCompileDatabase(dir)).toEqual({ kind: 'compile_commands.json', dir: path.join(dir, 'build') })
    rmSync(path.join(dir, 'build'), { recursive: true })
    writeFileSync(path.join(dir, 'compile_flags.txt'), '-I.')
    expect((await ensureCompileDatabase(dir)).kind).toBe('compile_flags.txt')
  })

  it('does nothing for non C-family projects', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codemap-cdb-'))
    writeFileSync(path.join(dir, 'main.py'), '')
    expect((await ensureCompileDatabase(dir)).kind).toBeNull()
  })
})
