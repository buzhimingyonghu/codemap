import { access, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentContext, AgentMode, BuildLens, BuildTier } from '../../shared/agent'
import { knowledgeRoot } from './knowledge'
import { readGitRemote } from './repoScanner'

// System prompts. The built-in part only fixes the ground rules (tools, change sets, the map);
// how each mode works in detail comes from the knowledge folder that ships with the app
// (agent/ in this repository): common/*.md, <mode>/*.md, domain/*.md.
// Empty files are skipped, so the folder can start empty.

const BASE = [
  'You are the code map assistant inside the Codemap app. You work on a codemap/v1 node library: YAML files describing a system as nested maps (business stages, services, modules, functions, code blocks), with edges, links (data on edges), and flows.',
  'Keep answers short and plain; name nodes by their name and id.',
  'Ground every statement in what you read: node files, code, or the knowledge folder. If something is a guess, say so.',
  'Use show_on_map as you go: open the map you are looking at and highlight the nodes you mean, so the user can follow on the map.',
  'Never edit files directly. Changes go through propose_change_set; the user previews them on the map and applies them.',
  'Checker errors are yours to fix, before you hand anything to the user. Never ask the user to look at, judge, or fix checker problems, and do not list them in your messages. What you ask the user about is the architecture and the logic: how the business is split, what each node does, whether the flows tell the story right.'
].join('\n')

const MODE: Record<AgentMode, string> = {
  ask: [
    'Mode: Ask. Answer questions about the system from the map the user has open: start at that map and its nodes, go up or down levels from there, and read the code the nodes point at when needed.',
    'Find the relevant nodes (find_nodes, read_node), read their code when the answer depends on it (read_node_code, search_code), and point at them with show_on_map.',
    'When the question is about a sequence of events, select the matching flow with show_on_map(flow) so the user can play it.',
    'Cite nodes by id and code as path:line. If the map is wrong or missing something, say what and suggest switching to Adjust.'
  ].join('\n'),
  adjust: [
    'Mode: Adjust. Change the map the user has open (and its parent and child maps when needed) as the user asks: split a node, merge nodes, add a missed branch, rename, fix edges or flows.',
    'Read the affected maps and the code first. Keep parent and child maps consistent: an edge into a node on the parent map needs a matching entry on its own map, and flows that refine a parent flow must still line up.',
    'Keep node docs in step: when a node you change has a doc (<node folder>/docs/<id>.md, linked in kb), read it and update the parts the change affects in the same change set; also update the parent node doc when its map changes. A new map gets a new doc following create/node-doc-template.md.',
    'Propose the whole change in one change set, then read the checker problems in the reply and fix them with a corrected proposal.'
  ].join('\n'),
  create: [
    'Mode: Create. Build a new map for a business from the code and the documents the user gives.',
    'Follow the workflow in the Codemap knowledge (create/SOP.md) when it has content; the codemap/v1 templates are create/node-template.yaml, create/link-template.yaml, create/requirement-template.yaml (read them with read_knowledge). Without it: read the repositories and documents, explain the business in plain words in the chat and discuss only the points you are unsure about, stop at review_gate; then draw L0 (business modules in product terms, one flow per user operation, a docs/<id>.md node doc linked in kb), stop at review_gate; after approval break nodes down one level at a time, stopping at review_gate after each batch.',
    'Every node you draw must be traceable to code entry points (fn.code + fn.repo on function nodes, brief naming the service on business nodes), and every entry point you found must belong to some node.',
    'For several independent nodes on the same level, use delegate_nodes to break them down in parallel.'
  ].join('\n'),
  require: [
    'Mode: Require. Turn a requirement into a plan on the existing map, starting from the map and nodes the user has open.',
    'Find the nodes it touches, read their code, then propose a change set with requirement { id, name, desc }: added and modified nodes (with proposed: { file, new | diff } where code is needed), edges, flows, and links. It is saved as requirements/<id>.yaml and shown as a requirement layer.',
    'In your final message list: the impact (maps and nodes), upstream and downstream effects, and test points, each test point naming the flow or nodes it covers.'
  ].join('\n')
}

async function readMarkdown(dir: string): Promise<string[]> {
  let names: string[] = []
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort()
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    const text = (await readFile(path.join(dir, name), 'utf8').catch(() => '')).trim()
    if (text) out.push(`### ${path.basename(dir)}/${name}\n${text}`)
  }
  return out
}

export async function knowledgeFor(mode: AgentMode, root = knowledgeRoot()): Promise<string> {
  const parts = [...(await readMarkdown(path.join(root, 'common'))), ...(await readMarkdown(path.join(root, mode))), ...(await readMarkdown(path.join(root, 'domain')))]
  return parts.join('\n\n')
}

async function readIfPresent(file: string): Promise<string> {
  try {
    await access(file)
  } catch {
    return ''
  }
  return (await readFile(file, 'utf8').catch(() => '')).trim()
}

