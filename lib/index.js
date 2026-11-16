'use strict'

/**
 * Host entry for @local/github-manager.
 *
 * - HTTP routes under /plugins/github-manager and the OAuth callback
 * - a full set of `gh_*` model-facing tools over the same OAuth token
 * - the browser panel in ./lib/client.js
 *
 * All secrets live in one AES-256-GCM vault ($DSH_HOME/github-manager).
 */

const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { VaultStore } = require('./vault')
const { PendingStates } = require('./state')
const { createRoutes, CALLBACK_PATH } = require('./routes')
const { buildTools } = require('./tools')

exports.name = '@local/github-manager'
exports.inject = ['tools', 'webServer']

function report(message) {
  try {
    process.stderr.write(`${exports.name}: ${message}\n`)
  } catch {
    // ignore
  }
}

function resolveBases() {
  const bases = new Set([__dirname, process.cwd()])
  if (require.main && require.main.filename) bases.add(path.dirname(require.main.filename))
  if (process.execPath) bases.add(path.dirname(process.execPath))
  if (process.env.DSH_RUNTIME_DIR) bases.add(process.env.DSH_RUNTIME_DIR)
  // The dsh installation tree: a profile bundle's node_modules does not carry
  // the shipped @deepseek-ai packages, so the tools module lives over there.
  for (const candidate of [
    process.env.DSH_INSTALL_DIR,
    '/opt/dsh',
    '/opt/dsh/node_modules',
    '/usr/lib/node_modules/dsh',
    '/usr/local/lib/node_modules/dsh',
  ]) {
    if (typeof candidate === 'string' && candidate !== '') bases.add(candidate)
  }
  // Walk up from this package: <root>/node_modules/@local/<pkg>/lib -> <root>.
  let cursor = __dirname
  for (let depth = 0; depth < 6; depth += 1) {
    bases.add(cursor)
    bases.add(path.join(cursor, 'node_modules'))
    cursor = path.dirname(cursor)
    if (cursor === '/' || cursor === '') break
  }
  return [...bases].filter((b) => typeof b === 'string' && b !== '')
}

const TOOLS_MODULE = '@deepseek-ai/dsh-tools'

function acquireDefineTool() {
  const paths = []
  const notes = []
  for (const base of resolveBases()) {
    let resolved
    try { resolved = require.resolve(TOOLS_MODULE, { paths: [base] }) } catch { continue }
    paths.push(resolved)
    try {
      const loaded = require(resolved)
      if (typeof loaded.defineTool === 'function') return { defineTool: loaded.defineTool, paths, note: '' }
      notes.push(`${resolved}: no defineTool`)
    } catch (error) { notes.push(`${resolved}: ${error.code || error.message}`) }
  }
  return { defineTool: null, paths, note: notes.join('; ') }
}

async function importDefineTool(paths) {
  for (const resolved of [...new Set(paths)]) {
    try {
      const loaded = await import(pathToFileURL(resolved).href)
      if (typeof loaded.defineTool === 'function') return loaded.defineTool
    } catch {}
  }
  return null
}

function registerTools(defineTool, ctx, deps) {
  const tools = buildTools({ defineTool, ...deps })
  const names = []
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `github-manager: tool ${tool.name}`)
    names.push(tool.name)
  }
  return names
}

exports.apply = function apply(ctx, config = {}) {
  const store = new VaultStore({ dataDir: config.dataDir })
  try { store.ensure() } catch (error) { report(`vault unavailable: ${error.message}`) }

  const states = new PendingStates()
  const cache = new Map()
  const port = () => (ctx.webServer && typeof ctx.webServer.port === 'number' ? ctx.webServer.port : 3080)

  const { routes } = createRoutes({ store, states, port, cache })
  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register(route), `github-manager: route ${route.path}`)
  }

  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    report('host did not provide the tools service; gh_* tools are not registered')
    return
  }

  const deps = { store, states, cache, port, publicUrl: typeof config.publicUrl === 'string' ? config.publicUrl : '' }
  const acquired = acquireDefineTool()
  if (acquired.defineTool !== null) {
    const names = registerTools(acquired.defineTool, ctx, deps)
    report(`registered ${names.length} tool(s): ${names.join(', ')}`)
    return
  }
  return importDefineTool(acquired.paths).then((defineTool) => {
    if (defineTool === null) {
      report(`cannot load ${TOOLS_MODULE}; gh_* tools are not registered`)
      return
    }
    const names = registerTools(defineTool, ctx, deps)
    report(`registered ${names.length} tool(s): ${names.join(', ')}`)
  })
}

exports.probe = function probe(config = {}) {
  const store = new VaultStore({ dataDir: config.dataDir })
  const acquired = acquireDefineTool()
  let status = null
  let error = null
  try { status = store.status() } catch (e) { error = e.message }
  return {
    name: exports.name,
    defineTool: acquired.defineTool !== null,
    toolsModuleNote: acquired.note,
    vault: status === null ? { error } : status.vault,
    configured: status === null ? null : status.configured,
    connected: status === null ? null : status.connected,
  }
}
