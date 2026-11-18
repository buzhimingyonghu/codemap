import { basename, extname } from '@shared/paths'

const BY_EXTENSION: Record<string, string> = {
  '.c': 'c',
  '.h': 'cpp',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.m': 'objective-c',
  '.mm': 'objective-c',
  '.swift': 'swift',
  '.rs': 'rust',
  '.go': 'go',
  '.py': 'python',
  '.rb': 'ruby',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.json': 'json',
  '.jsonc': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.xml': 'xml',
  '.plist': 'xml',
  '.svg': 'xml',
  '.sh': 'shell',
  '.zsh': 'shell',
  '.bash': 'shell',
  '.sql': 'sql',
  '.lua': 'lua',
  '.php': 'php',
  '.cs': 'csharp',
  '.dart': 'dart',
  '.proto': 'protobuf',
  '.graphql': 'graphql',
  '.r': 'r'
}

const BY_NAME: Record<string, string> = {
  makefile: 'shell',
  'cmakelists.txt': 'shell',
  dockerfile: 'dockerfile',
  '.gitignore': 'shell',
  '.zshrc': 'shell',
  '.bashrc': 'shell'
}

export function languageFor(path: string): string {
  const name = basename(path).toLowerCase()
  return BY_NAME[name] ?? BY_EXTENSION[extname(path)] ?? 'plaintext'
}

export function languageLabel(language: string): string {
  const labels: Record<string, string> = {
    c: 'C',
    cpp: 'C++',
    'objective-c': 'Objective-C',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    plaintext: 'Plain Text',
    json: 'JSON',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    yaml: 'YAML',
    xml: 'XML',
    sql: 'SQL',
    php: 'PHP',
    csharp: 'C#',
    ini: 'INI'
  }
  return labels[language] ?? language.charAt(0).toUpperCase() + language.slice(1)
}
