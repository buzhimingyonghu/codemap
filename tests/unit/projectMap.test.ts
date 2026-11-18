import { describe, expect, it } from 'vitest'
import { contains, organic, polyArea, type Pt } from '../../src/renderer/src/map/geo'
import {
  applyChurn,
  attachCells,
  buildTree,
  chainOf,
  computeCells,
  computeHeat,
  filesUnder,
  folderKey,
  frequentFolders,
  nameWords,
  nodeAt,
  readingSeeds,
  regionAt,
  shape,
  sharedPrefix,
  stripCells,
  townsOf,
  type MapNode
} from '../../src/renderer/src/map/model'
import { parseChurn } from '../../src/shared/gitParse'

const FILES = [
  'README.md',
  'package.json',
  'src/main/index.ts',
  'src/main/ipc.ts',
  'src/renderer/App.tsx',
  'src/renderer/views/Explorer.tsx',
  'src/renderer/views/Git.tsx',
  'src/shared/types.ts',
  'docs/guide/intro/index.md',
  'tests/unit/a.test.ts'
]

const NOW = Date.UTC(2026, 9, 28)

function centroidInside(child: Pt[], parent: Pt[]): boolean {
  let x = 0
  let y = 0
  for (const [px, py] of child) {
    x += px
    y += py
  }
  return contains(parent, x / child.length, y / child.length)
}