function tierGuide(tier: BuildTier | undefined): string {
  const chosen = tier ?? 'balanced'
  if (chosen === 'fast') {
    return [
      'Build tier: fast.',
      'Call scan_repo_entrypoints first so no entrypoint is missed. Do NOT call review_gate (0 pauses).',
      'Build the L0 map and the L1 module skeleton maps, plus a root docs/<id>.md, directly. Validate until the checker reports 0 errors, then finish with an entry-coverage summary.'
    ].join('\n')
  }
  if (chosen === 'deep') {
    return [
      'Build tier: deep.',
      'Full stage-by-stage workflow: scan_repo_entrypoints, then a Blueprint review_gate, then an L0 review_gate, then parallel delegate_nodes with an L1 review_gate, then L2/L3 functions and code branches.'
    ].join('\n')
  }
  return [
    'Build tier: balanced.',
    'Call scan_repo_entrypoints first. Present one compact Structured Blueprint Table (Modules/Services, Sync/Async/Timer entrypoints, Storage, Flows, Open Questions) and pause once at review_gate with stage "Blueprint" (or "蓝图对齐").',
    'After the user approves, build the complete L0 and L1 maps, with links.yaml for key cross-service edges and a module docs/<id>.md, and do not stop at further intermediate gates until that build is done.'
  ].join('\n')
}

function lensGuide(lens: BuildLens | undefined): string {
  const chosen = lens ?? 'service'
  if (chosen === 'business') {
    return 'Build lens: business. Partition L0 by user-facing product capabilities and stages. Name the underlying services in each node brief.'
  }
  if (chosen === 'troubleshoot') {
    return 'Build lens: troubleshoot. Emphasize state transitions, error/timeout/retry branches, idempotency, dead-letter and fallback paths, and background reconciliation flows.'
  }
  return 'Build lens: service. Partition L0 and L1 by real deployable microservices, processes, and packages, plus explicit DB, Redis, and MQ resources and sync/async/cron entrypoints. Never merge distinct services into vague product boxes.'
}

async function repoLines(library: string, repos: string[] | undefined, output: string | undefined): Promise<string> {
  if (!repos?.length) return ''
  const targetRoot = output ? path.join(library, output) : library
  const lines: string[] = ['Repositories to analyse (read them with scan_repo_entrypoints first, then list_files / search_code / read_file):']
  for (const repo of repos) {
    const remote = await readGitRemote(repo).catch(() => null)
    const local = path.relative(targetRoot, repo).split(path.sep).join('/') || '.'
    lines.push(`- path: ${repo}`)
    lines.push(`  remote: ${remote ?? '(none)'}`)
    lines.push(`  local: ${local}  (repo.local relative to ${output ? output + '/' : 'the library root'}; do not hand-count ../../)`)
  }
  return lines.join('\n')
}

export async function systemPrompt(library: string, mode: AgentMode, context: AgentContext, extra?: string): Promise<string> {
  const knowledge = await knowledgeFor(mode)
  const domainFile = (await readIfPresent(path.join(library, 'domain.md'))) || (await readIfPresent(path.join(library, '.codemap', 'domain.md')))
  const where = [
    `Node library: ${library}`,
    context.stack.length ? `The user has this map open: ${context.stack[context.stack.length - 1]} (path: ${context.stack.join(' > ')})` : 'The user has no map open.',
    context.selected.length ? `Selected nodes: ${context.selected.join(', ')}` : '',
    context.flow ? `Selected flow: ${context.flow}` : '',
    await repoLines(library, context.repos, context.output),
    context.docs?.length
      ? 'Knowledge the user added. Read local files with read_file; you cannot open links, so use what the user says about them:\n' + context.docs.map((d) => '- ' + (d.kind === 'url' ? 'link: ' : 'file: ') + d.value).join('\n')
      : '',
    domainFile ? `Project domain knowledge:\n${domainFile}` : '',
    mode === 'create' ? (context.output ? `Write the new map under ${context.output}/ in the node library (library-relative paths start with ${context.output}/).` : 'Write the new map at the root of the node library.') : '',
    mode === 'create' ? tierGuide(context.buildTier) : '',
    mode === 'create' ? lensGuide(context.buildLens) : ''
  ].filter(Boolean)
  return [BASE, MODE[mode], extra ?? '', knowledge ? `## Codemap knowledge (the workflow and rules to follow; it overrides the defaults above)\n\n${knowledge}` : '', `## Where the user is\n${where.join('\n')}`, LANGUAGE]
    .filter(Boolean)
    .join('\n\n')
}

// Last, so it wins over the English of this prompt and the Chinese of the knowledge folder.
const LANGUAGE = [
  '## Language',
  "Reply in the language of the user's latest message (Chinese message → Chinese reply, English → English), from the first sentence on, including progress notes, review_gate summaries, and change-set titles and summaries.",
  'Text you write into the map (node names, desc, flow titles, docs) follows the language of the existing node library; for a new library, use the language the user writes in.',
  'Keep code identifiers, file paths, and node ids as they are.'
].join('\n')
