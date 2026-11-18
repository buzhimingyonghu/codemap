// Types shared by the built-in code map agent (main process) and its panel (renderer).

export type AgentMode = 'create' | 'ask' | 'adjust' | 'require'

export const AGENT_MODES: AgentMode[] = ['ask', 'adjust', 'create', 'require']

/** Wire protocol of a model provider. */
export type ProviderKind = 'anthropic' | 'openai'

export interface AgentProvider {
  id: string
  name: string
  kind: ProviderKind
  /** Base URL: for anthropic without /v1 (/v1/messages is appended), for openai ending in /v1. */
  baseUrl: string
  /** Where the key comes from: typed in (kept encrypted in the keychain), or the gateway already set up for Claude Code / Codex. */
  keySource: 'stored' | 'local'
  /** Whether a key is available (the key itself never leaves the main process). */
  hasKey?: boolean
  /** Default model id for this provider. */
  model: string
}

/** Model per mode; missing means the provider's default model. */
export type ModeModels = Partial<Record<AgentMode, string>>

export interface AgentSettings {
  providers: AgentProvider[]
  activeProvider: string | null
  modeModels: ModeModels
  /** Parallel sub-agents allowed in create mode. */
  maxParallel: number
  /** Stop a run after this many model turns. */
  maxTurns: number
}

/** What the user is looking at when a message is sent. */
export interface AgentContext {
  /** Open map path, top last. */
  stack: string[]
  /** Selected nodes on the open map. */
  selected: string[]
  /** Open flow on the open map. */
  flow: string | null
  /** Repositories (absolute folders) the user picked for this conversation. */
  repos?: string[]
  /** Knowledge the user added: local files (absolute paths) and remote links. */
  docs?: Array<{ kind: 'file' | 'url'; value: string }>
  /** Build map: folder inside the node library to write the new map into (empty: the library root). */
  output?: string
}

export interface AgentStartRequest {
  mode: AgentMode
  message: string
  context: AgentContext
  /** Continue this session; omitted starts a new one. */
  sessionId?: string
  /** Model override for this run. */
  model?: string
}

// ---------- Change sets ----------
// The agent never writes node YAML directly. It proposes a change set (the same `changes`
// format as requirements/*.yaml plus whole new node files), the map previews it as a layer,
// and only an explicit Apply writes it.

export interface AgentChangeSet {
  id: string
  sessionId: string
  title: string
  summary: string
  /** requirement-template changes (add / modify / remove ...). */
  changes: Record<string, unknown>[]
  /** New or replaced node / link / doc files: library-relative path to full text. */
  files: Record<string, string>
  /** Require mode: kept as requirements/<id>.yaml instead of being applied to the base map. */
  requirement?: { id: string; name: string; desc?: string }
  /** Problems the checker found with this change set applied. */
  problems: { level: string; rule: string; where: string; msg: string }[]
  status: 'proposed' | 'applied' | 'rejected'
}

// ---------- Events the panel receives while a run goes ----------

export type AgentEvent =
  | { type: 'session'; sessionId: string; mode: AgentMode; title: string }
  | { type: 'text'; sessionId: string; runId: string; text: string }
  | { type: 'tool'; sessionId: string; runId: string; callId: string; name: string; label: string }
  | { type: 'tool-result'; sessionId: string; runId: string; callId: string; ok: boolean; summary: string }
  /** The map follows the agent: open `map`, light up `nodes`, optionally select `flow`. */
  | { type: 'focus'; sessionId: string; runId: string; map: string | null; nodes: string[]; flow?: string | null; note?: string }
  | { type: 'changeset'; sessionId: string; runId: string; changeSet: AgentChangeSet }
  /** Create mode: a review gate; the run stops until the user approves or sends feedback. */
  | { type: 'gate'; sessionId: string; runId: string; stage: string; summary: string }
  | { type: 'worker'; sessionId: string; runId: string; workerId: string; node: string; state: 'running' | 'done' | 'failed'; note?: string }
  | { type: 'usage'; sessionId: string; runId: string; input: number; output: number }
  | { type: 'error'; sessionId: string; runId: string; message: string }
  | { type: 'done'; sessionId: string; runId: string; reason: 'end' | 'gate' | 'stopped' | 'limit' | 'error' }

export interface AgentStepView {
  name: string
  label: string
  summary?: string
  ok?: boolean
}

export interface AgentMessageView {
  role: 'user' | 'assistant'
  text: string
  /** Tool steps taken while producing an assistant message. */
  steps?: AgentStepView[]
  at: number
}

export interface AgentSessionInfo {
  id: string
  mode: AgentMode
  title: string
  updatedAt: number
  messages: AgentMessageView[]
  changeSets: AgentChangeSet[]
  /** Create mode: the gate the session is waiting at, if any. */
  gate?: { stage: string; summary: string } | null
}

export interface AgentSessionSummary {
  id: string
  mode: AgentMode
  title: string
  updatedAt: number
}

/**
 * The knowledge the assistant follows ships with the app (the agent/ folder of this repository,
 * copied into Resources/agent when packaged): common/, one folder per mode, domain/, and the
 * codemap/v1 templates under create/. It is not part of any node library.
 */
export const KNOWLEDGE_DIRS = ['common', 'create', 'ask', 'adjust', 'require', 'domain'] as const
