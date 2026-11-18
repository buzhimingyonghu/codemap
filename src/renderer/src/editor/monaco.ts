// Tree-shakeable entry points (monaco-editor >= 0.56): the core API, every editor feature,
// syntax definitions for all languages, and the bundled JSON/CSS/HTML/TS language services.
// The full `monaco-editor` entry would additionally pull in the native LSP client we do not use.
import * as monaco from 'monaco-editor/editor'
import 'monaco-editor/features/register.all'
import 'monaco-editor/languages/definitions/register.all'
import * as typescript from 'monaco-editor/languages/features/typescript/register'
import 'monaco-editor/languages/features/json/register'
import 'monaco-editor/languages/features/css/register'
import 'monaco-editor/languages/features/html/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker'
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker'

// Workers are bundled by Vite and served from the app origin, so nothing loads from the network.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  }
}

// Workspace files are not visible to the TypeScript worker, so unresolved imports would
// light up every file. Keep syntax errors, drop semantic noise.
typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
typescript.typescriptDefaults.setCompilerOptions({
  target: typescript.ScriptTarget.ESNext,
  module: typescript.ModuleKind.ESNext,
  jsx: typescript.JsxEmit.Preserve,
  allowNonTsExtensions: true,
  allowJs: true
})

export { monaco }
