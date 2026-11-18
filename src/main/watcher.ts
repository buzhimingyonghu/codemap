import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

const IGNORED_SEGMENTS = ['/.git/', '/node_modules/', '/.DS_Store']

// Recursive fs.watch is native on macOS (FSEvents), so no extra dependency is needed.
export class WorkspaceWatcher {
  private watcher: FSWatcher | null = null
  private pending = new Set<string>()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly onChange: (paths: string[]) => void) {}

  start(root: string): void {
    this.stop()
    try {
      this.watcher = watch(root, { recursive: true, persistent: false }, (_event, fileName) => {
        if (!fileName) return
        const absolute = path.join(root, fileName.toString())
        const probe = `${absolute}/`
        if (IGNORED_SEGMENTS.some((segment) => probe.includes(segment)) && !absolute.endsWith('/.git/HEAD')) return
        this.pending.add(absolute)
        this.schedule()
      })
      this.watcher.on('error', () => this.stop())
    } catch {
      this.watcher = null
    }
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      const paths = [...this.pending]
      this.pending.clear()
      if (paths.length) this.onChange(paths)
    }, 150)
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }
}
