import { isMap, isScalar, isSeq, parse, parseDocument, type Pair, type YAMLMap } from 'yaml'

// Writes a map's hand-arranged layout back into its node YAML. Only the `layout:` block and the
// `ports` of edges that changed are touched; every other byte (comments, spacing, order) stays.
// Edits are made on the text using the parser's source ranges, never by re-serializing.

export type Side = 'top' | 'bottom' | 'left' | 'right'

export interface LayoutPatch {
  /** The map node's id; the file may define it at the top level or inline under `contains`. */
  map: string
  /** Node key (as written in edges) → [x, y]; null removes the whole `layout` block. */
  layout?: Record<string, [number, number]> | null
  /** Edge key → ports; null removes `ports` from that edge. */
  ports?: Record<string, [Side | null, Side | null] | null>
}

interface Edit {
  start: number
  end: number
  text: string
}

const SIDES = new Set(['top', 'bottom', 'left', 'right'])

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1
}

function indentAt(text: string, offset: number): string {
  const start = lineStart(text, offset)
  return /^[ \t]*/.exec(text.slice(start))![0]
}

function lineEnd(text: string, offset: number): number {
  const nl = text.indexOf('\n', offset)
  return nl < 0 ? text.length : nl + 1
}

function quoteKey(key: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(key) ? key : JSON.stringify(key)
}

function portsText(ports: [Side | null, Side | null]): string {
  const [a, b] = ports
  return b ? `[${a ?? 'auto'}, ${b}]` : `[${a ?? 'auto'}]`
}

/** The map node in the document: the top-level node, or one defined inline under `contains`. */
function findMapNode(root: YAMLMap<any, any>, mapId: string): YAMLMap<any, any> | null {
  const rootId = root.get('id')
  if (typeof rootId !== 'string') return null
  if (rootId === mapId) return root
  const walk = (node: YAMLMap<any, any>, id: string): YAMLMap<any, any> | null => {
    const contains = node.get('contains', true)
    if (!isSeq(contains)) return null
    for (const item of contains.items) {
      if (!isMap(item)) continue
      const short = item.get('id')
      if (typeof short !== 'string' || item.get('ref') !== undefined) continue
      const full = `${id}.${short}`
      if (full === mapId) return item
      const deeper = walk(item, full)
      if (deeper) return deeper
    }
    return null
  }
  return walk(root, rootId)
}

function edgeKeyOf(edge: YAMLMap<any, any>): string | null {
  const id = edge.get('id')
  if (typeof id === 'string') return id
  const from = edge.get('from')
  const to = edge.get('to')
  return typeof from === 'string' && typeof to === 'string' ? `${from}->${to}` : null
}

