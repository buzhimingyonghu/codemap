import { describe, expect, it } from 'vitest'
import { isStaged, isUnstaged, parseBranches, parseLog, parseStatusV2 } from '../../src/shared/gitParse'

describe('parseStatusV2', () => {
  it('parses branch info and every entry kind', () => {
    const output = [
      '# branch.oid 1234',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/main.c',
      '1 A. N... 000000 100644 100644 000 ccc src/new file.c',
      '2 R. N... 100644 100644 100644 ddd eee R100 src/renamed.c',
      'src/old.c',
      'u UU N... 100644 100644 100644 100644 a b c conflict.c',
      '? notes.txt',
      ''
    ].join('\0')
    const status = parseStatusV2(output)
    expect(status).toMatchObject({ isRepo: true, branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, detached: false })
    const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]))
    expect(byPath['src/main.c']).toMatchObject({ index: null, worktree: 'modified' })
    expect(byPath['src/new file.c']).toMatchObject({ index: 'added', worktree: null })
    expect(byPath['src/renamed.c']).toMatchObject({ index: 'renamed', originalPath: 'src/old.c' })
    expect(byPath['conflict.c']).toMatchObject({ index: 'conflicted' })
    expect(byPath['notes.txt']).toMatchObject({ worktree: 'untracked' })
    expect(isStaged(byPath['src/new file.c'])).toBe(true)
    expect(isUnstaged(byPath['src/new file.c'])).toBe(false)
    expect(isStaged(byPath['conflict.c'])).toBe(false)
  })

  it('detects detached HEAD', () => {
    expect(parseStatusV2('# branch.head (detached)\0').detached).toBe(true)
  })
})

describe('parseBranches / parseLog', () => {
  it('parses local and remote refs and skips remote HEAD', () => {
    const branches = parseBranches('*\trefs/heads/main\n \trefs/heads/dev\n \trefs/remotes/origin/HEAD\n \trefs/remotes/origin/dev\n')
    expect(branches).toEqual([
      { name: 'main', current: true, remote: false },
      { name: 'dev', current: false, remote: false },
      { name: 'origin/dev', current: false, remote: true }
    ])
  })

  it('parses log records', () => {
    const log = parseLog('abc\x1fab\x1fAda\x1f2026-10-04T10:00:00+08:00\x1fFirst\x1e\ndef\x1fde\x1fBob\x1f2026-10-03T10:00:00+08:00\x1fSecond: with colon\x1e')
    expect(log).toHaveLength(2)
    expect(log[1]).toMatchObject({ hash: 'def', author: 'Bob', subject: 'Second: with colon' })
  })
})
