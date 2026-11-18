import { isMap, isSeq, parseDocument, type Document } from 'yaml'

// Writes an edited node object back into its YAML file while keeping comments and formatting.
// The change set engine produces the new plain object; here we diff it against the parsed
// document and update only what changed, recursively (maps by key, lists by position or id).

type Plain = unknown

function same(a: Plain, b: Plain): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function keyOf(item: Plain): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return typeof item === 'string' ? 's:' + item : null
  const o = item as Record<string, unknown>
  if (typeof o.id === 'string') return 'id:' + o.id
  if (typeof o.ref === 'string') return 'ref:' + o.ref
  if (typeof o.from === 'string' && typeof o.to === 'string') return 'e:' + o.from + '->' + o.to
  if (typeof o.name === 'string') return 'n:' + o.name
  return null
}

/** Updates `node` (a YAML collection inside `doc`) so it equals `next`. */
function sync(doc: Document, node: any, next: Plain): any {
  if (isMap(node) && next && typeof next === 'object' && !Array.isArray(next)) {
    const target = next as Record<string, unknown>
    for (const pair of [...node.items]) {
      const k = String((pair.key as any)?.value ?? pair.key)
      if (!(k in target)) node.delete(k)
    }
    for (const [k, v] of Object.entries(target)) {
      const current = node.get(k, true)
      const plain = current && typeof current === 'object' && 'toJSON' in current ? (current as any).toJSON() : node.get(k)
      if (same(plain, v)) continue
      if (current && (isMap(current) || isSeq(current)) && v && typeof v === 'object') sync(doc, current, v)
      else node.set(k, doc.createNode(v))
    }
    return node
  }
  if (isSeq(node) && Array.isArray(next)) {
    const items = node.items as any[]
    const plainOf = (x: any) => (x && typeof x === 'object' && 'toJSON' in x ? x.toJSON() : x?.value ?? x)
    const byKey = new Map<string, any>()
    for (const x of items) {
      const k = keyOf(plainOf(x))
      if (k && !byKey.has(k)) byKey.set(k, x)
    }
    const out: any[] = []
    next.forEach((v, i) => {
      const k = keyOf(v)
      const existing = (k ? byKey.get(k) : undefined) ?? (k ? undefined : items[i])
      if (existing && same(plainOf(existing), v)) out.push(existing)
      else if (existing && (isMap(existing) || isSeq(existing)) && v && typeof v === 'object') out.push(sync(doc, existing, v))
      else out.push(doc.createNode(v))
    })
    node.items = out
    return node
  }
  return doc.createNode(next)
}

/** The file text with the top-level node replaced by `next`, comments kept where possible. */
export function rewriteNodeFile(text: string, next: Record<string, unknown>): string {
  const doc = parseDocument(text)
  if (doc.errors.length || !isMap(doc.contents)) throw new Error('Cannot parse the node file')
  sync(doc, doc.contents, next)
  const out = doc.toString({ lineWidth: 0 })
  const check = parseDocument(out)
  if (check.errors.length) throw new Error('Rewriting the node file would break the YAML: ' + check.errors[0].message)
  if (!same(check.toJS(), next)) throw new Error('Rewriting the node file did not round-trip')
  return out
}
