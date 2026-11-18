import type { IgnoreRule, Issue, LinkDoc, NodeDoc, RequirementDoc, TodoFile } from '../../shared/codemap/codemap.mjs'

export interface LoadedLibrary {
  docs: NodeDoc[]
  links: LinkDoc[]
  requirements: RequirementDoc[]
  /** Files in each folder's todo/ (one to-do per .md), with their first heading. */
  todos: TodoFile[]
  /** YAML parse errors; the remaining files still load. */
  errors: Issue[]
}

export declare function loadIgnore(dir: string): IgnoreRule[]
export declare function loadLibrary(dir: string): LoadedLibrary
export declare function listTodos(dir: string): TodoFile[]
