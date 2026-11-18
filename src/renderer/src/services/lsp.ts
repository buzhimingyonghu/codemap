import type { LspLocation, LspNavigationKind, LspServerStatus, LspSymbol } from '@shared/lsp'
import { monaco } from '../editor/monaco'
import { Emitter } from '../lib/events'
import { getState, setState } from '../state/store'
import { ensureExternalModel, ensureModel, getModel, onDidClose, onDidCreateModel, onDidSave, openExternalFile, openFile } from './documents'

// Monaco language ids that have a matching language server family.
const LSP_LANGUAGES = ['c', 'cpp', 'objective-c', 'swift', 'rust', 'go', 'python', 'typescript', 'javascript']

const attached = new Set<string>()
const changeTimers = new Map<string, number>()
export const onDidChangeServers = new Emitter<LspServerStatus[]>()

function isLspModel(model: monaco.editor.ITextModel): boolean {
  return model.uri.scheme === 'file' && getModel(model.uri.path) === model && LSP_LANGUAGES.includes(model.getLanguageId())
}

async function attach(path: string, model: monaco.editor.ITextModel): Promise<void> {
  if (attached.has(path) || !LSP_LANGUAGES.includes(model.getLanguageId())) return
  attached.add(path)
  const ok = await window.codemap.lsp.open(path, model.getLanguageId(), model.getValue()).catch(() => false)
  if (!ok) {
    attached.delete(path)
    return
  }
  const listener = model.onDidChangeContent(() => {
    // Full-text sync, debounced: simple and robust for files of normal size.
    const previous = changeTimers.get(path)
    if (previous) window.clearTimeout(previous)
    changeTimers.set(
      path,
      window.setTimeout(() => {
        changeTimers.delete(path)
        if (!model.isDisposed()) window.codemap.lsp.change(path, model.getValue())
      }, 150)
    )
  })
  model.onWillDispose(() => {
    listener.dispose()
    attached.delete(path)
  })
  void refreshServers()
}

function flushChange(path: string): void {
  const timer = changeTimers.get(path)
  if (!timer) return
  window.clearTimeout(timer)
  changeTimers.delete(path)
  const model = getModel(path)
  if (model) window.codemap.lsp.change(path, model.getValue())
}

function toMonacoLocation(location: LspLocation): monaco.languages.Location {
  return {
    uri: monaco.Uri.file(location.path),
    range: new monaco.Range(location.line, location.column, location.endLine, location.endColumn)
  }
}

// Peek and reference widgets render from models, so every target file needs one.
async function preloadModels(locations: LspLocation[]): Promise<LspLocation[]> {
  const root = getState().workspace?.root ?? ''
  const usable: LspLocation[] = []
  for (const location of locations) {
    const inside = location.path.startsWith(`${root}/`)
    try {
      // Targets outside the folder (SDK headers, toolchain sources) open read-only.
      if (inside) await ensureModel(location.path)
      else await ensureExternalModel(location.path)
      usable.push(location)
    } catch {
      /* unreadable target */
    }
  }
  return usable
}

