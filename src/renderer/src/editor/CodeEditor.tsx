import { useEffect, useRef } from 'react'
import { applyMarkers } from '../services/build'
import { toggleBreakpoint } from '../services/debug'
import {
  consumePendingReveal,
  getAnyModel,
  getViewState,
  scheduleReveal,
  onDidChangeActive,
  saveViewState,
  setActiveEditor
} from '../services/documents'
import { getState, setState, useStore } from '../state/store'
import { goToLastEdit, trackEditor } from '../services/navigation'
import { monaco } from './monaco'

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontFamily: "'SF Mono', ui-monospace, Menlo, Monaco, monospace",
  fontSize: 13,
  lineHeight: 20,
  fontLigatures: true,
  glyphMargin: true,
  lineNumbersMinChars: 4,
  lineDecorationsWidth: 8,
  minimap: { enabled: true, renderCharacters: false, maxColumn: 80, scale: 1, showSlider: 'mouseover' },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  cursorSmoothCaretAnimation: 'on',
  renderLineHighlight: 'all',
  roundedSelection: true,
  padding: { top: 10, bottom: 10 },
  bracketPairColorization: { enabled: true },
  guides: { indentation: true, bracketPairs: 'active' },
  stickyScroll: { enabled: true, maxLineCount: 4 },
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  fixedOverflowWidgets: true,
  tabSize: 2,
  detectIndentation: true,
  wordWrap: 'off',
  contextmenu: true,
  links: false,
  inlayHints: { enabled: 'off' },
  // ⌘-click jumps straight to the definition; several targets open the peek list.
  multiCursorModifier: 'alt',
  definitionLinkOpensInPeek: false,
  gotoLocation: {
    multipleDefinitions: 'goto',
    multipleDeclarations: 'goto',
    multipleTypeDefinitions: 'goto',
    multipleImplementations: 'peek',
    multipleReferences: 'peek',
    alternativeDefinitionCommand: 'editor.action.goToReferences'
  },
  hover: { enabled: 'on', delay: 350, sticky: true, above: false }
}

export function CodeEditor({ path, readOnly = false }: { path: string; readOnly?: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const breakpointDecorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const debugDecorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const hoverDecorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const breakpoints = useStore((s) => s.breakpoints[path])
  const location = useStore((s) => s.debug.location)
  const debugState = useStore((s) => s.debug.state)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const editor = monaco.editor.create(element, { ...EDITOR_OPTIONS, model: null })
    editorRef.current = editor
    breakpointDecorations.current = editor.createDecorationsCollection()
    debugDecorations.current = editor.createDecorationsCollection()
    hoverDecorations.current = editor.createDecorationsCollection()
    setActiveEditor(editor)

    const cursorListener = editor.onDidChangeCursorSelection((event) => {
      const model = editor.getModel()
      const selected = model ? model.getValueLength() && model.getValueInRange(event.selection).length : 0
      setState({ cursor: { line: event.selection.positionLineNumber, column: event.selection.positionColumn, selected } })
    })
    // Back/forward history: file switches and long cursor jumps (including same-file
    // go-to-definition, which Monaco handles without reaching the editor opener).
    const history = trackEditor(editor)
    const mouseDown = editor.onMouseDown((event) => {
      const type = event.target.type
      if (type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return
      const line = event.target.position?.lineNumber
      const model = editor.getModel()
      hoverDecorations.current?.clear()
      if (line && model) void toggleBreakpoint(model.uri.path, line)
    })
    const mouseMove = editor.onMouseMove((event) => {
      const type = event.target.type
      const line = event.target.position?.lineNumber
      const model = editor.getModel()
      const inGutter = type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
      // Monaco merges glyph classes per line, so never stack the hint on a real breakpoint.
      const hasBreakpoint = Boolean(line && model && getState().breakpoints[model.uri.path]?.includes(line))
      if (line && inGutter && !hasBreakpoint) {
        hoverDecorations.current?.set([{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'bp-glyph bp-glyph--hint' } }])
      } else {
        hoverDecorations.current?.clear()
      }
    })
    const mouseLeave = editor.onMouseLeave(() => hoverDecorations.current?.clear())

    // Keybindings that should win over Monaco defaults while the editor has focus.
    editor.addCommand(monaco.KeyCode.F9, () => {
      const model = editor.getModel()
      const position = editor.getPosition()
      if (model && position) void toggleBreakpoint(model.uri.path, position.lineNumber)
    })
    editor.addCommand(monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyQ), () => void goToLastEdit())

    return () => {
      cursorListener.dispose()
      history.dispose()
      mouseDown.dispose()
      mouseMove.dispose()
      mouseLeave.dispose()
      const model = editor.getModel()
      if (model) saveViewState(model.uri.path, editor.saveViewState())
      setActiveEditor(null)
      editor.dispose()
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const previous = editor.getModel()
    if (previous && previous.uri.path !== path) saveViewState(previous.uri.path, editor.saveViewState())
    const model = getAnyModel(path)
    if (!model) return
    if (previous !== model) {
      editor.setModel(model)
      const state = getViewState(path)
      if (state) editor.restoreViewState(state)
    }
    editor.updateOptions({ readOnly, readOnlyMessage: readOnly ? { value: 'This file is outside the open folder and is read-only.' } : undefined })
    applyMarkers()
    const reveal = consumePendingReveal(path)
    if (reveal) scheduleReveal(reveal)
    else editor.focus()
    const position = editor.getPosition()
    if (position) setState({ cursor: { line: position.lineNumber, column: position.column, selected: 0 } })
    onDidChangeActive.emit(path)
    return () => {
      if (getState().activeTabId !== path) setState({ cursor: null })
    }
  }, [path, readOnly])

  useEffect(() => {
    breakpointDecorations.current?.set(
      (breakpoints ?? []).map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'bp-glyph',
          glyphMarginHoverMessage: { value: `Breakpoint · line ${line}` },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
        }
      }))
    )
  }, [breakpoints, path])

  useEffect(() => {
    if (debugState === 'stopped' && location && location.path === path) {
      debugDecorations.current?.set([
        {
          range: new monaco.Range(location.line, 1, location.line, 1),
          options: {
            isWholeLine: true,
            className: 'debug-current-line',
            glyphMarginClassName: 'debug-current-glyph',
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
          }
        }
      ])
    } else {
      debugDecorations.current?.clear()
    }
  }, [location, debugState, path])

  return <div className="code-editor" ref={container} data-testid="code-editor" />
}
