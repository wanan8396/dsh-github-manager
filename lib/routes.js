'use strict'

/**
 * HTTP routes for @local/github-manager, served on the DSH web server.
 *
 * The callback path stays /plugins/github-oauth/callback so the built-in OAuth
 * App's registered redirect URL keeps working.
 */

const { defaultCredentials } = require('./default-app')
const { buildAuthorizeUrl, DEFAULT_SCOPE, CALLBACK_PATH, OAuthError, parseScopes } = require('./oauth')
const { completeAuthorization } = require('./auth')
const { GitHubApi } = require('./github-api')
const { collectFiles, pushFiles } = require('./push')

const BASE = '/plugins/github-manager'
const CALLBACK_BASE = '/plugins/github-oauth'
const STATE_COOKIE = 'ghm_oauth_state'
const MAX_BODY_BYTES = 64 * 1024

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

function sendHtml(res, status, title, message) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:15px/1.7 system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 24px;color:#1f2328}a{color:#0969da}.card{border:1px solid #d0d7de;border-radius:12px;padding:20px 24px;box-shadow:0 1px 3px rgba(0,0,0,.06)}h1{font-size:20px;margin:0 0 12px}.ok{color:#1a7f37}.err{color:#cf222e}</style></head><body><div class="card"><h1 class="${status < 400 ? 'ok' : 'err'}">${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">返回 DeepSeek harness</a></p></div></body></html>`
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function requestOrigin(req, port) {
  const host = req.headers && req.headers.host
  const proto = (req.headers && req.headers['x-forwarded-proto']) || (host && host.includes(':') ? 'http' : 'http')
  if (typeof host === 'string' && host !== '') return `${proto}://${host}`
  return `http://127.0.0.1:${port || 3080}`
}

function cookieValue(req, name) {
  const raw = (req.headers && req.headers.cookie) || ''
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    if (key === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()) } catch { return '' }
    }
  }
  return ''
}

function sameOriginPost(req) {
  const site = req.headers && req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'same-site' || site === 'none'
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try { return JSON.parse(text) } catch { throw new Error('invalid JSON body') }
}

