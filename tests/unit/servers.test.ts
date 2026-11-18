import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findProjectRoot, resolveServerBinary, SERVER_SPECS } from '../../src/main/lsp/servers'

const gopls = SERVER_SPECS.find((spec) => spec.id === 'gopls')!
const clangd = SERVER_SPECS.find((spec) => spec.id === 'clangd')!

describe('findProjectRoot', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds each repository under a parent folder', async () => {
    // Mirrors ~/dev/shop opened as the workspace with several Go repos inside.
    dir = mkdtempSync(path.join(tmpdir(), 'codemap-root-'))
    for (const repo of ['order-svc', 'payment-svc']) {
      mkdirSync(path.join(dir, repo, '.git'), { recursive: true })
      mkdirSync(path.join(dir, repo, 'sinks', 'es'), { recursive: true })
      writeFileSync(path.join(dir, repo, 'go.mod'), `module example.com/${repo}\n`)
      writeFileSync(path.join(dir, repo, 'sinks', 'es', 'es_sinker.go'), 'package es\n')
    }
    expect(await findProjectRoot(path.join(dir, 'order-svc/sinks/es/es_sinker.go'), dir, gopls.rootMarkers)).toBe(path.join(dir, 'order-svc'))
    expect(await findProjectRoot(path.join(dir, 'payment-svc/sinks/es/es_sinker.go'), dir, gopls.rootMarkers)).toBe(path.join(dir, 'payment-svc'))
  })

  it('prefers go.work above a nested go.mod only when it is nearer, and language markers over .git', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codemap-root-'))
    mkdirSync(path.join(dir, '.git'))
    mkdirSync(path.join(dir, 'svc', 'api'), { recursive: true })
    writeFileSync(path.join(dir, 'svc', 'go.mod'), 'module svc\n')
    writeFileSync(path.join(dir, 'svc', 'api', 'a.go'), '')
    expect(await findProjectRoot(path.join(dir, 'svc/api/a.go'), dir, gopls.rootMarkers)).toBe(path.join(dir, 'svc'))
    writeFileSync(path.join(dir, 'svc', 'go.work'), 'go 1.22\n')
    expect(await findProjectRoot(path.join(dir, 'svc/api/a.go'), dir, gopls.rootMarkers)).toBe(path.join(dir, 'svc'))
  })

  it('falls back to .git, then the open folder', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codemap-root-'))
    mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true })
    mkdirSync(path.join(dir, 'repo', 'src'), { recursive: true })
    expect(await findProjectRoot(path.join(dir, 'repo/src/main.c'), dir, clangd.rootMarkers)).toBe(path.join(dir, 'repo'))
    mkdirSync(path.join(dir, 'loose'))
    expect(await findProjectRoot(path.join(dir, 'loose/x.c'), dir, clangd.rootMarkers)).toBe(dir)
  })

  it('never walks above the open folder', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codemap-root-'))
    writeFileSync(path.join(dir, 'go.mod'), 'module outer\n')
    mkdirSync(path.join(dir, 'inner', 'pkg'), { recursive: true })
    const opened = path.join(dir, 'inner')
    expect(await findProjectRoot(path.join(opened, 'pkg/a.go'), opened, gopls.rootMarkers)).toBe(opened)
  })
})

describe('resolveServerBinary', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds gopls in GOPATH/bin even when it is not on PATH', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codemap-gopath-'))
    mkdirSync(path.join(dir, 'bin'))
    const binary = path.join(dir, 'bin', 'gopls')
    writeFileSync(binary, '#!/bin/sh\n')
    chmodSync(binary, 0o755)
    const env = { PATH: '/usr/bin:/bin', GOPATH: dir, HOME: dir }
    expect(await resolveServerBinary(gopls, env)).toBe(binary)
  })
})
