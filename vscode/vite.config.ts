import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// `?worker` imports, and Monaco's own `new Worker(new URL(...))`, have to go through
// Vite's worker bundler. A classic Blob of the raw worker source still contains
// `import` and throws as soon as the editor starts.
function bundleWorkersInline(): Plugin {
  return {
    name: 'lumen-bundle-workers-inline',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const bareSource = source.split('?')[0]
      const importerPath = importer?.replace(/\\/g, '/')
      if (
        /(?:^|\/)services\/projectMap(?:\.ts)?$/.test(bareSource) &&
        !importerPath?.endsWith('/src/webview/wrappers/projectMap.ts')
      ) {
        return resolve(__dirname, 'src/webview/wrappers/projectMap.ts')
      }
      if (
        /(?:^|\/)services\/documents(?:\.ts)?$/.test(bareSource) &&
        !importerPath?.endsWith('/src/webview/wrappers/documents.ts')
      ) {
        return resolve(__dirname, 'src/webview/wrappers/documents.ts')
      }
      if (
        (source === '@shared/i18n' || /(?:^|\/)shared\/i18n(?:\.ts)?$/.test(bareSource)) &&
        !importerPath?.endsWith('/src/webview/wrappers/i18n.ts')
      ) {
        return resolve(__dirname, 'src/webview/wrappers/i18n.ts')
      }
      if (
        /(?:^|\/)map\/engine(?:\.ts)?$/.test(bareSource) &&
        !importerPath?.endsWith('/src/webview/wrappers/mapEngine.ts')
      ) {
        return resolve(__dirname, 'src/webview/wrappers/mapEngine.ts')
      }
      if (
        /(?:^|\/)codemap\/engine(?:\.ts)?$/.test(bareSource) &&
        !importerPath?.endsWith('/src/webview/wrappers/codeMapEngine.ts')
      ) {
        return resolve(__dirname, 'src/webview/wrappers/codeMapEngine.ts')
      }

      if (options?.ssr || !importer) return null
      if (!source.includes('?worker') || source.includes('\0')) return null
      // Only bare package worker imports need an explicit path. `?worker&inline` stays inline.
      if (source.includes('&inline')) return null
      if (source.startsWith('.') || source.startsWith('/') || source.includes('node_modules')) return null
      const bare = source.split('?')[0]
      const resolved = await this.resolve(bare, importer, { skipSelf: true })
      if (!resolved?.id) return null
      const query = source.slice(bare.length)
      return `${resolved.id}${query}`
    },
    transform(code, id) {
      if (id.includes('\0') || id.includes('worker_file') || id.includes('?worker') || id.includes('&worker')) return null
      if (!code.includes('new Worker') || !code.includes('import.meta.url')) return null
      let changed = false
      const next = code.replace(
        /\bnew\s+URL\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url\s*\)/g,
        (match, _quote: string, specifier: string) => {
          if (!/worker/i.test(specifier) || specifier.includes('?worker') || specifier.includes('worker&inline') || specifier.startsWith('data:') || specifier.startsWith('blob:') || specifier.startsWith('/assets/')) return match
          changed = true
          const relative = specifier.startsWith('.') ? specifier : `./${specifier}`
          return `new URL(${JSON.stringify(`${relative}?worker`)}, import.meta.url)`
        }
      )
      return changed ? next : null
    },
    closeBundle() {
      const assets = resolve(__dirname, 'dist/webview/assets')
      const bundlePath = resolve(assets, 'webview.js')
      let code = `${lazyWorkerRuntime()}\n${readFileSync(bundlePath, 'utf8')}`
      const files = readdirSync(assets).filter((name) => /worker/i.test(name) && name.endsWith('.js'))
      if (files.length !== 6) this.error(`Expected 6 emitted worker assets, found ${files.length}: ${files.join(', ')}`)
      for (const name of files) {
        const publicPath = `/assets/${name}`
        const relativePath = `./${name}`
        const assetUrl = `new URL(${JSON.stringify(relativePath)},import.meta.url).href`
        const before = code
        code = replaceWorkerConstructor(code, [
          `new URL(${JSON.stringify(publicPath)},import.meta.url)`,
          `new URL(${JSON.stringify(relativePath)},import.meta.url)`,
          JSON.stringify(publicPath),
          JSON.stringify(relativePath)
        ], assetUrl)
        if (code === before) this.error(`Worker ${name} was not referenced by the webview bundle`)
      }
      if (/new Worker\(\s*(?:new URL\(\s*["'`]\/assets\/|["'`]\/assets\/)/.test(code)) {
        this.error('A worker URL still points outside the webview bundle')
      }
      writeFileSync(bundlePath, code)
    }
  }
}

function lazyWorkerRuntime(): string {
  return [
    'function __lumenLazyWorker(assetUrl,opts){',
    'var cache=self.__lumenWorkerBlobCache||(self.__lumenWorkerBlobCache=new Map);',
    'var ready=cache.get(assetUrl);',
    'if(ready&&ready.url)return new Worker(ready.url,{name:opts&&opts.name,credentials:opts&&opts.credentials});',
    'var q=[],real=null,dead=0,listeners=[];',
    'function load(){',
    'if(ready)return ready.promise;',
    'var slot={};',
    'var promise=fetch(assetUrl).then(function(r){if(!r.ok)throw new Error("Worker HTTP "+r.status);return r.text()}).then(function(text){var url=URL.createObjectURL(new Blob([text],{type:"text/javascript"}));slot.url=url;return url});',
    'slot.promise=promise;ready=slot;cache.set(assetUrl,slot);',
    'promise.catch(function(){if(cache.get(assetUrl)===slot)cache.delete(assetUrl)});',
    'return promise}',
    'function flush(url){if(dead)return;real=new Worker(url,{name:opts&&opts.name,credentials:opts&&opts.credentials});real.onmessage=facade.onmessage;real.onmessageerror=facade.onmessageerror;real.onerror=facade.onerror;listeners.forEach(function(entry){real.addEventListener(entry[0],entry[1],entry[2])});q.splice(0).forEach(function(item){real.postMessage(item[0],item[1])})}',
    'function fail(error){if(dead)return;var event=new ErrorEvent("error",{message:error&&error.message?error.message:String(error),filename:assetUrl,error:error});if(typeof facade.onerror==="function")facade.onerror(event);listeners.forEach(function(entry){if(entry[0]==="error")entry[1].call(facade,event)})}',
    'var facade=new Proxy({onmessage:null,onmessageerror:null,onerror:null},{get:function(target,key){',
    'if(key==="postMessage")return function(data,transfer){if(dead)return;if(real){real.postMessage(data,transfer||[]);return}q.push([data,transfer||[]])};',
    'if(key==="terminate")return function(){dead=1;q.length=0;if(real)real.terminate();real=null};',
    'if(key==="addEventListener")return function(type,listener,options){var call=typeof listener==="function"?listener:function(event){listener.handleEvent(event)};listeners.push([type,call,options,listener]);if(real)real.addEventListener(type,call,options)};',
    'if(key==="removeEventListener")return function(type,listener,options){var kept=[];listeners.forEach(function(entry){if(entry[0]===type&&entry[3]===listener){if(real)real.removeEventListener(entry[0],entry[1],entry[2])}else kept.push(entry)});listeners=kept};',
    'if(key==="dispatchEvent")return function(event){return real?real.dispatchEvent(event):false};',
    'if(key==="onmessage"||key==="onmessageerror"||key==="onerror")return target[key];',
    'return real?real[key]:undefined},',
    'set:function(target,key,value){if(key==="onmessage"||key==="onmessageerror"||key==="onerror"){target[key]=value;if(real)real[key]=value;return true}if(real)real[key]=value;return true}});',
    'load().then(flush,fail);return facade}'
  ].join('')
}

function replaceWorkerConstructor(source: string, scriptUrls: string[], assetUrl: string): string {
  let next = source
  for (const scriptUrl of scriptUrls) {
    const needle = `new Worker(${scriptUrl}`
    let from = 0
    while (from < next.length) {
      const start = next.indexOf(needle, from)
      if (start < 0) break
      const open = start + 'new Worker('.length
      const close = matchingParen(next, open - 1)
      if (close < 0) break
      const options = next.slice(open + scriptUrl.length, close).replace(/^\s*,\s*/, '')
      const replacement = options
        ? `__lumenLazyWorker(${assetUrl},${stripWorkerType(options)})`
        : `__lumenLazyWorker(${assetUrl})`
      next = `${next.slice(0, start)}${replacement}${next.slice(close + 1)}`
      from = start + replacement.length
    }
  }
  return next
}

function stripWorkerType(options: string): string {
  return options.replace(/([{,]\s*)type\s*:\s*"module"\s*,?/, '$1').replace(/,\s*}/, '}').replace(/{\s*}/, '{}')
}

function matchingParen(source: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function oneCopy(name: string): string {
  const nested = resolve(__dirname, 'node_modules', name)
  return existsSync(nested) ? nested : resolve(__dirname, '../node_modules', name)
}

function packageAliases(name: string): { find: RegExp; replacement: string }[] {
  const root = oneCopy(name)
  return [
    { find: new RegExp(`^${name}$`), replacement: root },
    { find: new RegExp(`^${name}/(.*)$`), replacement: `${root}/$1` }
  ]
}

function zustandAliases(): { find: RegExp; replacement: string }[] {
  const root = oneCopy('zustand')
  return [
    { find: /^zustand$/, replacement: resolve(root, 'esm/react.mjs') },
    { find: /^zustand\/(.*)$/, replacement: `${root}/$1` }
  ]
}

export default defineConfig({
  root: resolve(__dirname, 'src/webview'),
  plugins: [bundleWorkersInline(), react()],
  worker: {
    format: 'iife',
    plugins: () => []
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      ...packageAliases('react'),
      ...packageAliases('react-dom'),
      ...zustandAliases(),
      { find: '@shared', replacement: resolve(__dirname, '../src/shared') },
      { find: '@renderer', replacement: resolve(__dirname, '../src/renderer/src') }
    ]
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  build: {
    outDir: resolve(__dirname, 'dist/webview'),
    emptyOutDir: true,
    assetsDir: 'assets',
    chunkSizeWarningLimit: 20000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'assets/webview.js',
        assetFileNames: 'assets/webview[extname]'
      }
    }
  }
})
