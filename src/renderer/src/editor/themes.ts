import { monaco } from './monaco'

export interface ThemeDefinition {
  id: string
  label: string
  appearance: 'dark' | 'light'
  swatch: [string, string, string]
  editor: {
    background: string
    foreground: string
    lineHighlight: string
    selection: string
    lineNumber: string
    lineNumberActive: string
    cursor: string
    comment: string
    keyword: string
    string: string
    number: string
    type: string
    function: string
    variable: string
    operator: string
    tag: string
    attribute: string
    regexp: string
  }
}

// Each theme is applied twice: CSS variables on <html data-theme> drive the chrome,
// and the matching Monaco theme below keeps the editor in sync.
export const THEMES: ThemeDefinition[] = [
  {
    id: 'graphite',
    label: 'Graphite',
    appearance: 'dark',
    swatch: ['#16181d', '#2dd4bf', '#f59e8b'],
    editor: {
      background: '#16181d',
      foreground: '#d8dee9',
      lineHighlight: '#1d2027',
      selection: '#2dd4bf2e',
      lineNumber: '#4b5263',
      lineNumberActive: '#aab2c0',
      cursor: '#2dd4bf',
      comment: '#6b7385',
      keyword: '#f59e8b',
      string: '#a5d6a7',
      number: '#f3c97a',
      type: '#7dd3fc',
      function: '#93c5fd',
      variable: '#d8dee9',
      operator: '#c0c7d4',
      tag: '#f59e8b',
      attribute: '#f3c97a',
      regexp: '#e6a2d0'
    }
  },
  {
    id: 'paper',
    label: 'Paper',
    appearance: 'light',
    swatch: ['#fbfbfa', '#0f766e', '#c2410c'],
    editor: {
      background: '#ffffff',
      foreground: '#24292f',
      lineHighlight: '#f4f6f6',
      selection: '#0f766e24',
      lineNumber: '#b5bcc4',
      lineNumberActive: '#4b5560',
      cursor: '#0f766e',
      comment: '#8a939e',
      keyword: '#c2410c',
      string: '#15803d',
      number: '#a16207',
      type: '#0369a1',
      function: '#1d4ed8',
      variable: '#24292f',
      operator: '#4b5560',
      tag: '#c2410c',
      attribute: '#a16207',
      regexp: '#a21caf'
    }
  },
  {
    id: 'midnight',
    label: 'Midnight',
    appearance: 'dark',
    swatch: ['#0c0d10', '#a3e635', '#fb7185'],
    editor: {
      background: '#0c0d10',
      foreground: '#e5e7eb',
      lineHighlight: '#14161a',
      selection: '#a3e63524',
      lineNumber: '#3f444e',
      lineNumberActive: '#9ca3af',
      cursor: '#a3e635',
      comment: '#5f6672',
      keyword: '#fb7185',
      string: '#a3e635',
      number: '#fbbf24',
      type: '#67e8f9',
      function: '#c4b5fd',
      variable: '#e5e7eb',
      operator: '#9ca3af',
      tag: '#fb7185',
      attribute: '#fbbf24',
      regexp: '#f0abfc'
    }
  }
]

function strip(color: string): string {
  return color.replace('#', '')
}

let defined = false

