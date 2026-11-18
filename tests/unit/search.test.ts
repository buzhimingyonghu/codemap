import { describe, expect, it } from 'vitest'
import { buildSearchRegExp, compileGlobs, findMatches, pathFilter, previewReplacement, replaceInText, scopeGlob } from '../../src/shared/search'

const q = (pattern: string, options: Partial<{ isRegex: boolean; matchCase: boolean; wholeWord: boolean }> = {}) =>
  buildSearchRegExp({ pattern, isRegex: false, matchCase: false, wholeWord: false, ...options })

describe('search', () => {
  it('finds matches with 1-based positions and a preview', () => {
    const text = 'int main() {\n  printf("hi");\r\n  PRINTF();\n}'
    const matches = findMatches(text, q('printf'))
    expect(matches.map((m) => [m.line, m.column, m.endColumn])).toEqual([
      [2, 3, 9],
      [3, 3, 9]
    ])
    expect(matches[0]).toMatchObject({ before: '', match: 'printf', after: '("hi");' })
    expect(findMatches(text, q('printf', { matchCase: true }))).toHaveLength(1)
  })

  it('escapes literal patterns and honors whole words', () => {
    expect(findMatches('a.b axb', q('a.b'))).toHaveLength(1)
    expect(findMatches('cat concat cat_x cat', q('cat', { wholeWord: true })).map((m) => m.column)).toEqual([1, 18])
    expect(findMatches('x = $foo + $foo2', q('$foo', { wholeWord: true }))).toHaveLength(1)
    expect(() => q('(', { isRegex: true })).toThrow()
  })

  it('skips empty regex matches and stops at the limit', () => {
    expect(findMatches('abc', q('x*', { isRegex: true }))).toEqual([])
    expect(findMatches('a a a a', q('a'), 2)).toHaveLength(2)
  })

  it('replaces literally or with regex groups, optionally only some matches', () => {
    expect(replaceInText('a $1 a', q('a'), '$1', false)).toEqual({ text: '$1 $1 $1', count: 2 })
    expect(replaceInText('foo(1) foo(22)', q('foo\\((\\d+)\\)', { isRegex: true }), 'bar[$1]', true).text).toBe('bar[1] bar[22]')
    expect(replaceInText('k=v', q('(?<key>\\w)=(?<val>\\w)', { isRegex: true }), '$<val>=$<key>$$', true).text).toBe('v=k$')
    const partial = replaceInText('x\nx x', q('x'), 'y', false, (line, column) => line === 2 && column === 3)
    expect(partial).toEqual({ text: 'x\nx y', count: 1 })
    expect(previewReplacement({ pattern: '(\\w+)@', isRegex: true, matchCase: false }, '<$1>', 'me@')).toBe('<me>')
  })

  it('filters paths with include and exclude globs', () => {
    const ts = compileGlobs('*.ts')!
    expect(ts('a.ts')).toBe(true)
    expect(ts('src/deep/a.ts')).toBe(true)
    expect(ts('a.tsx')).toBe(false)
    const src = compileGlobs('src/**')!
    expect(src('src/a/b.c')).toBe(true)
    expect(src('lib/src/b.c')).toBe(false)
    expect(compileGlobs('docs')!('docs/readme.md')).toBe(true)
    expect(compileGlobs('*.{js,ts}')!('x/y.js')).toBe(true)
    expect(compileGlobs('  ')).toBeNull()
    const accept = pathFilter({ include: 'src, *.md', exclude: '*.min.js, src/vendor' })
    expect(accept('src/app.js')).toBe(true)
    expect(accept('src/app.min.js')).toBe(false)
    expect(accept('src/vendor/x.js')).toBe(false)
    expect(accept('README.md')).toBe(true)
    expect(accept('lib/x.js')).toBe(false)
  })

  it('scopes a search to exactly one folder or file, whatever its name', () => {
    const folder = compileGlobs(scopeGlob('sql/logservices'))!
    expect(folder('sql/logservices/a.sql')).toBe(true)
    expect(folder('sql/logservices')).toBe(true)
    expect(folder('sql/logservices2/a.sql')).toBe(false)
    expect(folder('x/sql/logservices/a.sql')).toBe(false)
    const top = compileGlobs(scopeGlob('order-svc'))!
    expect(top('order-svc/main.go')).toBe(true)
    expect(top('shop/order-svc/main.go')).toBe(false)
    const odd = compileGlobs(scopeGlob('a [b]/x{1,2}*.ts'))!
    expect(odd('a [b]/x{1,2}*.ts')).toBe(true)
    expect(odd('a b/x1.ts')).toBe(false)
    expect(compileGlobs([scopeGlob('a,b'), scopeGlob('c')].join(', '))!('a,b/z')).toBe(true)
    expect(scopeGlob('')).toBe('')
  })
})
