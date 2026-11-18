// 从磁盘读取节点库。主进程、命令行和测试共用。两种目录结构：
//   1. 有 nodes/：nodes/、links/、requirements/ 三个目录下的 yaml
//   2. 没有 nodes/：按节点分文件夹（每个文件夹一个 yaml + docs/），递归读整个目录，按内容区分节点 / 链路 / 需求；
//      根目录 .codemapignore 里写的目录 / 文件不读，其余全部读。
//      contains 里 { ref, path } 引用的节点不在这个目录下时，按 path 去它的文件夹补读（只读那个文件夹，不往下递归读别的引用）
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { fileKind, IGNORE_FILE, DEFAULT_IGNORE, parseIgnore, isIgnored, refPaths } from '../../shared/codemap/codemap.mjs'

// rules 不传：老布局，读目录下全部 yaml
function listYaml(dir, rules = null, root = dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full).split(path.sep).join('/')
    if (rules && isIgnored(rules, rel, entry.isDirectory())) continue
    if (entry.isDirectory()) out.push(...listYaml(full, rules, root))
    else if (/\.ya?ml$/.test(entry.name)) out.push(full)
  }
  return out.sort()
}

// 节点库的忽略规则：根目录有 .codemapignore 就用它，没有用默认值
export function loadIgnore(dir) {
  const file = path.join(dir, IGNORE_FILE)
  return parseIgnore(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : DEFAULT_IGNORE.join('\n'))
}

// 返回 { docs, links, requirements, errors }；yaml 写错的文件放进 errors，不中断
export function loadLibrary(dir) {
  const rel = (file) => path.relative(dir, file).split(path.sep).join('/')
  const errors = []
  const read = (file) => {
    try {
      return yaml.load(fs.readFileSync(file, 'utf8')) ?? {}
    } catch (error) {
      errors.push({ level: 'error', rule: 'yaml', where: rel(file), msg: error.message })
      return null
    }
  }
  const load = (sub) => listYaml(path.join(dir, sub)).map((file) => ({ file: rel(file), data: read(file) })).filter((d) => d.data)
  if (!fs.existsSync(path.join(dir, 'nodes'))) {
    const rules = loadIgnore(dir)
    const all = listYaml(dir, rules).map((file) => ({ file: rel(file), data: read(file) })).filter((d) => d.data)
    // 补读引用的节点：path 相对引用方 yaml 所在的文件夹。引用的 id 已经读到（含就地定义的子节点），
    // 或者那个文件夹里的文件已经读过，就不再读
    const ids = new Set()
    const collect = (n, id) => {
      ids.add(id)
      for (const it of Array.isArray(n?.contains) ? n.contains : []) if (it && typeof it === 'object' && typeof it.id === 'string') collect(it, `${id}.${it.id}`)
    }
    for (const d of all) if (fileKind(d.data) === 'node' && typeof d.data.id === 'string') collect(d.data, d.data.id)
    const readFiles = new Set(all.map((d) => path.resolve(dir, d.file)))
    const seenDirs = new Set()
    for (let i = 0; i < all.length; i++) {
      const d = all[i]
      if (fileKind(d.data) !== 'node') continue
      for (const { ref, path: p } of refPaths(d.data)) {
        if (ids.has(ref) || !p) continue
        const target = path.resolve(dir, path.dirname(d.file), p)
        if (seenDirs.has(target) || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) continue
        seenDirs.add(target)
        for (const file of listYaml(target, parseIgnore(DEFAULT_IGNORE.join('\n')))) {
          if (readFiles.has(path.resolve(file))) continue
          readFiles.add(path.resolve(file))
          const data = read(file)
          if (!data) continue
          all.push({ file: rel(file), data })
          if (fileKind(data) === 'node' && typeof data.id === 'string') collect(data, data.id)
        }
      }
    }
    return {
      docs: all.filter((d) => fileKind(d.data) === 'node').map((d) => ({ file: d.file, node: d.data })),
      links: all.filter((d) => fileKind(d.data) === 'link'),
      requirements: all.filter((d) => fileKind(d.data) === 'requirement').map((d) => ({ file: d.file, ...d.data })),
      todos: listTodos(dir),
      errors
    }
  }
  return {
    docs: load('nodes').map((d) => ({ file: d.file, node: d.data })),
    links: load('links'),
    requirements: load('requirements').map((d) => ({ file: d.file, ...d.data })),
    todos: listTodos(dir),
    errors
  }
}

// 待办：每个文件夹里的 todo/*.md，一件事一个文件。todo/ 不当节点读、不检查，这里只列文件名和标题
// （第一行 # 标题，没有就用文件名）。返回 [{ file: 相对节点库的路径, dir: todo/ 所在的文件夹, title }]
export function listTodos(dir) {
  const out = []
  const walk = (sub) => {
    const abs = path.join(dir, sub)
    let entries
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '_templates') continue
      const child = sub ? `${sub}/${entry.name}` : entry.name
      if (entry.name !== 'todo') {
        walk(child)
        continue
      }
      for (const f of fs.readdirSync(path.join(dir, child), { withFileTypes: true })) {
        if (!f.isFile() || !/\.md$/i.test(f.name)) continue
        const file = `${child}/${f.name}`
        let title = f.name.replace(/\.md$/i, '')
        try {
          const head = fs.readFileSync(path.join(dir, file), 'utf8').slice(0, 2000)
          const m = /^\s*#\s+(.+?)\s*$/m.exec(head)
          if (m) title = m[1]
        } catch {
          // unreadable: keep the file name
        }
        out.push({ file, dir: sub, title })
      }
    }
  }
  walk('')
  return out.sort((a, b) => a.file.localeCompare(b.file))
}