function defineThemes(): void {
  if (defined) return
  defined = true
  for (const theme of THEMES) {
    const c = theme.editor
    monaco.editor.defineTheme(`codemap-${theme.id}`, {
      base: theme.appearance === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [
        { token: '', foreground: strip(c.foreground) },
        { token: 'comment', foreground: strip(c.comment), fontStyle: 'italic' },
        { token: 'keyword', foreground: strip(c.keyword) },
        { token: 'keyword.control', foreground: strip(c.keyword) },
        { token: 'storage', foreground: strip(c.keyword) },
        { token: 'string', foreground: strip(c.string) },
        { token: 'string.escape', foreground: strip(c.regexp) },
        { token: 'number', foreground: strip(c.number) },
        { token: 'constant', foreground: strip(c.number) },
        { token: 'regexp', foreground: strip(c.regexp) },
        { token: 'type', foreground: strip(c.type) },
        { token: 'type.identifier', foreground: strip(c.type) },
        { token: 'identifier', foreground: strip(c.variable) },
        { token: 'function', foreground: strip(c.function) },
        { token: 'delimiter', foreground: strip(c.operator) },
        { token: 'operator', foreground: strip(c.operator) },
        { token: 'tag', foreground: strip(c.tag) },
        { token: 'metatag', foreground: strip(c.tag) },
        { token: 'attribute.name', foreground: strip(c.attribute) },
        { token: 'attribute.value', foreground: strip(c.string) },
        { token: 'key', foreground: strip(c.type) },
        { token: 'string.key.json', foreground: strip(c.type) },
        { token: 'string.value.json', foreground: strip(c.string) },
        { token: 'annotation', foreground: strip(c.attribute) },
        { token: 'predefined', foreground: strip(c.function) }
      ],
      colors: {
        'editor.background': c.background,
        'editor.foreground': c.foreground,
        'editor.lineHighlightBackground': c.lineHighlight,
        'editor.lineHighlightBorder': '#00000000',
        'editor.selectionBackground': c.selection,
        'editor.inactiveSelectionBackground': c.selection,
        'editorLineNumber.foreground': c.lineNumber,
        'editorLineNumber.activeForeground': c.lineNumberActive,
        'editorCursor.foreground': c.cursor,
        'editorIndentGuide.background1': `${c.lineNumber}40`,
        'editorIndentGuide.activeBackground1': `${c.lineNumber}a0`,
        'editorGutter.background': c.background,
        'editorWidget.background': c.lineHighlight,
        'editorWidget.border': `${c.lineNumber}55`,
        'editorSuggestWidget.background': c.lineHighlight,
        'editorHoverWidget.background': c.lineHighlight,
        'scrollbarSlider.background': `${c.lineNumber}40`,
        'scrollbarSlider.hoverBackground': `${c.lineNumber}70`,
        'scrollbarSlider.activeBackground': `${c.lineNumber}90`,
        'diffEditor.insertedTextBackground': theme.appearance === 'dark' ? '#22c55e22' : '#16a34a1f',
        'diffEditor.removedTextBackground': theme.appearance === 'dark' ? '#ef444426' : '#dc26261f',
        'diffEditor.insertedLineBackground': theme.appearance === 'dark' ? '#22c55e12' : '#16a34a10',
        'diffEditor.removedLineBackground': theme.appearance === 'dark' ? '#ef444414' : '#dc262610',
        'minimap.background': c.background,
        // Peek (definition / references) widget follows the theme instead of Monaco's default blue.
        'peekView.border': c.cursor,
        'peekViewTitle.background': c.lineHighlight,
        'peekViewTitleLabel.foreground': c.foreground,
        'peekViewTitleDescription.foreground': c.comment,
        'peekViewEditor.background': c.background,
        'peekViewEditorGutter.background': c.background,
        'peekViewEditor.matchHighlightBackground': `${c.number}40`,
        'peekViewResult.background': c.lineHighlight,
        'peekViewResult.fileForeground': c.foreground,
        'peekViewResult.lineForeground': c.operator,
        'peekViewResult.matchHighlightBackground': `${c.number}40`,
        'peekViewResult.selectionBackground': c.selection,
        'peekViewResult.selectionForeground': c.foreground,
        'editor.wordHighlightBackground': `${c.lineNumber}40`,
        'editor.wordHighlightStrongBackground': `${c.lineNumber}55`
      }
    })
  }
}

export function getTheme(id: string): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]
}

export function applyTheme(id: string): void {
  defineThemes()
  const theme = getTheme(id)
  document.documentElement.dataset.theme = theme.id
  document.documentElement.style.colorScheme = theme.appearance
  monaco.editor.setTheme(`codemap-${theme.id}`)
}
