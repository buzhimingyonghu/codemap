import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { VsCodeLspBridge, type VsCodeLspHost, type VsCodeRange, type VsCodeUri } from '../src/host/lsp'

const created: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function uri(filePath: string, scheme = 'file'): VsCodeUri {
  return { scheme, fsPath: filePath }
}

function range(startLine: number, startCharacter: number, endLine = startLine, endCharacter = startCharacter + 1): VsCodeRange {
  return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } }
}

function host(options: {
  commands?: Record<string, unknown>
  open?: (filePath: string) => Promise<void> | void
  folders?: string[]
  documents?: Record<string, string>
} = {}): { bridge: VsCodeLspBridge; calls: Array<{ command: string; args: unknown[] }> } {
  const calls: Array<{ command: string; args: unknown[] }> = []
  const vscode: VsCodeLspHost = {
    Uri: { file: (filePath) => uri(filePath) },
    workspace: {
      openTextDocument: async (document) => {
        await options.open?.(document.fsPath)
        const text = options.documents?.[document.fsPath]
        return text == null ? { uri: document } : { uri: document, getText: () => text, isDirty: false }
      },
      workspaceFolders: options.folders?.map((folder) => ({ uri: uri(folder), name: path.basename(folder) }))
    },
    commands: {
      executeCommand: async (command, ...args) => {
        calls.push({ command, args })
        return options.commands?.[command]
      }
    }
  }
  return { bridge: new VsCodeLspBridge(vscode), calls }
}

test('open warms the resolved document and reports failure without throwing', async () => {
  const opened: string[] = []
  const ready = host({ open: async (filePath) => void opened.push(filePath) })
  await expect(ready.bridge.open('src/main.go')).resolves.toBe(true)
  expect(opened[0]).toBe(path.resolve('src/main.go'))

  const failed = host({ open: () => Promise.reject(new Error('missing')) })
  await expect(failed.bridge.open('missing.go')).resolves.toBe(false)
  expect(failed.bridge.change('missing.go', 'package main')).toBeUndefined()
  await expect(failed.bridge.save('missing.go')).resolves.toBeUndefined()
  await expect(failed.bridge.close('missing.go')).resolves.toBeUndefined()
})

test('navigate converts positions, locations, and location links, and approves local targets', async () => {
  const target = path.resolve('/sdk/go/src/fmt/print.go')
  const header = path.resolve('/usr/include/stdio.h')
  const { bridge, calls } = host({
    commands: {
      'vscode.executeDefinitionProvider': {
        uri: uri(target),
        range: range(9, 4, 9, 12)
      },
      'vscode.executeTypeDefinitionProvider': [
        {
          targetUri: uri(header),
          targetRange: range(20, 0, 30, 1),
          targetSelectionRange: range(21, 7, 21, 12)
        },
        { uri: uri('https://example.com/lib.go', 'https'), range: range(0, 0) },
        null
      ],
      'vscode.executeReferenceProvider': undefined
    }
  })

  const definitions = await bridge.navigate('definition', 'app.go', 3, 8)
  expect(calls[0]).toEqual({
    command: 'vscode.executeDefinitionProvider',
    args: [uri(path.resolve('app.go')), { line: 2, character: 7 }]
  })
  expect(definitions).toEqual([{ path: path.normalize(target), line: 10, column: 5, endLine: 10, endColumn: 13 }])
  expect(bridge.isApprovedFile(target)).toBe(true)

  const types = await bridge.navigate('typeDefinition', 'app.go', 1, 1)
  expect(types).toEqual([{ path: path.normalize(header), line: 22, column: 8, endLine: 22, endColumn: 13 }])
  expect(bridge.isApprovedFile(header)).toBe(true)
  expect(bridge.isApprovedFile('/not/approved.go')).toBe(false)

  await expect(bridge.navigate('references', 'app.go', 0, 0)).resolves.toEqual([])
  expect(calls.at(-1)?.args[1]).toEqual({ line: 0, character: 0 })
})

test('approved files match a resolved real path as well as the returned path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lumen-lsp-'))
  created.push(dir)
  const real = path.join(dir, 'real.go')
  const link = path.join(dir, 'link.go')
  await writeFile(real, 'package real\n')
  await symlink(real, link)
  const { bridge } = host({
    commands: {
      'vscode.executeDeclarationProvider': { uri: uri(link), range: range(0, 0, 0, 7) }
    }
  })
  await bridge.navigate('declaration', 'app.go', 2, 2)
  expect(bridge.isApprovedFile(link)).toBe(true)
  expect(bridge.isApprovedFile(real)).toBe(true)
})

