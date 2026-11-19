import { homedir } from 'node:os'
import path from 'node:path'
import type { CodemapLayoutPatch, CodemapLoad, CodemapNodePatch, CodemapRead, ConfirmOptions, MenuItemSpec, WorkspaceSettings } from '../../../src/shared/types'
import {
  CodemapAccess,
  findLibraries,
  grantable,
  isLibrary,
  loadCodemap,
  readCodemapFile,
  resolveFolder,
  writeCodemapLayout,
  writeCodemapNode
} from '../../../src/main/codemap/service'
import { checkLibrary } from '../../../src/shared/codemap/codemap.mjs'
import { issuesToDiagnostics, type YamlDiagnostic } from './diagnostics'

export interface BridgeState {
  root: string | null
  library: string | null
  grants: string[]
  settings: WorkspaceSettings
}

export interface BridgePrompts {
  pickFolder(defaultPath?: string): Promise<string | null>
  confirm(options: ConfirmOptions): Promise<number>
  quickPick(items: MenuItemSpec[]): Promise<string | null>
  warning(message: string, detail: string, allow: boolean): Promise<boolean>
}

const DEFAULT_SETTINGS: WorkspaceSettings = {
  buildCommand: '',
  debug: { program: '', args: [], cwd: '', stopOnEntry: false, preLaunchBuild: false }
}

export class CodeMapBridge {
  readonly access: CodemapAccess
  private library: string | null = null
  private locale: 'en' | 'zh' = 'zh'
  private settings: WorkspaceSettings = structuredClone(DEFAULT_SETTINGS)

  constructor(
    private root: string | null,
    grants: string[],
    private readonly prompts: BridgePrompts
  ) {
    this.access = new CodemapAccess(() => this.root, grants)
  }

  setRoot(root: string | null): void {
    this.root = root
  }

  setLocale(locale: 'en' | 'zh'): void {
    this.locale = locale
  }

  getRoot(): string | null {
    return this.root
  }

  setLibrary(library: string | null): void {
    this.library = library
  }

  getLibrary(): string | null {
    return this.library
  }

  setSettings(settings: WorkspaceSettings): void {
    this.settings = settings
  }

  snapshot(): BridgeState {
    return { root: this.root, library: this.library, grants: this.access.list(), settings: this.settings }
  }

  async load(saved: string | null): Promise<CodemapLoad> {
    if (!this.root) return emptyLoad('none')
    if (saved && (await isLibrary(saved).catch(() => false))) {
      this.library = saved
      return this.ready(saved, 'saved')
    }
    const candidates = await findLibraries(this.root)
    if (candidates.length === 1) {
      this.library = candidates[0]
      return this.ready(candidates[0], 'detected', candidates)
    }
    this.library = null
    return { ...emptyLoad(candidates.length ? 'choose' : 'none'), candidates }
  }

  async useLibrary(folder: string): Promise<CodemapLoad> {
    if (!this.root) throw new Error('Open a folder first')
    const library = await resolveFolder(folder)
    if (!(await isLibrary(library))) throw new Error(`No code map nodes in ${library}`)
    if (!this.access.allowed(library)) {
      const granted = await this.requestAccess(library, 'library')
      if (!granted) throw new Error('Reading this folder was not allowed')
    }
    this.library = library
    return this.ready(library, 'saved')
  }

  async chooseLibrary(): Promise<CodemapLoad | null> {
    const picked = await this.prompts.pickFolder(this.root ?? undefined)
    if (!picked) return null
    return this.useLibrary(picked)
  }

  async pickRepository(): Promise<string | null> {
    const picked = await this.prompts.pickFolder(this.root ?? undefined)
    if (!picked) return null
    const folder = await resolveFolder(picked)
    if (!this.access.allowed(folder) && grantable(folder)) this.grant(folder)
    return folder
  }

  async requestAccess(folder: string, reason: string): Promise<boolean> {
    let target: string
    try {
      target = await resolveFolder(folder)
    } catch {
      return false
    }
    if (this.access.allowed(target)) return true
    const broad = !grantable(target) || target === homedir() || target === '/'
    const zh = this.locale === 'zh'
    const detail = broad
      ? zh
        ? `${target}\n\n这个文件夹范围太大，不能整个授权。请改为打开具体仓库目录。`
        : `${target}\n\nThis folder is too broad to allow as a whole. Open a specific repository folder instead.`
      : zh
        ? `${target}\n\n架构图需要读取${reason === 'library' ? '这个节点库' : '节点指向的代码和文档'}，位于当前打开的文件夹之外。访问仅限只读。`
        : `${target}\n\nThe architecture map needs to read ${reason === 'library' ? 'this node library' : 'code and documents its nodes point at'}, outside the open folder. Access is read-only.`
    const allowed = await this.prompts.warning(zh ? '允许架构图读取这个文件夹？' : 'Allow the architecture map to read this folder?', detail, !broad)
    if (!allowed || broad) return false
    this.grant(target)
    return true
  }

  grant(folder: string): string[] {
    const grants = [...this.access.list().filter((grant) => grant !== folder && !grant.startsWith(`${folder}/`)), folder]
    this.access.setGrants(grants)
    return grants
  }

  revoke(folder: string): string[] {
    const grants = this.access.list().filter((grant) => grant !== folder)
    this.access.setGrants(grants)
    return grants
  }

  read(file: string): Promise<CodemapRead> {
    return readCodemapFile(this.access, file)
  }

  async readWorkspace(file: string): Promise<string> {
    const result = await this.read(file)
    if (!result.ok) throw new Error(result.reason === 'access' ? `Access denied: ${result.folder}` : result.message)
    if (this.root && !this.access.allowed(result.path)) throw new Error('File is outside the workspace')
    return result.text
  }

  async readExternal(file: string): Promise<string> {
    const result = await this.read(file)
    if (!result.ok) throw new Error(result.reason === 'access' ? `Access denied: ${result.folder}` : result.message)
    return result.text
  }

  diagnostics(load: CodemapLoad): YamlDiagnostic[] {
    if (!load.library) return []
    const checked = checkLibrary(load.docs, load.requirements, load.links)
    const issues = [...load.errors, ...checked.base.issues, ...checked.reqs.flatMap((requirement) => requirement.issues)]
    return issuesToDiagnostics(load.library, issues, (...parts) => path.join(...parts))
  }

  writeLayout(file: string, patch: CodemapLayoutPatch, beforeWrite?: (file: string, content: string) => void): Promise<void> {
    return writeCodemapLayout(this.root, this.library, file, patch, beforeWrite)
  }

  writeNode(file: string, patch: CodemapNodePatch): Promise<void> {
    return writeCodemapNode(this.root, this.library, file, patch)
  }

  confirm(options: ConfirmOptions): Promise<number> {
    return this.prompts.confirm(options)
  }

  popupMenu(items: MenuItemSpec[]): Promise<string | null> {
    return this.prompts.quickPick(items)
  }

  private async ready(library: string, source: 'saved' | 'detected', candidates: string[] = []): Promise<CodemapLoad> {
    const loaded = await loadCodemap(library)
    return { status: 'ready', source, candidates, ...loaded }
  }
}

function emptyLoad(status: 'none' | 'choose'): CodemapLoad {
  return { status, library: null, source: null, candidates: [], docs: [], links: [], requirements: [], todos: [], errors: [], fileCount: 0 }
}