async function navigate(kind: LspNavigationKind, model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.Location[]> {
  const path = model.uri.path
  flushChange(path)
  const locations = await window.codemap.lsp.navigate(kind, path, position.lineNumber, position.column).catch(() => [])
  return (await preloadModels(locations)).map(toMonacoLocation)
}

const SYMBOL_KIND_MAP: Record<number, monaco.languages.SymbolKind> = {}
for (let kind = 1; kind <= 26; kind++) SYMBOL_KIND_MAP[kind] = (kind - 1) as monaco.languages.SymbolKind

function toDocumentSymbol(symbol: LspSymbol): monaco.languages.DocumentSymbol {
  const range = new monaco.Range(symbol.line, symbol.column, symbol.endLine, symbol.endColumn)
  return {
    name: symbol.name,
    detail: symbol.detail ?? '',
    kind: SYMBOL_KIND_MAP[symbol.kind] ?? monaco.languages.SymbolKind.Variable,
    tags: [],
    range,
    selectionRange: new monaco.Range(symbol.line, symbol.column, symbol.line, symbol.column),
    children: symbol.children?.map(toDocumentSymbol)
  }
}

let registered = false

export function registerLanguageFeatures(): void {
  if (registered) return
  registered = true

  onDidCreateModel.on(({ path, model }) => void attach(path, model))
  onDidSave.on((path) => {
    flushChange(path)
    if (attached.has(path)) void window.codemap.lsp.save(path).catch(() => undefined)
  })
  onDidClose.on((path) => {
    if (!attached.has(path)) return
    attached.delete(path)
    void window.codemap.lsp.close(path).catch(() => undefined)
  })
  window.codemap.lsp.onStatus(() => void refreshServers())

  const guard = <T>(model: monaco.editor.ITextModel, run: () => Promise<T>, fallback: T): Promise<T> =>
    isLspModel(model) ? run().catch(() => fallback) : Promise.resolve(fallback)

  for (const language of LSP_LANGUAGES) {
    monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: (model, position) => guard(model, () => navigate('definition', model, position), [])
    })
    monaco.languages.registerDeclarationProvider(language, {
      provideDeclaration: (model, position) => guard(model, () => navigate('declaration', model, position), [])
    })
    monaco.languages.registerTypeDefinitionProvider(language, {
      provideTypeDefinition: (model, position) => guard(model, () => navigate('typeDefinition', model, position), [])
    })
    monaco.languages.registerImplementationProvider(language, {
      provideImplementation: (model, position) => guard(model, () => navigate('implementation', model, position), [])
    })
    monaco.languages.registerReferenceProvider(language, {
      provideReferences: (model, position) => guard(model, () => navigate('references', model, position), [])
    })
    monaco.languages.registerHoverProvider(language, {
      provideHover: (model, position) =>
        guard(
          model,
          async () => {
            flushChange(model.uri.path)
            const hover = await window.codemap.lsp.hover(model.uri.path, position.lineNumber, position.column)
            if (!hover) return null
            return {
              contents: hover.contents.map((value) => ({ value, isTrusted: false, supportHtml: false })),
              range: hover.range ? new monaco.Range(hover.range.line, hover.range.column, hover.range.endLine, hover.range.endColumn) : undefined
            }
          },
          null
        )
    })
    monaco.languages.registerDocumentSymbolProvider(language, {
      displayName: 'Language Server',
      provideDocumentSymbols: (model) =>
        guard(
          model,
          async () => {
            flushChange(model.uri.path)
            return (await window.codemap.lsp.symbols(model.uri.path)).map(toDocumentSymbol)
          },
          []
        )
    })
  }

  // Monaco asks us to open files it does not own (e.g. definition in another file).
  monaco.editor.registerEditorOpener({
    openCodeEditor: async (_source, resource, selectionOrPosition) => {
      if (resource.scheme !== 'file') return false
      let line = 1
      let column = 1
      if (selectionOrPosition) {
        if ('startLineNumber' in selectionOrPosition) {
          line = selectionOrPosition.startLineNumber
          column = selectionOrPosition.startColumn
        } else {
          line = selectionOrPosition.lineNumber
          column = selectionOrPosition.column
        }
      }
      const root = getState().workspace?.root ?? ''
      if (resource.path.startsWith(`${root}/`)) await openFile(resource.path, { line, column })
      else await openExternalFile(resource.path, { line, column })
      return true
    }
  })
}

export async function refreshServers(): Promise<void> {
  if (!getState().workspace) {
    setState({ lspServers: [] })
    return
  }
  const servers = await window.codemap.lsp.status().catch(() => [])
  setState({ lspServers: servers })
  onDidChangeServers.emit(servers)
}

export async function restartServer(serverId: string): Promise<void> {
  await window.codemap.lsp.restart(serverId)
  const paths = [...attached]
  attached.clear()
  for (const path of paths) {
    const model = getModel(path)
    if (model) await attach(path, model)
  }
  await refreshServers()
}

export function attachExistingModels(): void {
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme === 'file' && getModel(model.uri.path) === model) void attach(model.uri.path, model)
  }
}
