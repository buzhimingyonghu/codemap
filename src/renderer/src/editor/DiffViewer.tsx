import { useEffect, useRef } from 'react'
import { getDiffModels } from '../services/documents'
import { monaco } from './monaco'

export function DiffViewer({ tabId }: { tabId: string }) {
  const container = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const editor = monaco.editor.createDiffEditor(element, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: element.clientWidth > 900,
      useInlineViewWhenSpaceIsLimited: true,
      fontFamily: "'SF Mono', ui-monospace, Menlo, monospace",
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6 },
      padding: { top: 10 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false }
    })
    editorRef.current = editor
    return () => {
      editor.setModel(null)
      editor.dispose()
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    const models = getDiffModels(tabId)
    if (models) editorRef.current?.setModel(models)
  }, [tabId])

  return <div className="code-editor" ref={container} />
}
