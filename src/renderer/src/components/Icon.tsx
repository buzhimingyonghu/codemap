import {
  Bug,
  ChevronDown,
  ChevronRight,
  Circle,
  Code,
  File,
  FileCode,
  FileImage,
  FileText,
  Files,
  Folder,
  FolderOpen,
  GitBranch,
  Puzzle,
  Search,
  Settings,
  SquareTerminal,
  type LucideIcon,
  type LucideProps
} from 'lucide-react'
import { extname } from '@shared/paths'

const NAMED: Record<string, LucideIcon> = {
  files: Files,
  git: GitBranch,
  bug: Bug,
  puzzle: Puzzle,
  settings: Settings,
  terminal: SquareTerminal,
  code: Code,
  circle: Circle,
  search: Search
}

// Plugins pass icon names as strings; unknown names fall back to a puzzle piece.
export function NamedIcon({ name, ...props }: { name?: string } & LucideProps) {
  const Component = (name && NAMED[name]) || Puzzle
  return <Component {...props} />
}

const CODE_EXT = new Set(['.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm', '.swift', '.rs', '.go', '.py', '.js', '.ts', '.tsx', '.jsx', '.java', '.kt', '.rb', '.php', '.cs', '.lua', '.sh', '.zsh', '.html', '.css', '.scss', '.json', '.yml', '.yaml', '.toml', '.xml', '.sql'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.icns'])

const EXT_COLOR: Record<string, string> = {
  '.c': '#7dd3fc',
  '.h': '#c4b5fd',
  '.cpp': '#7dd3fc',
  '.hpp': '#c4b5fd',
  '.swift': '#fb923c',
  '.rs': '#f59e8b',
  '.go': '#67e8f9',
  '.py': '#fcd34d',
  '.js': '#fde047',
  '.ts': '#60a5fa',
  '.tsx': '#60a5fa',
  '.jsx': '#fde047',
  '.json': '#fbbf24',
  '.md': '#94a3b8',
  '.html': '#fb923c',
  '.css': '#38bdf8',
  '.sh': '#86efac'
}

export function FileIcon({ name, size = 15 }: { name: string; size?: number }) {
  const ext = extname(name)
  const color = EXT_COLOR[ext]
  const style = color ? { color } : undefined
  if (IMAGE_EXT.has(ext)) return <FileImage size={size} className="file-icon" style={style} />
  if (CODE_EXT.has(ext)) return <FileCode size={size} className="file-icon" style={style} />
  if (ext === '.md' || ext === '.txt') return <FileText size={size} className="file-icon" style={style} />
  return <File size={size} className="file-icon" style={style} />
}

export function FolderIcon({ open, size = 15 }: { open: boolean; size?: number }) {
  return open ? <FolderOpen size={size} className="folder-icon" /> : <Folder size={size} className="folder-icon" />
}

export function Chevron({ open, size = 14 }: { open: boolean; size?: number }) {
  return open ? <ChevronDown size={size} className="chevron" /> : <ChevronRight size={size} className="chevron" />
}
