import { ArrowUp, ChevronRight, FilePlus, FolderPlus, LoaderCircle, LocateFixed, Map as MapIcon, RotateCcw, Scan, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent } from 'react'
import { IconButton } from '../components/IconButton'
import { getTheme } from '../editor/themes'
import { mapColors } from '../map/colors'
import { MapEngine, type Hit, type MapHost } from '../map/engine'
import { chainOf, DEPTH_NAMES, filesUnder, nodeAt, regionAt, startFocus, townsOf, type MapNode, type MapTree } from '../map/model'
import { getActiveEditor, openFile } from '../services/documents'
import { copyEntries, cutEntries, dropOnto, duplicate, pasteInto } from '../services/fileClipboard'
import { searchIn } from '../services/search'
import {
  createInMap,
  ensureMap,
  frequentMapFolders,
  layoutThread,
  liftOff,
  onDidRequestReveal,
  recordVisit,
  rememberFocus,
  rememberedFocus,
  renameFromMap,
  resetUsage,
  takePendingReveal,
  toAbsolute,
  toRelative,
  trashFromMap,
  useMapData
} from '../services/projectMap'
import { getState, setState, useStore } from '../state/store'
import { EditorArea } from '../workbench/EditorArea'
import { t } from '../lib/i18n'

// Internal drags carry workspace paths; Finder drags carry File objects.
const INTERNAL_DRAG = 'application/x-codemap-paths'
const HOT_LIMIT = 6
const FREQUENT_LIMIT = 5

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

/** Re-renders whenever the engine reports a change the chrome shows (focus, landing, colors). */
function useEngine(engine: MapEngine | null): number {
  const subscribe = useCallback((listener: () => void) => (engine ? engine.subscribe(listener) : () => undefined), [engine])
  return useSyncExternalStore(subscribe, () => engine?.version ?? 0)
}

export function ProjectMapView() {
  const workspace = useStore((s) => s.workspace)
  const editorOpen = useStore((s) => s.mapEditorOpen)
  const hasTabs = useStore((s) => s.tabs.length > 0)
  const map = useMapData()
  const stageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void ensureMap()
  }, [workspace?.root])

  // Esc returns from the editor to the map. Monaco consumes Esc itself whenever one of its
  // widgets (find, suggest, peek, rename) is open, so those still close first; dialogs and
  // inputs elsewhere keep their own Esc.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !getState().mapEditorOpen) return
      if (getState().quickPick || getState().prompt || getState().settingsOpen) return
      const target = event.target as HTMLElement | null
      if (target && target !== document.body && !target.closest('.project-map')) return
      event.preventDefault()
      liftOff()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!workspace) return null
  const showEditor = editorOpen && hasTabs

  return (
    <div ref={stageRef} className={`project-map${showEditor ? ' is-editing' : ''}`}>
      {map.tree && map.root === workspace.root ? (
        <MapStage key={workspace.root} root={workspace.root} tree={map.tree} heatVersion={map.heatVersion} frozen={showEditor} truncated={map.truncated} />
      ) : (
        <MapPlaceholder status={map.status} error={map.error} fileCount={map.fileCount} />
      )}
      <section className="map-editor" aria-label={t('Editor')} aria-hidden={!showEditor} inert={!showEditor}>
        <EditorArea />
        <button type="button" className="map-liftoff" data-tooltip={t('Back to Map (Esc)')} aria-label={t('Back to Map')} onClick={liftOff}>
          <MapIcon size={14} />
          <span>MAP</span>
        </button>
      </section>
    </div>
  )
}

function MapPlaceholder({ status, error, fileCount }: { status: string; error?: string; fileCount: number }) {
  return (
    <div className="map-placeholder" role="status">
      {status === 'error' ? (
        <>
          <TriangleAlert size={18} />
          <span>{t('Cannot build the map')}</span>
          {error ? <span className="map-placeholder-detail">{error}</span> : null}
          <button type="button" className="button" onClick={() => void ensureMap(true)}>
            {t('Try Again')}
          </button>
        </>
      ) : (
        <>
          <LoaderCircle size={18} className="spin" />
          <span>{fileCount ? t('Surveying {n} files', { n: fileCount.toLocaleString() }) : t('Surveying project')}</span>
        </>
      )}
    </div>
  )
}

interface StageProps {
  root: string
  tree: MapTree
  heatVersion: number
  frozen: boolean
  truncated: boolean
}