test('hover merges strings, fenced code, and markdown, using the first range', async () => {
  const { bridge } = host({
    commands: {
      'vscode.executeHoverProvider': [
        {
          contents: ['func Println', { language: 'go', value: 'func Println(a ...any)' }, { value: '**docs**' }, '   '],
          range: range(4, 1, 4, 8)
        },
        { contents: { value: 'more' } }
      ]
    }
  })
  await expect(bridge.hover('app.go', 5, 2)).resolves.toEqual({
    contents: ['func Println', '```go\nfunc Println(a ...any)\n```', '**docs**', 'more'],
    range: { line: 5, column: 2, endLine: 5, endColumn: 9 }
  })

  const empty = host({ commands: { 'vscode.executeHoverProvider': [{ contents: ['  ', { value: '' }] }] } })
  await expect(empty.bridge.hover('app.go', 1, 1)).resolves.toBeNull()
})

test('symbols convert hierarchical and flat results to 1-based kinds and positions', async () => {
  const file = path.resolve('app.go')
  const { bridge, calls } = host({
    commands: {
      'vscode.executeDocumentSymbolProvider': [
        {
          name: 'Printer',
          detail: 'type',
          kind: 4,
          range: range(1, 0, 8, 1),
          selectionRange: range(1, 5, 1, 12),
          children: [{ name: 'Print', detail: 'method', kind: 5, range: range(3, 1, 6, 2), selectionRange: range(3, 2, 3, 7) }]
        },
        {
          name: 'helper',
          kind: 11,
          containerName: 'Printer',
          location: { uri: uri(file), range: range(10, 0, 12, 1) }
        }
      ]
    }
  })
  await expect(bridge.symbols('app.go')).resolves.toEqual([
    {
      name: 'Printer',
      detail: 'type',
      kind: 5,
      line: 2,
      column: 6,
      endLine: 9,
      endColumn: 2,
      children: [{ name: 'Print', detail: 'method', kind: 6, line: 4, column: 3, endLine: 7, endColumn: 3, children: undefined }]
    },
    { name: 'helper', detail: 'Printer', kind: 12, line: 11, column: 1, endLine: 13, endColumn: 2 }
  ])
  expect(calls[0]?.command).toBe('vscode.executeDocumentSymbolProvider')
  expect(calls[0]?.args).toEqual([uri(path.resolve('app.go'))])
})

test('status reports the built-in language features only when a workspace is open', async () => {
  const root = path.resolve('/work/app')
  const open = host({ folders: [root] })
  await expect(open.bridge.status()).resolves.toEqual([
    {
      id: 'vscode',
      label: 'VS Code Language Features',
      languages: [],
      state: 'ready',
      binary: null,
      projectRoots: [root]
    }
  ])
  await expect(host().bridge.status()).resolves.toEqual([])
})

test('dirty buffers shift Monaco lines onto disk text and map same-file results back', async () => {
  const file = path.resolve('src/app.go')
  const disk = ['package main', '', 'func untouched() {}', 'func target() {', '  helper()', '}'].join('\n')
  const inserted = ['// draft 1', '// draft 2', '// draft 3', '// draft 4', '// draft 5', disk].join('\n')
  const other = path.resolve('src/other.go')
  const { bridge, calls } = host({
    documents: { [file]: disk },
    commands: {
      'vscode.executeDefinitionProvider': {
        uri: uri(file),
        range: range(3, 5, 3, 11)
      },
      'vscode.executeHoverProvider': {
        contents: ['func target'],
        range: range(3, 5, 4, 9)
      },
      'vscode.executeReferenceProvider': {
        uri: uri(other),
        range: range(3, 1, 3, 4)
      }
    }
  })

  await bridge.open(file, 'go', disk)
  bridge.change(file, inserted)
  expect(bridge.getDirtyBuffer(file)).toBe(inserted)

  const definitions = await bridge.navigate('definition', file, 9, 6)
  expect(calls[0]?.args[1]).toEqual({ line: 3, character: 5 })
  expect(definitions).toEqual([{ path: path.normalize(file), line: 9, column: 6, endLine: 9, endColumn: 12 }])

  await expect(bridge.hover(file, 9, 6)).resolves.toEqual({
    contents: ['func target'],
    range: { line: 9, column: 6, endLine: 10, endColumn: 10 }
  })
  expect(calls[1]?.args[1]).toEqual({ line: 3, character: 5 })

  const references = await bridge.navigate('references', file, 10, 3)
  expect(calls[2]?.args[1]).toEqual({ line: 4, character: 2 })
  expect(references).toEqual([{ path: path.normalize(other), line: 4, column: 2, endLine: 4, endColumn: 5 }])

  await bridge.save(file)
  expect(bridge.getDirtyBuffer(file)).toBeUndefined()
  bridge.change(file, inserted)
  await bridge.close(file)
  expect(bridge.getDirtyBuffer(file)).toBeUndefined()
})
