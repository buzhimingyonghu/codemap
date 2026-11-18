import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { localeFrom, translate, translatedKeys } from '../../src/shared/i18n'

// Every literal passed to t('...') in the app, so a key without a Chinese entry is caught.
function literalKeys(): Set<string> {
  const roots = ['src/renderer/src', 'src/main/menu.ts']
  const files: string[] = []
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) for (const name of readdirSync(p)) walk(path.join(p, name))
    else if (/\.(ts|tsx)$/.test(p)) files.push(p)
  }
  for (const root of roots) walk(path.resolve(__dirname, '../..', root))
  const keys = new Set<string>()
  const call = /\b(?:t|tr|L)\(\s*(['"])((?:\\.|(?!\1).)+)\1/g
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(call)) keys.add(m[2].replace(/\\(['"])/g, '$1'))
  }
  return keys
}

describe('i18n', () => {
  it('translates with placeholders and falls back to English', () => {
    expect(translate('zh', 'Open Folder')).toBe('打开文件夹')
    expect(translate('zh', 'Built in {s}s', { s: '1.2' })).toBe('编译用时 1.2 秒')
    expect(translate('en', 'Built in {s}s', { s: '1.2' })).toBe('Built in 1.2s')
    expect(translate('zh', 'Some brand new text')).toBe('Some brand new text')
    expect(localeFrom('zh-CN')).toBe('zh')
    expect(localeFrom('en-US')).toBe('en')
  })

  it('has a Chinese entry for every string the app translates', () => {
    const known = new Set(translatedKeys())
    // Product names stay as they are in both languages.
    const untranslated = [...literalKeys()].filter((key) => !known.has(key) && !['Electron'].includes(key))
    expect(untranslated).toEqual([])
  })

  it('has a Chinese entry for every built-in view, command title, and category', () => {
    const source = readFileSync(path.resolve(__dirname, '../../src/renderer/src/builtins.ts'), 'utf8')
    const keys = new Set<string>()
    for (const m of source.matchAll(/registerView\(\{[^}]*title: '([^']+)'/g)) keys.add(m[1])
    // [id, run, 'Title', 'Category', ...] rows of the command table.
    for (const m of source.matchAll(/\['[\w.]+', [^\n]*?\), '([^']+)', '([^']+)'/g)) {
      keys.add(m[1])
      keys.add(m[2])
    }
    for (const m of source.matchAll(/title: `([^$`:]+):/g)) keys.add(m[1])
    expect(keys.size).toBeGreaterThan(40)
    const known = new Set(translatedKeys())
    expect([...keys].filter((key) => !known.has(key))).toEqual([])
  })
})
