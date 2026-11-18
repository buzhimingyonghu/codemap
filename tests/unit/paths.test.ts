import { describe, expect, it } from 'vitest'
import { basename, dirname, extname, isInside, isValidEntryName, joinPath, normalizePath, relativePath } from '../../src/shared/paths'

describe('paths', () => {
  it('normalizes', () => {
    expect(normalizePath('/a/b/../c/./d/')).toBe('/a/c/d')
    expect(normalizePath('/a/../../b')).toBe('/b')
    expect(joinPath('/root', 'src', '../lib/x.c')).toBe('/root/lib/x.c')
  })

  it('keeps workspace containment strict', () => {
    expect(isInside('/work/demo', '/work/demo/src/a.c')).toBe(true)
    expect(isInside('/work/demo', '/work/demo')).toBe(true)
    expect(isInside('/work/demo', '/work/demo-evil/a.c')).toBe(false)
    expect(isInside('/work/demo', '/work/demo/../secret')).toBe(false)
  })

  it('splits names', () => {
    expect(basename('/a/b/c.TXT')).toBe('c.TXT')
    expect(dirname('/a/b/c.txt')).toBe('/a/b')
    expect(dirname('/a')).toBe('/')
    expect(extname('/a/Makefile')).toBe('')
    expect(extname('/a/.gitignore')).toBe('')
    expect(extname('/a/x.Tar.GZ')).toBe('.gz')
    expect(relativePath('/a', '/a/b/c')).toBe('b/c')
  })

  it('validates new entry names', () => {
    expect(isValidEntryName('main.c')).toBe(true)
    expect(isValidEntryName('..')).toBe(false)
    expect(isValidEntryName('a/b')).toBe(false)
    expect(isValidEntryName('')).toBe(false)
  })
})
