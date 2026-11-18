import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentContext, AgentMode } from '../../shared/agent'
import { knowledgeRoot } from './knowledge'

// System prompts. The built-in part only fixes the ground rules (tools, change sets, the map);
// how each mode works in detail comes from the knowledge folder that ships with the app
// (agent/ in this repository): common/*.md, <mode>/*.md, domain/*.md.
// Empty files are skipped, so the folder can start empty.

const BASE = [
  'You are the code map assistant inside the Codemap app. You work on a codemap/v1 node library: YAML files describing a system as nested maps (business stages, services, modules, functions, code blocks), with edges, links (data on edges), and flows.',
  'Keep answers short and plain; name nodes by their name and id.',
  'Ground every statement in what you read: node files, code, or the knowledge folder. If something is a guess, say so.',
  'Use show_on_map as you go: open the map you are looking at and highlight the nodes you mean, so the user can follow on the map.',
  'Never edit files directly. Changes go through propose_change_set; the user previews them on the map and applies them.'
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

export async function systemPrompt(library: string, mode: AgentMode, context: AgentContext, extra?: string): Promise<string> {
  const knowledge = await knowledgeFor(mode)
  const where = [
    `Node library: ${library}`,
    context.stack.length ? `The user has this map open: ${context.stack[context.stack.length - 1]} (path: ${context.stack.join(' > ')})` : 'The user has no map open.',
    context.selected.length ? `Selected nodes: ${context.selected.join(', ')}` : '',
    context.flow ? `Selected flow: ${context.flow}` : '',
    context.repos?.length ? 'Repositories to analyse (read them with list_files / search_code / read_file):\n' + context.repos.map((r) => '- ' + r).join('\n') : '',
    context.docs?.length
      ? 'Knowledge the user added. Read local files with read_file; you cannot open links, so use what the user says about them:\n' + context.docs.map((d) => '- ' + (d.kind === 'url' ? 'link: ' : 'file: ') + d.value).join('\n')
      : '',
    mode === 'create' ? (context.output ? `Write the new map under ${context.output}/ in the node library (library-relative paths start with ${context.output}/).` : 'Write the new map at the root of the node library.') : ''
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