describe('project map tree', () => {
  it('builds folders before files, sorted by name, with a district for loose files', () => {
    const { root } = buildTree('demo', FILES)
    expect(root.children.map((c) => c.name)).toEqual(['docs/guide/intro', 'src', 'tests/unit', 'package.json', 'README.md'])
    expect(root.fileCount).toBe(FILES.length)
    // Root has folders and loose files, so the files form one virtual district.
    const district = root.kids[root.kids.length - 1]
    expect(district.virtual).toBe(true)
    expect(district.group).toBe('files')
    expect(filesUnder(district).map((f) => f.name)).toEqual(['package.json', 'README.md'])
    expect(root.regions.map((r) => r.name)).toEqual(['docs/guide/intro', 'src', 'tests/unit'])
  })

  it('folds single-folder chains into one region but still resolves each link', () => {
    const tree = buildTree('demo', FILES)
    const docs = nodeAt(tree, 'docs/guide/intro')
    expect(docs.name).toBe('docs/guide/intro')
    expect(nodeAt(tree, 'docs')).toBe(docs)
    expect(nodeAt(tree, 'docs/guide')).toBe(docs)
    expect(regionAt(tree, 'docs/guide/intro/index.md')).toBe(docs)
    expect(nodeAt(tree, 'missing/deep/file.ts')).toBe(tree.root)
    expect(chainOf(nodeAt(tree, 'src/renderer/views')).map((n) => n.name)).toEqual(['demo', 'src', 'renderer', 'views'])
  })

  it('labels a folded chain with its own folder name only, keeping every segment for the trail', () => {
    const tree = buildTree('demo', ['components/billing/告警/国内/a.json', 'components/billing/告警/国外/b.json', 'components/search/告警/国内/c.json', 'components/search/告警/国外/d.json'])
    const billing = nodeAt(tree, 'components/billing')
    expect(billing.name).toBe('billing/告警')
    expect(billing.segments).toEqual(['billing', '告警'])
    expect(billing.short).toBe('billing')
    expect(nodeAt(tree, 'components/billing/告警')).toBe(billing)
  })

  it('colors every territory on a level, and never gives touching siblings the same color', () => {
    const names: string[] = []
    for (const p of ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu']) names.push(`${p}/a.ts`, `${p}/b.ts`)
    const tree = buildTree('demo', names)
    attachCells(tree, computeCells(tree.root))
    const kids = tree.root.kids
    expect(kids.every((k) => k.slot >= 0)).toBe(true)
    // Touching = sharing a border vertex with the other's outline.
    const near = (a: MapNode, b: MapNode) => a.cell.some(([x, y]) => b.cell.some(([u, v]) => Math.hypot(x - u, y - v) < 1e-3))
    for (let i = 0; i < kids.length; i++)
      for (let j = i + 1; j < kids.length; j++) if (near(kids[i], kids[j])) expect(kids[i].slot).not.toBe(kids[j].slot)
    // Files take their folder's color.
    expect(nodeAt(tree, 'beta/a.ts').slot).toBe(nodeAt(tree, 'beta').slot)
  })
})

describe('project map heat', () => {
  it('ranks opens above churn and lets folders inherit their hottest file', () => {
    const tree = buildTree('demo', FILES)
    applyChurn(tree, { 'src/main/ipc.ts': 1, 'README.md': 0.2 })
    computeHeat(tree, { 'src/renderer/App.tsx': { score: 3, count: 3, at: NOW } }, NOW)
    const app = nodeAt(tree, 'src/renderer/App.tsx')
    const ipc = nodeAt(tree, 'src/main/ipc.ts')
    expect(app.heat).toBeGreaterThan(ipc.heat)
    expect(ipc.heat).toBeGreaterThan(0)
    expect(nodeAt(tree, 'src/shared/types.ts').heat).toBe(0)
    expect(nodeAt(tree, 'src').hottest).toBe(app)
    expect(app.opens).toBe(3)
  })

  it('decays opens with a 14 day half-life', () => {
    const tree = buildTree('demo', ['a.ts', 'b.ts', 'c.ts'])
    computeHeat(
      tree,
      {
        'a.ts': { score: 4, count: 4, at: NOW - 28 * 86400e3 },
        'b.ts': { score: 2, count: 2, at: NOW }
      },
      NOW
    )
    expect(nodeAt(tree, 'a.ts').score).toBeCloseTo(3)
    expect(nodeAt(tree, 'b.ts').score).toBeCloseTo(6)
    expect(nodeAt(tree, 'b.ts').heat).toBeGreaterThan(nodeAt(tree, 'a.ts').heat)
  })
})

describe('project map territories', () => {
  const tree = buildTree('demo', FILES)
  const cells = computeCells(tree.root)
  attachCells(tree, cells)

  it('is deterministic for the same file list', () => {
    const again = computeCells(buildTree('demo', [...FILES].reverse()).root)
    expect([...again.keys()].sort()).toEqual([...cells.keys()].sort())
    for (const [key, poly] of cells) expect(again.get(key)).toEqual(poly)
  })

  it('places territories in file-tree order: first names at the top, last at the bottom', () => {
    const names = ['.claude', '.codebuddy', 'bigdata', 'buffer', 'cache', 'cmd', 'configs', 'deploy', 'etcd', 'logs', 'metrics', 'models', 'protos', 'redis', 'report', 'sinks', 'sources', 'tranformers', 'utils', 'zeta']
    const t = buildTree('demo', [...names.map((d) => `${d}/a.go`), ...names.map((d) => `${d}/b.go`), 'go.mod', 'README.md'])
    attachCells(t, computeCells(t.root))
    const kids = t.root.kids
    // Folders in name order, then the loose-file district last.
    expect(kids.map((k) => k.name).slice(0, 3)).toEqual(['.claude', '.codebuddy', 'bigdata'])
    expect(kids[kids.length - 1].group).toBe('files')
    const y = (k: MapNode) => shape(k).anchor[1]
    const b = shape(t.root).bb
    // The first few sit in the top third, the last few in the bottom third.
    for (const k of kids.slice(0, 3)) expect((y(k) - b.y0) / b.h).toBeLessThan(0.4)
    for (const k of kids.slice(-3)) expect((y(k) - b.y0) / b.h).toBeGreaterThan(0.6)
    // Overall the vertical position follows name order.
    let agree = 0
    let pairs = 0
    for (let i = 0; i < kids.length; i++)
      for (let j = i + 1; j < kids.length; j++) {
        pairs++
        if (y(kids[i]) <= y(kids[j]) + b.h * 0.05) agree++
      }
    expect(agree / pairs).toBeGreaterThan(0.85)
  })

  it('seeds every site inside the clip, in reading order', () => {
    const blob: Pt[] = Array.from({ length: 60 }, (_, i) => {
      const a = (i / 60) * Math.PI * 2
      const r = 100 * (1 + 0.25 * Math.sin(a * 3))
      return [Math.cos(a) * r, Math.sin(a) * r * 0.7] as Pt
    })
    const seeds = readingSeeds(blob, 23)
    expect(seeds).toHaveLength(23)
    for (const s of seeds) expect(contains(blob, s[0], s[1])).toBe(true)
    for (let i = 1; i < seeds.length; i++) expect(seeds[i][1] > seeds[i - 1][1] || seeds[i][0] > seeds[i - 1][0]).toBe(true)
  })

  it('nests every cell inside its parent and gives every node area', () => {
    const visit = (node: MapNode) => {
      if (node.kind === 'dir') {
        let sum = 0
        for (const kid of node.kids) {
          expect(Math.abs(polyArea(kid.cell))).toBeGreaterThan(0)
          expect(centroidInside(kid.cell, node.cell)).toBe(true)
          sum += Math.abs(polyArea(kid.cell))
          visit(kid)
        }
        if (node.kids.length) expect(sum).toBeCloseTo(Math.abs(polyArea(node.cell)), 0)
      }
    }
    visit(tree.root)
  })

  it('places each town inside its drawn territory', () => {
    for (const file of filesUnder(tree.root)) {
      const outline = organic(file.cell, 0.5)
      expect(contains(outline, file.x, file.y)).toBe(true)
    }
  })

  it('splits very wide folders into strips that tile the parent', () => {
    const many = Array.from({ length: 260 }, (_, i) => `wide/dir-${i}/a.txt`)
    const wide = buildTree('demo', many)
    const folder = nodeAt(wide, 'wide')
    const clip: Pt[] = [
      [0, 0],
      [100, 0],
      [100, 60],
      [0, 60]
    ]
    const value = new Map(folder.kids.map((k) => [k, 1]))
    const strips = stripCells(clip, folder.kids, value)
    expect(strips).toHaveLength(260)
    const total = strips.reduce((s, [, poly]) => s + Math.abs(polyArea(poly)), 0)
    expect(total).toBeCloseTo(6000, 3)
    // The layout routes such folders to strips automatically.
    const laid = computeCells(wide.root)
    expect(laid.has('wide/dir-259/a.txt')).toBe(true)
  })
})

describe('prefix districts', () => {
  it('splits words and skips leading numbers', () => {
    expect(nameWords('0084_machinegroup_and_config.sql')).toEqual(['machinegroup', 'and', 'config', 'sql'])
    expect(nameWords('shop-order-server.Api.ap-tokyo')).toEqual(['shop', 'order', 'server', 'api', 'ap', 'tokyo'])
    expect(sharedPrefix(['shop-order-server.Api.ap-tokyo', 'shop-order-server.Api.eu-moscow'])).toBe('shop-order-server.Api.')
    expect(sharedPrefix(['abc', 'abd'])).toBe('')
  })

  it('groups files sharing a prefix however few, keeps singles loose, and labels the rest', () => {
    const names = ['0001_add_a.sql', '0002_add_b.sql', '0003_alter_x.sql', '0004_alter_y.sql', '0005_alter_z.sql', '0006_init.sql']
    const tree = buildTree('demo', names.map((n) => `sql/${n}`))
    const sql = nodeAt(tree, 'sql')
    // File districts and loose files share one name order, as in the file tree.
    expect(sql.kids.map((k) => (k.virtual ? `[${k.name}]` : k.name))).toEqual(['0006_init.sql', '[add]', '[alter]'])
    const add = sql.kids[1]
    expect(add.members).toBe(2)
    expect(add.kids.map((k) => k.short)).toEqual(['0001_add_a.sql', '0002_add_b.sql'])
    expect(sql.districts.map((d) => d.name)).toEqual(['add', 'alter'])
    expect(townsOf(sql)).toHaveLength(6)
    expect(nodeAt(tree, 'sql/0004_alter_y.sql').district).toBe(sql.kids[2])
  })

  it('nests large prefix groups and strips the shared prefix from labels', () => {
    const regions = ['ap-bangkok', 'ap-beijing', 'ap-chengdu', 'ap-tokyo', 'eu-frankfurt', 'eu-moscow', 'na-ashburn', 'na-toronto']
    const names: string[] = []
    for (const svc of ['Api', 'Web']) for (let i = 0; i < 4; i++) for (const r of regions) names.push(`shop-server.${svc}.${r}.${1000 + i}.config`)
    const tree = buildTree('demo', names.map((n) => `conf/${n}/x.yaml`))
    const conf = nodeAt(tree, 'conf')
    expect(conf.kids.map((k) => k.name)).toEqual(['Api', 'Web'])
    const api = conf.kids[0]
    expect(api.prefix).toBe('shop-server.Api.')
    expect(api.kids.map((k) => k.name)).toEqual(['ap', 'eu', 'na'])
    // The shared ".config" tail is dropped from labels; the folder keeps its real name.
    expect(api.kids[0].kids[0].short).toBe('bangkok.1000')
    expect(api.kids[0].kids[0].name).toBe('shop-server.Api.ap-bangkok.1000.config')
    expect(conf.regions).toHaveLength(names.length)
    // Folder names keep their own case.
    expect(conf.kids[0].name).toBe('Api')
  })

  it('lays out many files in reading order inside the district, top to bottom then across', () => {
    const names = Array.from({ length: 40 }, (_, i) => `logs/${String(i).padStart(4, '0')}_add_${i}.sql`)
    names.push('logs/0100_alter_a.sql', 'logs/0101_alter_b.sql', 'logs/0102_alter_c.sql')
    const tree = buildTree('demo', names)
    attachCells(tree, computeCells(tree.root))
    const logs = nodeAt(tree, 'logs')
    const district = logs.kids[0]
    expect(district.name).toBe('add')
    expect(district.lattice).toBe(true)
    expect(district.slotW).toBeGreaterThan(0)
    const files = district.kids
    for (let i = 1; i < files.length; i++) {
      const [a, b] = [files[i - 1], files[i]]
      // Each next file is either lower in the same column or starts a column to the right.
      expect(b.y > a.y + 1e-9 || b.x > a.x + 1e-9).toBe(true)
      if (Math.abs(b.x - a.x) < 1e-9) expect(b.y).toBeGreaterThan(a.y)
    }
    const outline = organic(district.cell, 0.5)
    for (const f of files) expect(contains(outline, f.x, f.y)).toBe(true)
  })

  it('lets a folder whose files all share one prefix be the district itself', () => {
    const tree = buildTree('demo', Array.from({ length: 30 }, (_, i) => `logs/${i}_add_${i}.sql`))
    const logs = nodeAt(tree, 'logs')
    expect(logs.districts).toHaveLength(0)
    expect(logs.lattice).toBe(true)
  })
})

describe('folder visits', () => {
  it('counts entries per folder and ranks frequent folders', () => {
    const tree = buildTree('demo', FILES)
    const now = NOW
    const usage = {
      [folderKey('src/main')]: { score: 4, count: 4, at: now },
      [folderKey('tests/unit')]: { score: 1, count: 1, at: now },
      'src/main/ipc.ts': { score: 9, count: 9, at: now }
    }
    computeHeat(tree, usage, now)
    expect(nodeAt(tree, 'src/main').visits).toBe(4)
    expect(frequentFolders(tree, usage, now, 5).map((n) => n.rel)).toEqual(['src/main', 'tests/unit'])
  })
})

describe('git churn', () => {
  it('weights recent commits more and ignores sweeping commits', () => {
    const day = 86400
    const now = 1_800_000_000
    const sweeping = Array.from({ length: 50 }, (_, i) => `gen/${i}.ts`).join('\0')
    const output = [
      `\x01${now - day}\n\0src/a.ts\0src/b.ts\0`,
      `\x01${now - 60 * day}\n\0src/b.ts\0`,
      `\x01${now - 2 * day}\n\0${sweeping}\0`,
      `\x01${now - 3 * day}\n\0src/a.ts\0`
    ].join('')
    const churn = parseChurn(output, now)
    expect(churn['src/a.ts']).toBe(1)
    expect(churn['src/b.ts']).toBeGreaterThan(0.4)
    expect(churn['src/b.ts']).toBeLessThan(1)
    expect(churn['gen/0.ts']).toBeUndefined()
    expect(parseChurn('', now)).toEqual({})
  })
})
