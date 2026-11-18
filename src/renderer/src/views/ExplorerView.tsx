import { FilePlus, FolderPlus, ListCollapse, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { basename, dirname, isValidEntryName, joinPath } from '@shared/paths'
import type { DirEntry } from '@shared/types'
import { Chevron, FileIcon, FolderIcon } from '../components/Icon'
import { IconButton } from '../components/IconButton'
import { t } from '../lib/i18n'
import { handleRenamed, openFile } from '../services/documents'
import { copyEntries, cutEntries, dropOnto, duplicate, pasteInto } from '../services/fileClipboard'
import { gitDecoration } from '../services/git'
import { searchIn } from '../services/search'
import { confirm, reportError } from '../services/ui'
import { createEntry, deleteEntry, loadChildren, openFolderDialog, toggleFolder } from '../services/workspace'
import { getState, setState, useStore } from '../state/store'

// Internal drags carry workspace paths; Finder drags carry File objects.
const INTERNAL_DRAG = 'application/x-codemap-paths'

function droppedPaths(event: DragEvent): string[] {
  const internal = event.dataTransfer.getData(INTERNAL_DRAG)
  if (internal) {
    try {
      return JSON.parse(internal) as string[]
    } catch {
      return []
    }
  }
  return [...event.dataTransfer.files].map((file) => window.codemap.fs.pathForFile(file)).filter(Boolean)
}

function hasDroppableData(event: DragEvent): boolean {
  const types = [...event.dataTransfer.types]
  return types.includes(INTERNAL_DRAG) || types.includes('Files')
}

interface Row {
  entry: DirEntry
  depth: number
}

const GIT_LETTER: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', untracked: 'U', conflicted: '!' }

function flatten(root: string, children: Record<string, DirEntry[] | undefined>, expanded: Record<string, boolean>): Row[] {
  const rows: Row[] = []
  const walk = (dir: string, depth: number) => {
    for (const entry of children[dir] ?? []) {
      rows.push({ entry, depth })
      if (entry.kind === 'directory' && expanded[entry.path]) walk(entry.path, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

function InlineInput({ initial, depth, kind, onDone }: { initial: string; depth: number; kind: 'file' | 'directory'; onDone: (value: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initial)
  const valid = !value || isValidEntryName(value)
  useEffect(() => {
    const input = ref.current
    if (!input) return
    input.focus()
    const dot = initial.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 && kind === 'file' ? dot : initial.length)
  }, [initial, kind])
  const commit = () => onDone(value.trim() && valid ? value.trim() : null)
  return (
    <div className="tree-row tree-row--input" style={{ paddingLeft: 10 + depth * 14 }}>
      <span className="tree-twist" />
      {kind === 'directory' ? <FolderIcon open={false} /> : <FileIcon name={value || 'file'} />}
      <input
        ref={ref}
        className={`tree-input${valid ? '' : ' is-invalid'}`}
        value={value}
        aria-label={kind === 'directory' ? t('Folder name') : t('File name')}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') onDone(null)
        }}
      />
    </div>
  )
}

export function ExplorerView() {
  const workspace = useStore((s) => s.workspace)
  const children = useStore((s) => s.children)
  const expanded = useStore((s) => s.expanded)
  const selectedPath = useStore((s) => s.selectedPath)
  const renamingPath = useStore((s) => s.renamingPath)
  const creating = useStore((s) => s.creating)
  const dirty = useStore((s) => s.dirty)
  const cutPaths = useStore((s) => s.cutPaths)
  const dropTarget = useStore((s) => s.dropTarget)
  useStore((s) => s.git)
  const listRef = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)

  const rows = useMemo(() => (workspace ? flatten(workspace.root, children, expanded) : []), [workspace, children, expanded])

  if (!workspace) {
    return (
      <div className="view-empty">
        <p>{t('No folder open')}</p>
        <button type="button" className="button button--primary" onClick={() => void openFolderDialog()}>
          {t('Open Folder')}
        </button>
      </div>
    )
  }

  const targetDir = (): string => {
    if (!selectedPath) return workspace.root
    const row = rows.find((r) => r.entry.path === selectedPath)
    if (row?.entry.kind === 'directory') return row.entry.path
    return selectedPath.startsWith(workspace.root) ? dirname(selectedPath) : workspace.root
  }

  const startCreate = async (kind: 'file' | 'directory', parent = targetDir()) => {
    if (parent !== workspace.root) await toggleFolder(parent, true)
    setState({ creating: { parent, kind }, renamingPath: null })
  }

  const finishCreate = async (name: string | null) => {
    const pending = getState().creating
    setState({ creating: null })
    if (!name || !pending) return
    const created = await createEntry(pending.parent, name, pending.kind)
    if (created) {
      setState({ selectedPath: created })
      if (pending.kind === 'file') await openFile(created)
    }
  }

  const finishRename = async (entry: DirEntry, name: string | null) => {
    setState({ renamingPath: null })
    if (!name || name === entry.name) return
    try {
      const target = await window.codemap.fs.rename(entry.path, name)
      handleRenamed(entry.path, target)
      if (entry.kind === 'directory') {
        const nextExpanded = { ...getState().expanded }
        if (nextExpanded[entry.path]) {
          delete nextExpanded[entry.path]
          nextExpanded[target] = true
        }
        setState({ expanded: nextExpanded })
      }
      await loadChildren(dirname(entry.path))
      setState({ selectedPath: target })
    } catch (error) {
      reportError(error, t('Cannot rename {name}', { name: entry.name }))
    }
  }

  const remove = async (entry: DirEntry) => {
    const ok = await confirm(t('Move "{name}" to Trash?', { name: entry.name }), t('You can restore it from the Trash in Finder.'), t('Move to Trash'), true)
    if (!ok) return
    try {
      await deleteEntry(entry.path)
    } catch (error) {
      reportError(error, t('Cannot delete {name}', { name: entry.name }))
    }
  }

  const activate = (entry: DirEntry) => {
    setState({ selectedPath: entry.path })
    if (entry.kind === 'directory') void toggleFolder(entry.path)
    else void openFile(entry.path)
  }

  const showMenu = async (entry: DirEntry | null) => {
    if (entry) setState({ selectedPath: entry.path })
    const isDir = entry?.kind === 'directory'
    const parent = entry ? (isDir ? entry.path : dirname(entry.path)) : workspace.root
    const clipboardFiles: string[] = await window.codemap.fs.readClipboardFiles().catch(() => [])
    const choice = await window.codemap.app.popupMenu([
      { id: 'newFile', label: t('New File') },
      { id: 'newFolder', label: t('New Folder') },
      { separator: true },
      { id: 'copy', label: t('Copy'), enabled: Boolean(entry) },
      { id: 'cut', label: t('Cut'), enabled: Boolean(entry) },
      {
        id: 'paste',
        label: clipboardFiles.length > 1 ? t('Paste {n} Items', { n: clipboardFiles.length }) : clipboardFiles.length === 1 ? t('Paste "{name}"', { name: basename(clipboardFiles[0]) }) : t('Paste'),
        enabled: clipboardFiles.length > 0
      },
      { id: 'duplicate', label: t('Duplicate'), enabled: Boolean(entry) },
      { separator: true },
      { id: 'search', label: isDir || !entry ? t('Find in Folder…') : t('Find in File…') },
      { separator: true },
      { id: 'reveal', label: t('Reveal in Finder'), enabled: Boolean(entry) },
      { id: 'copyPath', label: t('Copy Path'), enabled: Boolean(entry) },
      { id: 'copyRelative', label: t('Copy Relative Path'), enabled: Boolean(entry) },
      { separator: true },
      { id: 'rename', label: t('Rename…'), enabled: Boolean(entry) },
      { id: 'delete', label: t('Move to Trash'), enabled: Boolean(entry) }
    ])
    if (choice === 'newFile') await startCreate('file', parent)
    if (choice === 'newFolder') await startCreate('directory', parent)
    if (choice === 'paste') await pasteInto(parent)
    if (choice === 'search') searchIn([entry?.path ?? workspace.root])
    if (!entry) return
    if (choice === 'copy') await copyEntries([entry.path])
    if (choice === 'cut') await cutEntries([entry.path])
    if (choice === 'duplicate') await duplicate(entry.path)
    if (choice === 'reveal') await window.codemap.fs.reveal(entry.path)
    if (choice === 'copyPath') await navigator.clipboard.writeText(entry.path)
    if (choice === 'copyRelative') await navigator.clipboard.writeText(entry.path.slice(workspace.root.length + 1))
    if (choice === 'rename') setState({ renamingPath: entry.path })
    if (choice === 'delete') await remove(entry)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.entry.path === selectedPath)
    const current = rows[index]?.entry
    const select = (next: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, next))]
      if (!row) return
      setState({ selectedPath: row.entry.path })
      listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(row.entry.path)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    if (event.key === 'ArrowDown') select(index + 1)
    else if (event.key === 'ArrowUp') select(index <= 0 ? 0 : index - 1)
    else if (event.key === 'ArrowRight' && current?.kind === 'directory') void toggleFolder(current.path, true)
    else if (event.key === 'ArrowLeft' && current) {
      if (current.kind === 'directory' && expanded[current.path]) void toggleFolder(current.path, false)
      else select(rows.findIndex((row) => row.entry.path === dirname(current.path)))
    } else if (event.key === 'Enter' && current) setState({ renamingPath: current.path })
    else if ((event.key === ' ' || (event.key === 'ArrowDown' && event.metaKey)) && current) activate(current)
    else if (event.key === 'Backspace' && event.metaKey && current) void remove(current)
    else if (event.metaKey && event.key.toLowerCase() === 'c' && current) void copyEntries([current.path])
    else if (event.metaKey && event.key.toLowerCase() === 'x' && current) void cutEntries([current.path])
    else if (event.metaKey && event.key.toLowerCase() === 'v') void pasteInto(targetDir())
    else if (event.metaKey && event.key.toLowerCase() === 'd' && current) void duplicate(current.path)
    else return
    event.preventDefault()
  }

  const folderFor = (entry: DirEntry | null) => (!entry ? workspace.root : entry.kind === 'directory' ? entry.path : dirname(entry.path))

  const onDragOver = (event: DragEvent, entry: DirEntry | null) => {
    if (!hasDroppableData(event)) return
    event.preventDefault()
    event.stopPropagation()
    const internal = [...event.dataTransfer.types].includes(INTERNAL_DRAG)
    event.dataTransfer.dropEffect = internal && !event.altKey ? 'move' : 'copy'
    const target = folderFor(entry)
    if (getState().dropTarget !== target) setState({ dropTarget: target })
  }

  const onDrop = async (event: DragEvent, entry: DirEntry | null) => {
    if (!hasDroppableData(event)) return
    event.preventDefault()
    event.stopPropagation()
    dragDepth.current = 0
    const target = folderFor(entry)
    setState({ dropTarget: null })
    const sources = droppedPaths(event)
    if (sources.length) await dropOnto(target, sources, event.altKey)
  }

  const collapseAll = () => setState({ expanded: { [workspace.root]: true } })
  const refresh = async () => {
    const dirs = Object.keys(getState().children)
    await Promise.all(dirs.map((dir) => loadChildren(dir)))
  }

  const createRowFor = (parent: string, depth: number) =>
    creating && creating.parent === parent ? (
      <InlineInput key={`create:${parent}`} initial="" depth={depth} kind={creating.kind} onDone={(value) => void finishCreate(value)} />
    ) : null

  return (
    <div className="explorer">
      <div className="view-header">
        <span className="view-title" title={workspace.root}>
          {workspace.name}
        </span>
        <div className="view-actions">
          <IconButton size="sm" label={t('New File')} onClick={() => void startCreate('file')}>
            <FilePlus size={15} />
          </IconButton>
          <IconButton size="sm" label={t('New Folder')} onClick={() => void startCreate('directory')}>
            <FolderPlus size={15} />
          </IconButton>
          <IconButton size="sm" label={t('Refresh')} onClick={() => void refresh()}>
            <RefreshCw size={14} />
          </IconButton>
          <IconButton size="sm" label={t('Collapse Folders')} onClick={collapseAll}>
            <ListCollapse size={15} />
          </IconButton>
        </div>
      </div>
      <div
        ref={listRef}
        className="tree"
        role="tree"
        aria-label={t('Files')}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault()
            void showMenu(null)
          }
        }}
        onDragEnter={(event) => {
          if (hasDroppableData(event)) dragDepth.current++
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setState({ dropTarget: null })
        }}
        onDragOver={(event) => onDragOver(event, null)}
        onDrop={(event) => void onDrop(event, null)}
        data-drop-root={dropTarget === workspace.root ? 'true' : undefined}
      >
        {createRowFor(workspace.root, 0)}
        {rows.map(({ entry, depth }) => {
          const isDir = entry.kind === 'directory'
          const open = Boolean(expanded[entry.path])
          const decoration = gitDecoration(entry.path)
          if (renamingPath === entry.path) {
            return <InlineInput key={entry.path} initial={entry.name} depth={depth} kind={entry.kind} onDone={(value) => void finishRename(entry, value)} />
          }
          return (
            <div key={entry.path} className="tree-group">
              <div
                role="treeitem"
                aria-selected={selectedPath === entry.path}
                aria-expanded={isDir ? open : undefined}
                data-path={entry.path}
                className={`tree-row${selectedPath === entry.path ? ' is-selected' : ''}${decoration ? ` git-${decoration}` : ''}${cutPaths.includes(entry.path) ? ' is-cut' : ''}${isDir && dropTarget === entry.path ? ' is-drop-target' : ''}`}
                style={{ paddingLeft: 10 + depth * 14 }}
                onClick={() => activate(entry)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  void showMenu(entry)
                }}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(INTERNAL_DRAG, JSON.stringify([entry.path]))
                  event.dataTransfer.setData('text/plain', entry.path)
                  event.dataTransfer.effectAllowed = 'copyMove'
                }}
                onDragEnd={() => setState({ dropTarget: null })}
                onDragOver={(event) => onDragOver(event, entry)}
                onDrop={(event) => void onDrop(event, entry)}
              >
                <span className="tree-indent" style={{ width: depth * 14 }} aria-hidden="true">
                  {Array.from({ length: depth }, (_, i) => (
                    <span key={i} className="tree-guide" style={{ left: 16 + i * 14 }} />
                  ))}
                </span>
                <span className="tree-twist">{isDir ? <Chevron open={open} size={13} /> : null}</span>
                {isDir ? <FolderIcon open={open} /> : <FileIcon name={entry.name} />}
                <span className="tree-label">{entry.name}</span>
                {!isDir && dirty[entry.path] ? <span className="tree-dirty" aria-label={t('Unsaved')} /> : null}
                {decoration ? <span className="tree-git">{isDir ? '' : GIT_LETTER[decoration]}</span> : null}
              </div>
              {isDir && open ? createRowFor(entry.path, depth + 1) : null}
            </div>
          )
        })}
        {rows.length === 0 && !creating ? <div className="tree-empty">{t('This folder is empty')}</div> : null}
      </div>
    </div>
  )
}

export function pathLabel(root: string, path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : basename(path)
}

export { joinPath }
