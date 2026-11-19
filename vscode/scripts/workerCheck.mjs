import { readdirSync, readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { resolve } from 'node:path'

export function assertBundledWorkers(root) {
  const assets = resolve(root, 'dist/webview/assets')
  const bundle = resolve(assets, 'webview.js')
  const text = readFileSync(bundle, 'utf8')
  const workers = externalWorkerFiles(root)
  if (workers.length !== 6) throw new Error(`Expected 5 Monaco workers and 1 layout worker, found ${workers.length}`)
  if (text.length >= 16 * 1024 * 1024) throw new Error(`webview.js is still ${text.length} bytes; workers were not split out`)
  if (!text.includes('function __lumenLazyWorker')) throw new Error('webview.js does not define __lumenLazyWorker')
  if (/new Worker\(\s*(?:new URL\(\s*["'`]\/assets\/|["'`]\/assets\/)/.test(text)) {
    throw new Error('A worker URL still points at an external /assets script')
  }
  for (const file of workers) {
    if (!text.includes(`new URL(${JSON.stringify(`./${file.name}`)},import.meta.url)`)) {
      throw new Error(`webview.js does not reference ${file.name} through import.meta.url`)
    }
    assertClassicWorker(file.code, file.name)
  }
  return workers
}

export function externalWorkerFiles(root) {
  const assets = resolve(root, 'dist/webview/assets')
  return readdirSync(assets)
    .filter((name) => /worker/i.test(name) && name.endsWith('.js'))
    .sort()
    .map((name) => ({
      name,
      code: readFileSync(resolve(assets, name), 'utf8')
    }))
}

export function bundledWorkerBodies(scripts) {
  return scripts.filter((code) => code.includes('(function()') && /\bonmessage\b|\bself\b/.test(code) && code.length > 1000)
}

export function inlineWorkerScripts(source) {
  const scripts = []
  const seen = new Set()
  const marker = 'new Blob(['
  let from = 0
  while (from < source.length) {
    const start = source.indexOf(marker, from)
    if (start < 0) break
    const pieces = readBlobPieces(source, start + marker.length)
    from = pieces.end
    for (const piece of pieces.values) {
      if (piece.length < 40 || seen.has(piece)) continue
      if (!/onmessage|\bself\b|worker|revokeObjectURL/i.test(piece.slice(0, 800)) && !piece.includes('(function()')) continue
      seen.add(piece)
      scripts.push(piece)
    }
  }
  return scripts
}

function readBlobPieces(source, start) {
  const values = []
  let index = start
  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index])) index += 1
    if (source[index] === ']') return { values, end: index + 1 }
    if (source[index] === '"' || source[index] === "'" || source[index] === '`') {
      const decoded = decodeJsString(source, index)
      if (!decoded) return { values, end: source.length }
      values.push(decoded.value)
      index = decoded.end
      continue
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][\w$]*/)
    if (!identifier) return { values, end: index + 1 }
    const binding = identifier[0]
    const literal = findStringBinding(source, binding)
    if (literal) values.push(literal)
    index += binding.length
  }
  return { values, end: index }
}

function findStringBinding(source, binding) {
  const pattern = new RegExp(`(?:const|let|var)\\s+${binding}\\s*=\\s*(['\"\`])`)
  const match = pattern.exec(source)
  if (!match) return null
  return decodeJsString(source, match.index + match[0].length - 1)?.value ?? null
}

function assertClassicWorker(code, name) {
  try {
    new Script(code)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/import|export/i.test(message)) {
      throw new Error(`Worker ${name} still contains an unbundled import or export: ${message}`)
    }
    throw new Error(`Worker ${name} is not valid classic JavaScript: ${message}`)
  }
}

function decodeJsString(source, start) {
  const quote = source[start]
  if (quote !== '"' && quote !== "'" && quote !== '`') return null
  let value = ''
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      const next = source[index + 1]
      if (next === undefined) return null
      if (next === 'u' && source[index + 2] === '{') {
        const end = source.indexOf('}', index + 3)
        if (end < 0) return null
        value += String.fromCodePoint(Number.parseInt(source.slice(index + 3, end), 16))
        index = end
        continue
      }
      if (next === 'u') {
        value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16))
        index += 5
        continue
      }
      if (next === 'x') {
        value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 4), 16))
        index += 3
        continue
      }
      const mapped = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '"': '"', "'": "'", '`': '`', '\n': '', '\r': '' }
      value += Object.prototype.hasOwnProperty.call(mapped, next) ? mapped[next] : next
      index += 1
      continue
    }
    if (quote === '`' && char === '$' && source[index + 1] === '{') return null
    if (char === quote) return { value, end: index + 1 }
    value += char
  }
  return null
}