function createRoutes({ store, states, port = () => 0, fetchImpl = fetch }) {
  async function handleStatus(req, res) {
    sendJson(res, 200, { ok: true, ...store.status(), scope: DEFAULT_SCOPE })
  }

  async function handleStart(req, res) {
    if ((req.method || 'GET').toUpperCase() !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: 'use POST' })
      return
    }
    if (!sameOriginPost(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request rejected', code: 'E_ORIGIN' })
      return
    }
    const body = await readJsonBody(req)
    if (!store.isConfigured()) {
      // Fall back to environment-provided credentials; without them the caller
      // gets E_NOT_CONFIGURED instead of a broken authorize URL.
      const env = defaultCredentials()
      if (!env.complete) {
        sendJson(res, 409, {
          ok: false,
          code: 'E_NOT_CONFIGURED',
          error: 'GitHub OAuth App 未配置：先在设置页填 Client ID / Secret，或设置 GITHUB_MANAGER_CLIENT_ID / GITHUB_MANAGER_CLIENT_SECRET',
        })
        return
      }
      store.configure({ clientId: env.clientId, clientSecret: env.clientSecret })
    }
    const creds = store.credentials()
    const scope = typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : DEFAULT_SCOPE
    const origin = typeof body.publicUrl === 'string' && body.publicUrl.trim() !== ''
      ? body.publicUrl.trim().replace(/\/+$/, '')
      : requestOrigin(req, port())
    const redirectUri = `${origin}${CALLBACK_PATH}`
    const pending = states.create({ redirectUri, scope })
    const authorizeUrl = buildAuthorizeUrl({ clientId: creds.clientId, redirectUri, state: pending.state, scope })
    // Pin the state to an HttpOnly cookie for browser-bound flows.
    const cookie = `${STATE_COOKIE}=${encodeURIComponent(pending.state)}; Path=/; Max-Age=600; SameSite=Lax; HttpOnly`
    sendJson(res, 200, {
      ok: true,
      authorizeUrl,
      redirectUri,
      expiresAt: pending.expiresAt,
      scope,
    }, { 'set-cookie': cookie })
  }

  async function handleCallback(req, res) {
    const url = new URL(req.url || CALLBACK_PATH, 'http://localhost')
    const code = url.searchParams.get('code') || ''
    const state = url.searchParams.get('state') || ''
    const error = url.searchParams.get('error') || ''
    if (error !== '') {
      sendHtml(res, 400, '授权被取消', `GitHub 返回：${error}`)
      return
    }
    const pending = states.take(state)
    if (pending === null) {
      sendHtml(res, 400, 'state 校验失败', '授权链接已过期或已被使用，请重新发起登录。')
      return
    }
    const cookieState = cookieValue(req, STATE_COOKIE)
    if (pending.browserBound && cookieState !== '' && cookieState !== state) {
      sendHtml(res, 400, 'state 校验失败', '浏览器 Cookie 与授权 state 不一致，请重新发起登录。')
      return
    }
    try {
      const status = await completeAuthorization(store, { code, redirectUri: pending.redirectUri, fetchImpl })
      sendHtml(res, 200, 'GitHub 授权成功', `已连接账号 ${status.activeLogin}。可以回到 DeepSeek harness 使用了。`)
    } catch (e) {
      sendHtml(res, 400, '授权失败', (e && e.message) || String(e))
    }
  }

  async function handleLogout(req, res) {
    if ((req.method || 'GET').toUpperCase() !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: 'use POST' })
      return
    }
    if (!sameOriginPost(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request rejected', code: 'E_ORIGIN' })
      return
    }
    store.clearToken()
    sendJson(res, 200, { ok: true, ...store.status() })
  }

  async function handleAccounts(req, res) {
    sendJson(res, 200, { ok: true, accounts: store.accounts(), activeLogin: store.activeLogin() })
  }

  async function handleAccountSwitch(req, res) {
    if (!sameOriginPost(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request rejected', code: 'E_ORIGIN' })
      return
    }
    const body = await readJsonBody(req)
    try {
      sendJson(res, 200, { ok: true, ...store.switchAccount(String(body.login || '')) })
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message })
    }
  }

  async function handleAccountRemove(req, res) {
    if (!sameOriginPost(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request rejected', code: 'E_ORIGIN' })
      return
    }
    const body = await readJsonBody(req)
    try {
      sendJson(res, 200, { ok: true, ...store.removeAccount(String(body.login || '')) })
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message })
    }
  }

  async function handleConfig(req, res) {
    if ((req.method || 'GET').toUpperCase() === 'POST') {
      if (!sameOriginPost(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected', code: 'E_ORIGIN' })
        return
      }
      const body = await readJsonBody(req)
      const useEnv = body.useEnv === true || body.useDefault === true
      if (useEnv) {
        const creds = defaultCredentials()
        if (!creds.complete) {
          sendJson(res, 409, {
            ok: false,
            code: 'E_NOT_CONFIGURED',
            error: '环境变量 GITHUB_MANAGER_CLIENT_ID / GITHUB_MANAGER_CLIENT_SECRET 未设置',
          })
          return
        }
        store.configure({ clientId: creds.clientId, clientSecret: creds.clientSecret })
      } else if (typeof body.clientId === 'string' && body.clientId.trim() !== '') {
        store.configure({ clientId: body.clientId, clientSecret: body.clientSecret || '' })
      } else {
        sendJson(res, 400, { ok: false, error: 'clientId is required' })
        return
      }
    }
    sendJson(res, 200, { ok: true, clientIdMasked: store.maskClientId(), oauthAppMode: store.credentials().mode })
  }

  async function handlePush(req, res) {
    if ((req.method || 'GET').toUpperCase() !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: 'use POST' })
      return
    }
    if (!sameOriginPost(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request rejected', code: 'E_ORIGIN' })
      return
    }
    const body = await readJsonBody(req)
    try {
      const dir = String(body.dir || '')
      const repo = String(body.repo || '')
      if (dir === '' || repo === '') throw new Error('dir and repo are required')
      const collected = collectFiles(dir)
      const api = new GitHubApi({ accessToken: requireToken() })
      const report = await pushFiles({
        api,
        repo,
        branch: typeof body.branch === 'string' && body.branch !== '' ? body.branch : 'main',
        files: collected.files,
        message: typeof body.message === 'string' && body.message !== '' ? body.message : 'update via dsh-github-manager',
        deletePaths: Array.isArray(body.deletePaths) ? body.deletePaths.map(String) : [],
        force: body.force === true,
        dryRun: body.dryRun === true,
      })
      const blocked = collected.skipped.filter((s) => s.reason.startsWith('blocked:'))
      const lines = []
      if (report.noop) {
        lines.push(`没有变化：${report.repo}@${report.branch} 已是最新（比对 ${collected.files.length} 个文件）`)
      } else if (report.dryRun) {
        lines.push(`预演：将提交 ${report.changed.length} 个文件到 ${report.repo}@${report.branch}`)
        lines.push(...report.changed.slice(0, 20))
      } else {
        lines.push(`${report.created ? '已创建分支' : '已提交'} ${report.repo}@${report.branch}`)
        lines.push(`commit ${report.commit.slice(0, 10)} · 变更 ${report.changed.length} · 未变 ${report.unchanged}`)
        if (report.commitUrl) lines.push(report.commitUrl)
      }
      if (blocked.length > 0) lines.push(`已拦截疑似凭据：${blocked.map((b) => b.path).join(', ')}`)
      sendJson(res, 200, { ok: true, text: lines.join('\n'), ...report, blocked })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: (error && error.message) || String(error) })
    }
  }

  async function handleRepos(req, res) {
    try {
      const token = requireToken()
      const api = new GitHubApi({ accessToken: token })
      const response = await api.get('/user/repos', { query: { per_page: 100, sort: 'updated', affiliation: 'owner' } })
      sendJson(res, 200, { ok: response.ok, repos: Array.isArray(response.json) ? response.json.map((r) => ({ fullName: r.full_name, private: r.private, description: r.description || '' })) : [], error: response.ok ? '' : response.text.slice(0, 200) })
    } catch (e) {
      sendJson(res, 200, { ok: false, repos: [], error: e.message })
    }
  }

  function requireToken() {
    const token = store.token()
    if (token === null || token.accessToken === '') throw new Error('not connected')
    return token.accessToken
  }

  async function handlePreferences(req, res) {
    if ((req.method || 'GET').toUpperCase() === 'POST') {
      if (!sameOriginPost(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected', code: 'E_ORIGIN' })
        return
      }
      const body = await readJsonBody(req)
      const patch = {}
      if (body.defaultRepo !== undefined) patch.defaultRepo = String(body.defaultRepo)
      if (body.pinnedRepos !== undefined) patch.pinnedRepos = Array.isArray(body.pinnedRepos) ? body.pinnedRepos.map(String) : []
      store.setPreferences(patch)
    }
    sendJson(res, 200, { ok: true, preferences: store.preferences() })
  }

  const wrap = (handler) => (req, res) => {
    handler(req, res).catch((error) => {
      if (res.headersSent) return
      sendJson(res, 500, { ok: false, error: (error && error.message) || String(error) })
    })
  }

  const routes = [
    { kind: 'exact', path: `${BASE}/status`, handler: wrap(handleStatus) },
    { kind: 'exact', path: `${BASE}/start`, handler: wrap(handleStart) },
    { kind: 'exact', path: CALLBACK_PATH, handler: wrap(handleCallback) },
    { kind: 'exact', path: `${BASE}/logout`, handler: wrap(handleLogout) },
    { kind: 'exact', path: `${BASE}/accounts`, handler: wrap(handleAccounts) },
    { kind: 'exact', path: `${BASE}/accounts/switch`, handler: wrap(handleAccountSwitch) },
    { kind: 'exact', path: `${BASE}/accounts/remove`, handler: wrap(handleAccountRemove) },
    { kind: 'exact', path: `${BASE}/config`, handler: wrap(handleConfig) },
    { kind: 'exact', path: `${BASE}/push`, handler: wrap(handlePush) },
    { kind: 'exact', path: `${BASE}/repos`, handler: wrap(handleRepos) },
    { kind: 'exact', path: `${BASE}/preferences`, handler: wrap(handlePreferences) },
  ]
  return { routes, BASE, CALLBACK_PATH }
}

module.exports = { createRoutes, BASE, CALLBACK_PATH }