/** Applies the patch to the YAML text. Throws when the map node is not in this file. */
export function applyLayoutPatch(text: string, patch: LayoutPatch): string {
  const doc = parseDocument(text, { keepSourceTokens: true })
  if (doc.errors.length) throw new Error(doc.errors[0].message)
  const root = doc.contents
  if (!isMap(root)) throw new Error('Not a node file')
  const node = findMapNode(root, patch.map)
  if (!node) throw new Error(`Map ${patch.map} is not defined in this file`)
  const edits: Edit[] = []

  if (patch.layout !== undefined) edits.push(...layoutEdits(text, node, patch.layout))
  if (patch.ports) edits.push(...portEdits(text, node, patch.ports))

  // Apply from the end so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start)
  let out = text
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

// ---------- Node fields ----------
// The detail panel edits a few scalar fields of one node. Like the layout, only the values of
// those keys change; comments, order and every other byte stay as written.

/** Editable fields: `name`, `brief`, `desc` on the node; `trigger`, `outcome` under `fn`. */
export interface NodePatch {
  node: string
  /** Field → new text; null or '' removes the key. Keys: name, brief, desc, fn.trigger, fn.outcome. */
  fields: Record<string, string | null>
}

export const NODE_FIELDS = new Set(['name', 'brief', 'desc', 'fn.trigger', 'fn.outcome'])

function scalarText(value: string, flow: boolean): string {
  // Plain when YAML reads it back as the same string (inside { } also without , [ ] { }).
  const plainOk = !value.includes('\n') && value.trim() === value && !(flow && /[,[\]{}]/.test(value))
  if (plainOk) {
    try {
      if (parse(`k: ${value}`)?.k === value && parse(`{ k: ${value} }`)?.k === value) return value
    } catch {
      // fall through to quoting
    }
  }
  return JSON.stringify(value)
}

function pairOf(map: YAMLMap<any, any>, key: string): Pair<any, any> | undefined {
  return map.items.find((p) => isScalar(p.key) && p.key.value === key) as Pair<any, any> | undefined
}

/** Edits for one key of `map`: replace its value, remove the key, or add it after `after`. */
function fieldEdits(text: string, map: YAMLMap<any, any>, key: string, value: string | null, after: string[]): Edit[] {
  const pair = pairOf(map, key)
  if (pair?.value !== undefined && pair.value !== null && !isScalar(pair.value)) throw new Error(`${key} is not a plain value`)
  if (pair?.key?.range) {
    const valueRange = pair.value?.range as [number, number, number] | undefined
    if (value) {
      if (valueRange) return [{ start: valueRange[0], end: valueRange[1], text: scalarText(value, Boolean(map.flow)) }]
      const at = pair.key.range[1] + (text.slice(pair.key.range[1]).match(/^\s*:/)?.[0].length ?? 1)
      return [{ start: at, end: at, text: ` ${scalarText(value, Boolean(map.flow))}` }]
    }
    const keyStart = pair.key.range[0]
    const valueEnd = valueRange?.[1] ?? pair.key.range[1] + 1
    if (map.flow) {
      const before = text.lastIndexOf(',', keyStart)
      const open = text.lastIndexOf('{', keyStart)
      if (before > open) return [{ start: before, end: valueEnd, text: '' }]
      const tail = /^\s*,\s*/.exec(text.slice(valueEnd))
      return [{ start: keyStart, end: valueEnd + (tail ? tail[0].length : 0), text: '' }]
    }
    const start = lineStart(text, keyStart)
    if (start !== keyStart - indentAt(text, keyStart).length) throw new Error(`Cannot remove ${key} here; edit the YAML`)
    return [{ start, end: lineEnd(text, valueEnd - 1), text: '' }]
  }
  if (!value) return []
  const anchor = after.map((k) => pairOf(map, k)).filter(Boolean).pop() ?? map.items[map.items.length - 1]
  const end = ((anchor?.value?.range ?? anchor?.key?.range) as [number, number, number] | undefined)?.[1]
  if (end === undefined) throw new Error(`Cannot add ${key} here; edit the YAML`)
  if (map.flow) return [{ start: end, end, text: `, ${key}: ${scalarText(value, true)}` }]
  const first = map.items[0]?.key?.range as [number, number, number] | undefined
  const second = map.items[1]?.key?.range as [number, number, number] | undefined
  const indent = second ? indentAt(text, second[0]) : first ? indentAt(text, first[0]) : ''
  const at = lineEnd(text, end - 1)
  return [{ start: at, end: at, text: `${indent}${key}: ${scalarText(value, false)}\n` }]
}

/** Applies a node field patch to the YAML text. Throws when the node is not defined in this file. */
export function applyNodePatch(text: string, patch: NodePatch): string {
  const doc = parseDocument(text, { keepSourceTokens: true })
  if (doc.errors.length) throw new Error(doc.errors[0].message)
  const root = doc.contents
  if (!isMap(root)) throw new Error('Not a node file')
  const node = findMapNode(root, patch.node)
  if (!node) throw new Error(`Node ${patch.node} is not defined in this file`)
  const edits: Edit[] = []
  const fnFields = Object.entries(patch.fields).filter(([k]) => k.startsWith('fn.'))
  for (const [field, value] of Object.entries(patch.fields)) {
    if (!NODE_FIELDS.has(field)) throw new Error(`Field ${field} cannot be edited here`)
    if (field.startsWith('fn.')) continue
    edits.push(...fieldEdits(text, node, field, value || null, field === 'name' ? ['kind', 'id'] : field === 'brief' ? ['id', 'kind', 'name'] : ['id', 'kind', 'name', 'brief']))
  }
  if (fnFields.length) {
    const fn = node.get('fn', true)
    if (!isMap(fn)) {
      if (fnFields.some(([, v]) => v)) throw new Error('This node has no fn; edit the YAML')
    } else {
      for (const [field, value] of fnFields) edits.push(...fieldEdits(text, fn, field.slice(3), value || null, ['code', 'repo']))
    }
  }
  edits.sort((a, b) => b.start - a.start)
  let out = text
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  // The result must still parse and say what was asked.
  const check = parseDocument(out)
  if (check.errors.length) throw new Error(`Edit would break the YAML: ${check.errors[0].message}`)
  const again = isMap(check.contents) ? findMapNode(check.contents, patch.node) : null
  const plain = (again?.toJS(check) ?? {}) as Record<string, any>
  for (const [field, value] of Object.entries(patch.fields)) {
    const got = field.startsWith('fn.') ? plain.fn?.[field.slice(3)] : plain[field]
    if ((got ?? '') !== (value ?? '')) throw new Error(`Edit of ${field} did not round-trip`)
  }
  return out
}

function layoutEdits(text: string, node: YAMLMap<any, any>, layout: Record<string, [number, number]> | null): Edit[] {
  const pair = node.items.find((p) => isScalar(p.key) && p.key.value === 'layout') as Pair<any, any> | undefined
  const keyRange = pair?.key?.range as [number, number, number] | undefined
  // Indentation of the map's keys: from an existing key on its own line.
  const sample = node.items.find((p) => isScalar(p.key) && p.key.range && lineStart(text, p.key.range[0]) === p.key.range[0] - indentAt(text, p.key.range[0]).length)
  const indent = sample?.key?.range ? indentAt(text, sample.key.range[0]) : ''
  const entries = layout ? Object.entries(layout) : []
  const block = entries.length ? `${indent}layout:\n${entries.map(([k, [x, y]]) => `${indent}  ${quoteKey(k)}: [${Math.round(x)}, ${Math.round(y)}]`).join('\n')}\n` : ''

  if (pair && keyRange) {
    // Replace from the start of the `layout:` line through the end of its value.
    const start = lineStart(text, keyRange[0])
    const valueEnd = (pair.value?.range as [number, number, number] | undefined)?.[2] ?? lineEnd(text, keyRange[1])
    let end = lineEnd(text, Math.max(valueEnd - 1, keyRange[1]))
    if (!layout || !entries.length) {
      // Also drop the blank separator line inserted together with the block.
      if (/^[ \t]*\n/.test(text.slice(end)) && (start === 0 || /\n[ \t]*\n$/.test(text.slice(0, start)))) end = lineEnd(text, end)
      return [{ start, end, text: '' }]
    }
    return [{ start, end, text: block }]
  }
  if (!layout || !entries.length) return []
  // No layout yet: insert before `edges:` (next to lanes), else at the end of the map.
  const anchorKey = ['edges', 'flows'].map((k) => node.items.find((p) => isScalar(p.key) && p.key.value === k)).find(Boolean)
  if (anchorKey?.key?.range) {
    let start = lineStart(text, anchorKey.key.range[0])
    // Insert above comment lines that introduce the anchor key.
    while (start > 0) {
      const prev = lineStart(text, start - 1)
      if (/^[ \t]*#/.test(text.slice(prev, start))) start = prev
      else break
    }
    return [{ start, end: start, text: `${block}\n` }]
  }
  const range = node.range as [number, number, number]
  const at = range[2]
  if (at > 0 && text[at - 1] !== '\n') return [{ start: at, end: at, text: `\n${block}` }]
  return [{ start: at, end: at, text: block }]
}

function portEdits(text: string, node: YAMLMap<any, any>, ports: Record<string, [Side | null, Side | null] | null>): Edit[] {
  const edges = node.get('edges', true)
  if (!isSeq(edges)) return []
  const edits: Edit[] = []
  for (const item of edges.items) {
    if (!isMap(item)) continue
    const key = edgeKeyOf(item)
    if (!key || !(key in ports)) continue
    const value = ports[key]
    if (value && value.some((s) => s !== null && !SIDES.has(s))) throw new Error(`Bad ports for ${key}`)
    const pair = item.items.find((p) => isScalar(p.key) && p.key.value === 'ports') as Pair<any, any> | undefined
    const range = item.range as [number, number, number]
    if (item.flow) {
      // { from: a, to: b, ... } — edit inside the braces.
      if (pair?.key?.range && pair.value?.range) {
        const keyStart = pair.key.range[0]
        const valueEnd = pair.value.range[1]
        if (value) edits.push({ start: pair.value.range[0], end: valueEnd, text: portsText(value) })
        else {
          // Remove ", ports: [...]" (or "ports: [...], " when it is first).
          const before = text.lastIndexOf(',', keyStart)
          const open = text.lastIndexOf('{', keyStart)
          if (before > open) edits.push({ start: before, end: valueEnd, text: '' })
          else {
            const after = /^\s*,\s*/.exec(text.slice(valueEnd))
            edits.push({ start: keyStart, end: valueEnd + (after ? after[0].length : 0), text: '' })
          }
        }
      } else if (value) {
        const close = text.lastIndexOf('}', range[1])
        let at = close
        while (at > 0 && /\s/.test(text[at - 1])) at--
        edits.push({ start: at, end: at, text: `, ports: ${portsText(value)}` })
      }
      continue
    }
    // Block edge: "- from: a\n    to: b\n    ..." — edit or add a "ports:" line.
    if (pair?.key?.range) {
      const start = lineStart(text, pair.key.range[0])
      const end = lineEnd(text, (pair.value?.range?.[1] ?? pair.key.range[1]) - 1)
      const indent = indentAt(text, pair.key.range[0])
      const own = start === pair.key.range[0] - indent.length
      if (!own) {
        // "- ports: ..." as the first key: rewrite just the value.
        if (value && pair.value?.range) edits.push({ start: pair.value.range[0], end: pair.value.range[1], text: portsText(value) })
        continue
      }
      edits.push({ start, end, text: value ? `${indent}ports: ${portsText(value)}\n` : '' })
    } else if (value) {
      const items = item.items as Pair<any, any>[]
      const last = items[items.length - 1]
      const anchor = (last?.value?.range ?? last?.key?.range) as [number, number, number] | undefined
      const first = items[0]?.key?.range as [number, number, number] | undefined
      if (!anchor || !first) continue
      const keyIndent = items.length > 1 && items[1].key?.range ? indentAt(text, items[1].key.range[0]) : `${indentAt(text, first[0])}  `
      const at = lineEnd(text, anchor[1] - 1)
      edits.push({ start: at, end: at, text: `${keyIndent}ports: ${portsText(value)}\n` })
    }
  }
  return edits
}