function MapStage({ root, tree, heatVersion, frozen, truncated }: StageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [engine, setEngine] = useState<MapEngine | null>(null)
  const themeId = useStore((s) => s.theme)
  const git = useStore((s) => s.git)
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const cutPaths = useStore((s) => s.cutPaths)
  const itemsPerScreen = useStore((s) => s.mapItemsPerScreen)
  const dragDepth = useRef(0)
  const appearance = getTheme(themeId).appearance
  useEngine(engine)

  // The engine lives as long as this folder's map; tree updates are pushed into it.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const host: MapHost = {
      open: async (file) => {
        const path = toAbsolute(root, file.rel)
        await openFile(path)
        const ok = getState().activeTabId === path
        // Landed to work on the file: put the cursor in it once the editor has risen.
        if (ok) window.setTimeout(() => getState().mapEditorOpen && getState().activeTabId === path && getActiveEditor()?.focus(), 120)
        return ok
      },
      contextMenu: (hit) => void showMenu(root, hit, (node) => instance.enter(node)),
      entered: (folder) => recordVisit(folder.rel)
    }
    const instance = new MapEngine(canvas, tree, mapColors(appearance), host)
    instance.itemsPerScreen = getState().mapItemsPerScreen
    const start = takePendingReveal()
    const startRel = start ? toRelative(root, start) : null
    const remembered = rememberedFocus(root)
    instance.jumpTo(startRel !== null ? regionAt(tree, startRel) : remembered !== null ? regionAt(tree, remembered) : startFocus(tree))
    if (startRel !== null) instance.reveal(nodeAt(tree, startRel))
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(canvas)
    setEngine(instance)
    const unsubscribe = instance.subscribe(() => rememberFocus(root, instance.focus.rel))
    // Test-only handle, present solely when launched with CODEMAP_E2E=1.
    const testHook = getState().appInfo?.e2e ? (window as unknown as { __codemapProjectMap?: unknown }) : null
    if (testHook) {
      testHook.__codemapProjectMap = {
        engine: instance,
        layoutThread,
        point: (rel: string) => instance.clientPoint(nodeAt(instance.tree, rel)),
        focus: () => instance.focus.rel,
        district: () => instance.district?.name ?? null,
        settled: () => instance.idle
      }
    }
    return () => {
      if (testHook) delete testHook.__codemapProjectMap
      unsubscribe()
      observer.disconnect()
      instance.destroy()
      setEngine(null)
    }
    // Created once per folder; tree, colors, and decorations flow in through the effects below.
  }, [root])

  useEffect(() => engine?.setTree(tree), [engine, tree, heatVersion])
  useEffect(() => engine?.setColors(mapColors(appearance)), [engine, appearance])
  useEffect(() => engine?.setFrozen(frozen), [engine, frozen])
  useEffect(() => engine?.setItemsPerScreen(itemsPerScreen), [engine, itemsPerScreen])

  // The right column (summary, quick jumps, prefixes) floats over the map; measure it so the
  // camera frames and centres in the part of the map that stays visible.
  const sideRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const side = sideRef.current
    const canvas = canvasRef.current
    if (!engine || !canvas) return
    const update = () => {
      const c = canvas.getBoundingClientRect()
      const box = side ? side.getBoundingClientRect() : null
      const visible = side && box && box.width > 0 && getComputedStyle(side).display !== 'none'
      engine.setInset(visible && box ? Math.max(0, c.right - box.left + 8) : 0, 0)
    }
    update()
    const observer = new ResizeObserver(update)
    if (side) observer.observe(side)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [engine])

  useEffect(() => {
    if (!engine) return
    const modified = new Set<string>()
    if (git?.isRepo) for (const file of git.files) if (file.worktree !== null || file.index !== null) modified.add(file.path)
    const open = new Set<string>()
    for (const tab of tabs) {
      const rel = tab.kind === 'file' && tab.path ? toRelative(root, tab.path) : null
      if (rel) open.add(rel)
    }
    const active = activeTabId ? toRelative(root, activeTabId) : null
    engine.setDecorations({ modified, open, active })
  }, [engine, git, tabs, activeTabId, root])

  useEffect(() => {
    if (!engine) return
    const subscription = onDidRequestReveal.on((path) => {
      takePendingReveal()
      const rel = toRelative(root, path)
      if (rel !== null) engine.reveal(nodeAt(engine.tree, rel))
    })
    return () => subscription.dispose()
  }, [engine, root])

  // Home / Backspace / Esc drive the map when it has keyboard focus.
  useEffect(() => {
    if (!engine) return
    const onKey = (event: KeyboardEvent) => {
      if (getState().mapEditorOpen || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && target !== document.body && !target.closest('.project-map')) return
      if (target?.closest('input, textarea, [contenteditable="true"], .monaco-editor')) return
      if (getState().quickPick || getState().prompt || getState().settingsOpen) return
      if (event.key === 'Escape' || event.key === 'Backspace') engine.goUp()
      else if (event.key === 'Home') engine.home()
      else if (event.key === '0') engine.overview()
      else if (event.key === 'Enter' && getState().tabs.length) setState({ mapEditorOpen: true })
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine])

  const onDragOver = (event: DragEvent) => {
    if (!engine || frozen || !hasDroppableData(event)) return
    event.preventDefault()
    const internal = [...event.dataTransfer.types].includes(INTERNAL_DRAG)
    event.dataTransfer.dropEffect = internal && !event.altKey ? 'move' : 'copy'
    engine.setDropTarget(engine.folderAt(event.clientX, event.clientY))
  }

  const onDrop = async (event: DragEvent) => {
    if (!engine || frozen || !hasDroppableData(event)) return
    event.preventDefault()
    dragDepth.current = 0
    const folder = engine.folderAt(event.clientX, event.clientY)
    engine.setDropTarget(null)
    const sources = droppedPaths(event)
    if (sources.length) await dropOnto(toAbsolute(root, folder.rel), sources, event.altKey)
  }

  const focus = engine?.focus ?? tree.root
  const hidden = frozen || Boolean(engine?.landing)

  return (
    <div
      className={`map-stage${engine?.landing ? ' is-landing' : ''}`}
      onDragEnter={(event) => {
        if (hasDroppableData(event)) dragDepth.current++
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) engine?.setDropTarget(null)
      }}
      onDragOver={onDragOver}
      onDrop={(event) => void onDrop(event)}
    >
      <canvas ref={canvasRef} className="map-canvas" tabIndex={-1} aria-label={t('Map of {name}', { name: tree.root.name })} data-focus={focus.rel} />
      {engine ? (
        <div className={`map-hud${hidden ? ' is-hidden' : ''}`} inert={hidden}>
          <Trail engine={engine} focus={focus} />
          <div className="map-side" ref={sideRef}>
            <PeaksPanel engine={engine} focus={focus} cutPaths={cutPaths} root={root} />
            {focus.districts.length ? <PrefixIndex engine={engine} focus={focus} /> : null}
          </div>
          <div className="map-legend" aria-hidden="true">
            <span>
              <i className="map-dot is-hot" />
              {t('Frequently used')}
            </span>
            <span>
              <i className="map-dot is-modified" />
              {t('Modified')}
            </span>
            {truncated ? <span className="map-legend-warn">{t('Showing the first 20,000 files')}</span> : null}
          </div>
          <div className="map-dock" role="toolbar" aria-label={t('Map controls')}>
            <IconButton label={t('New File')} onClick={() => void createInMap('file', toAbsolute(root, focus.rel))}>
              <FilePlus size={15} />
            </IconButton>
            <IconButton label={t('New Folder')} onClick={() => void createInMap('directory', toAbsolute(root, focus.rel))}>
              <FolderPlus size={15} />
            </IconButton>
            <span className="map-dock-sep" />
            <IconButton label={t('Whole Map (Home)')} onClick={() => engine.home()}>
              <LocateFixed size={15} />
            </IconButton>
            {engine.roaming ? (
              <IconButton label={t('See Whole Folder (0)')} onClick={() => engine.overview()}>
                <Scan size={15} />
              </IconButton>
            ) : null}
            <IconButton label={t('Up One Level (Esc)')} disabled={!focus.parent} onClick={() => engine.goUp()}>
              <ArrowUp size={15} />
            </IconButton>
            <IconButton label={t('Clear Usage History')} onClick={() => void clearUsage()}>
              <RotateCcw size={14} />
            </IconButton>
          </div>
        </div>
      ) : null}
    </div>
  )
}

