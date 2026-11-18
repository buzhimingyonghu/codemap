import type { Pt } from './geo'
import { buildTree, computeCells } from './model'

// Territory layout for large projects takes long enough to drop frames, so it runs here.
// The main thread rebuilds the same tree from the same file list and attaches these cells.

export interface LayoutRequest {
  id: number
  name: string
  files: string[]
}

export type LayoutResponse = { id: number; cells: Array<[string, Float64Array]> } | { id: number; error: string }

function pack(cells: Map<string, Pt[]>): Array<[string, Float64Array]> {
  const out: Array<[string, Float64Array]> = []
  for (const [key, poly] of cells) {
    const flat = new Float64Array(poly.length * 2)
    poly.forEach(([x, y], i) => {
      flat[i * 2] = x
      flat[i * 2 + 1] = y
    })
    out.push([key, flat])
  }
  return out
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { id, name, files } = event.data
  try {
    const cells = pack(computeCells(buildTree(name, files).root))
    const response: LayoutResponse = { id, cells }
    self.postMessage(response, { transfer: cells.map(([, flat]) => flat.buffer) })
  } catch (error) {
    const response: LayoutResponse = { id, error: error instanceof Error ? error.message : String(error) }
    self.postMessage(response)
  }
}
