import { describe, expect, it } from 'vitest'
import { parseDiagnosticLine, parseDiagnostics, stripAnsi } from '../../src/shared/diagnostics'

const root = '/work/demo'

describe('parseDiagnosticLine', () => {
  it('parses clang errors with relative paths', () => {
    expect(parseDiagnosticLine("src/math.c:5:13: error: expected ';' after return statement", root)).toEqual({
      file: '/work/demo/src/math.c',
      line: 5,
      column: 13,
      severity: 'error',
      message: "expected ';' after return statement"
    })
  })

  it('parses warnings and absolute paths', () => {
    const d = parseDiagnosticLine('/work/demo/main.c:3:9: warning: unused variable [-Wunused-variable]', root)
    expect(d?.severity).toBe('warning')
    expect(d?.file).toBe('/work/demo/main.c')
  })

  it('parses swift and rust style locations', () => {
    expect(parseDiagnosticLine('Sources/App/main.swift:10:5: error: cannot find x in scope', root)?.line).toBe(10)
    expect(parseDiagnosticLine('src/main.rs:2:9: warning[E0384]: cannot assign twice', root)?.severity).toBe('warning')
  })

  it('parses TypeScript paren format', () => {
    const d = parseDiagnosticLine("src/a.ts(12,5): error TS2322: Type 'string' is not assignable", root)
    expect(d).toMatchObject({ file: '/work/demo/src/a.ts', line: 12, column: 5, severity: 'error' })
  })

  it('ignores plain output and paths escaping the folder', () => {
    expect(parseDiagnosticLine('Compiling demo v0.1.0', root)).toBeNull()
    expect(parseDiagnosticLine('../other/x.c:1:1: error: nope', root)).toBeNull()
  })

  it('strips ANSI colors', () => {
    expect(stripAnsi('\u001b[1msrc/a.c:1:2: \u001b[31merror:\u001b[0m bad')).toBe('src/a.c:1:2: error: bad')
    expect(parseDiagnosticLine('\u001b[1msrc/a.c:1:2: \u001b[31merror:\u001b[0m bad', root)?.message).toBe('bad')
  })
})

describe('parseDiagnostics', () => {
  it('deduplicates repeated diagnostics', () => {
    const out = 'a.c:1:1: error: x\na.c:1:1: error: x\nb.c:2:1: warning: y\n'
    expect(parseDiagnostics(out, root)).toHaveLength(2)
  })
})