async function clearUsage(): Promise<void> {
  const ok = await window.codemap.app.confirm({
    message: t('Clear usage history for this folder?'),
    detail: t('Peaks will be based on recent Git changes only until you open files again.'),
    buttons: [t('Clear'), t('Cancel')],
    cancelId: 1,
    defaultId: 0
  })
  if (ok === 0) resetUsage()
}

function Trail({ engine, focus }: { engine: MapEngine; focus: MapNode }) {
  const chain = chainOf(focus)
  return (
    <nav className="map-trail" aria-label={t('Location')}>
      {chain.flatMap((node, index) => {
        const last = index === chain.length - 1
        // A folded chain (billing/告警) is one level but reads as its real path segments.
        const segments = node.parent ? node.segments : [node.name]
        return segments.map((segment, si) => {
          const current = last && si === segments.length - 1
          return (
            <span key={`${node.id}:${si}`} className="map-trail-item">
              {index > 0 || si > 0 ? <i aria-hidden="true">/</i> : null}
              <button
                type="button"
                className={current ? 'is-current' : undefined}
                aria-current={current ? 'location' : undefined}
                style={{ '--c': engine.focusColor(node) } as CSSProperties}
                onClick={() => engine.enter(node)}
              >
                {segment}
              </button>
            </span>
          )
        })
      })}
    </nav>
  )
}

function PeaksPanel({ engine, focus, root, cutPaths }: { engine: MapEngine; focus: MapNode; root: string; cutPaths: string[] }) {
  const hot = useMemo(
    () =>
      filesUnder(focus)
        .filter((f) => f.heat > 0.05)
        .sort((a, b) => b.heat - a.heat)
        .slice(0, HOT_LIMIT),
    // Heat changes bump the engine version.
    [focus, engine.version]
  )
  const frequent = useMemo(
    () => frequentMapFolders(engine.tree, FREQUENT_LIMIT + 1).filter((n) => n !== focus).slice(0, FREQUENT_LIMIT),
    // Visits change heat, which bumps the engine version.
    [engine.tree, focus, engine.version]
  )
  const depth = DEPTH_NAMES[Math.min(DEPTH_NAMES.length - 1, focus.depth)]
  const prefix = focus.rel ? `${focus.rel}/` : ''
  const here = townsOf(focus).length
  return (
    <aside className="map-panel" aria-label={t('Map summary')}>
      <div className="map-level">
        L{focus.depth} · {t(depth)}
      </div>
      <div className="map-stats">
        <b>{focus.fileCount.toLocaleString()}</b> {t(focus.fileCount === 1 ? 'file' : 'files')}
        <span>·</span>
        <b>{focus.regions.length}</b> {t(focus.regions.length === 1 ? 'region' : 'regions')}
        <span>·</span>
        <b>{here}</b> {t('here')}
      </div>
      <h3>{t('PEAKS')}</h3>
      <ol className="map-hot">
        {hot.length ? (
          hot.map((file) => {
            const path = toAbsolute(root, file.rel)
            const rel = file.rel.startsWith(prefix) ? file.rel.slice(prefix.length) : file.rel
            const slash = rel.lastIndexOf('/')
            return (
              <li key={file.id}>
                <button
                  type="button"
                  className={cutPaths.includes(path) ? 'is-cut' : undefined}
                  style={{ '--c': engine.colorOf(file), '--h': `${Math.round(file.heat * 100)}%` } as CSSProperties}
                  title={file.rel}
                  onClick={() => engine.landOn(file)}
                >
                  <span className="map-hot-bar" />
                  <span className="map-hot-name">
                    {slash > 0 ? <span className="map-hot-dir">{rel.slice(0, slash + 1)}</span> : null}
                    <span className="map-hot-file">{rel.slice(slash + 1)}</span>
                  </span>
                  <span className="map-hot-count">{file.opens ? `${file.opens}×` : ''}</span>
                </button>
              </li>
            )
          })
        ) : (
          <li className="map-hot-empty">{t('No peaks yet')}</li>
        )}
      </ol>
      {frequent.length ? (
        <>
          <h3>{t('FREQUENT')}</h3>
          <ol className="map-hot">
            {frequent.map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  style={{ '--c': engine.focusColor(folder), '--h': '0%' } as CSSProperties}
                  title={folder.rel}
                  onClick={() => engine.enter(folder)}
                >
                  <span className="map-hot-name">
                    {folder.rel.includes('/') ? <span className="map-hot-dir">{folder.rel.slice(0, folder.rel.lastIndexOf('/') + 1)}</span> : null}
                    <span className="map-hot-file">{folder.rel.slice(folder.rel.lastIndexOf('/') + 1)}/</span>
                  </span>
                  <span className="map-hot-count">{folder.visits ? `${folder.visits}×` : ''}</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </aside>
  )
}

/** Every prefix district of the focus in name order; nested ones fold under their parent. */
function PrefixIndex({ engine, focus }: { engine: MapEngine; focus: MapNode }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const current = engine.district
  // The current district and its outer districts are always unfolded.
  const trail = new Set<MapNode>()
  for (let d: MapNode | null = current; d && d !== focus; d = d.holder) trail.add(d)
  const rows: Array<{ node: MapNode; level: number; nested: boolean }> = []
  const visit = (holder: MapNode, level: number) => {
    for (const d of holder.kids) {
      if (!d.virtual) continue
      const nested = d.kids.some((k) => k.virtual)
      rows.push({ node: d, level, nested })
      if (nested && (open.has(d.id) || trail.has(d))) visit(d, level + 1)
    }
  }
  visit(focus, 0)
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    // Scroll only the list; scrollIntoView would also shift the map's clipped containers.
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>('.is-current')
    if (!list || !row) return
    const top = row.offsetTop - list.offsetTop
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight
  }, [current])
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <nav className="map-index" aria-label={t('Prefixes')}>
      <h3>
        {t('PREFIXES')}<span>{focus.districts.filter((d) => d.holder === focus).length}</span>
      </h3>
      <ol ref={listRef}>
        {rows.map(({ node, level, nested }) => {
          const unfolded = nested && (open.has(node.id) || trail.has(node))
          const isCurrent = node === current
          return (
            <li key={node.id}>
              <button
                type="button"
                className={`${isCurrent ? 'is-current' : ''}${trail.has(node) && !isCurrent ? ' is-trail' : ''}${node.group !== 'prefix' ? ' is-loose' : ''}`}
                style={{ '--c': engine.layerColor(node), '--lv': level } as CSSProperties}
                title={node.prefix || node.name}
                onClick={() => engine.showDistrict(node)}
              >
                <span
                  className={`map-index-twist${unfolded ? ' is-open' : ''}`}
                  aria-hidden={!nested}
                  onClick={(event) => {
                    if (!nested) return
                    event.stopPropagation()
                    toggle(node.id)
                  }}
                >
                  {nested ? <ChevronRight size={11} /> : null}
                </span>
                <span className="map-index-swatch" />
                <span className="map-index-name">{node.group === 'prefix' ? node.name : t(node.name)}</span>
                <span className="map-index-count">{node.members}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

async function showMenu(root: string, hit: Hit, enter: (node: MapNode) => void): Promise<void> {
  const node = hit.node
  const path = toAbsolute(root, node.rel)
  const isFile = node.kind === 'file'
  const folder = isFile ? toAbsolute(root, node.parent?.rel ?? '') : path
  const clipboardFiles: string[] = await window.codemap.fs.readClipboardFiles().catch(() => [])
  const choice = await window.codemap.app.popupMenu([
    ...(isFile ? [{ id: 'open', label: t('Open') }] : [{ id: 'enter', label: t('Enter') }]),
    { separator: true },
    { id: 'search', label: isFile ? t('Find in File…') : t('Find in Folder…') },
    { separator: true },
    { id: 'newFile', label: t('New File') },
    { id: 'newFolder', label: t('New Folder') },
    { separator: true },
    { id: 'copy', label: t('Copy') },
    { id: 'cut', label: t('Cut') },
    { id: 'paste', label: clipboardFiles.length > 1 ? t('Paste {n} Items', { n: clipboardFiles.length }) : t('Paste'), enabled: clipboardFiles.length > 0 },
    { id: 'duplicate', label: t('Duplicate') },
    { separator: true },
    { id: 'reveal', label: t('Reveal in Finder') },
    { id: 'copyPath', label: t('Copy Path') },
    { id: 'copyRelative', label: t('Copy Relative Path') },
    { separator: true },
    { id: 'rename', label: t('Rename…') },
    { id: 'delete', label: t('Move to Trash') }
  ])
  if (choice === 'open') await openFile(path)
  if (choice === 'enter') enter(node)
  if (choice === 'search') searchIn([path])
  if (choice === 'newFile') await createInMap('file', folder)
  if (choice === 'newFolder') await createInMap('directory', folder)
  if (choice === 'copy') await copyEntries([path])
  if (choice === 'cut') await cutEntries([path])
  if (choice === 'paste') await pasteInto(folder)
  if (choice === 'duplicate') await duplicate(path)
  if (choice === 'reveal') await window.codemap.fs.reveal(path)
  if (choice === 'copyPath') await navigator.clipboard.writeText(path)
  if (choice === 'copyRelative') await navigator.clipboard.writeText(node.rel)
  if (choice === 'rename') await renameFromMap(path)
  if (choice === 'delete') await trashFromMap(path)
}
