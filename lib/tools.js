'use strict'

/**
 * Native agent tools for @local/github-manager.
 *
 * Every tool returns one envelope:
 *   { ok, code, text, data, status, rateLimitRemaining, rateLimitReset }
 * gh_api is the universal escape hatch: any GitHub REST verb/path. The other
 * tools are convenience wrappers over the same client.
 */

const { DEFAULT_SCOPE, buildAuthorizeUrl, CALLBACK_PATH } = require('./oauth')
const { defaultCredentials } = require('./default-app')
const { AuthError, requireAccessToken } = require('./auth')
const { GitHubApi, GitHubApiError } = require('./github-api')
const { collectFiles, pushFiles } = require('./push')

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    code: { type: 'string', required: true },
    text: { type: 'string', required: true },
    data: { type: 'json' },
    status: { type: 'integer' },
    rateLimitRemaining: { type: 'json' },
    rateLimitReset: { type: 'json' },
  },
}

const MAX_TEXT = 60000

function bounded(value, max = MAX_TEXT) {
  let text
  try { text = JSON.stringify(value, null, 2) } catch { text = String(value) }
  if (text === undefined) return ''
  return text.length > max ? `${text.slice(0, max)}\n…(truncated ${text.length} chars)` : text
}

function envelope({ ok, code, text, data = null, status = 0, rateLimit = null }) {
  return {
    ok, code, text, data, status,
    rateLimitRemaining: rateLimit ? rateLimit.remaining : null,
    rateLimitReset: rateLimit ? rateLimit.reset : null,
  }
}

function failure(error) {
  const code = error instanceof AuthError || error instanceof GitHubApiError
    ? error.code
    : (error && error.code) || 'E_INTERNAL'
  return envelope({ ok: false, code, text: (error && error.message) || String(error) })
}

function inputError(message) {
  const e = new Error(message)
  e.code = 'E_INPUT'
  return e
}

function respond(response, summarize) {
  const summary = summarize(response.json) || {}
  if (!response.ok) {
    const msg = response.json && response.json.message ? response.json.message : response.text.slice(0, 400)
    return envelope({
      ok: false,
      code: response.status === 403 || response.status === 429 ? 'E_RATE_LIMIT' : 'E_GITHUB',
      text: `GitHub HTTP ${response.status}: ${msg}`,
      data: response.json,
      status: response.status,
      rateLimit: response.rateLimit,
    })
  }
  return envelope({
    ok: true,
    code: 'OK',
    text: summary.text || `OK (HTTP ${response.status})`,
    data: summary.data !== undefined ? summary.data : response.json,
    status: response.status,
    rateLimit: response.rateLimit,
  })
}

function buildTools({ defineTool, store, states, fetchImpl = fetch, port = () => 0, publicUrl = '', cache = null }) {
  async function client() {
    const accessToken = await requireAccessToken(store, { fetchImpl })
    return new GitHubApi({ accessToken, fetchImpl, cache, cacheTtlMs: 5000 })
  }

  function resolveRepo(repo) {
    if (typeof repo === 'string' && repo.trim() !== '') return repo.trim()
    const fallback = store.preferences().defaultRepo
    if (fallback !== '') return fallback
    throw inputError('no repository given and no default repository configured')
  }

  function callbackBase(override) {
    const base = (override && override.trim() !== '' ? override : publicUrl).replace(/\/+$/, '')
    if (base !== '') return base
    return `http://127.0.0.1:${port() || 3080}`
  }

  const tools = []
  /**
   * Translate a raw JSON Schema object (as authored above) into the plain
   * property map that defineTool expects, keeping `required` on each field.
   */
  function toParameterSpec(schema) {
    if (schema === null || typeof schema !== 'object' || schema.properties === undefined) return {}
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    const spec = {}
    for (const [key, value] of Object.entries(schema.properties)) {
      const field = { ...value }
      delete field.required
      if (required.has(key)) field.required = true
      spec[key] = field
    }
    return spec
  }

  const add = (definition) => {
    tools.push(defineTool({
      ...definition,
      parameters: toParameterSpec(definition.parameters),
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => [{ type: 'text', text: value.text }] },
    }))
  }

  // ---- auth & accounts -----------------------------------------------------
  add({
    name: 'gh_auth_status',
    description: 'Show GitHub connection status: configured OAuth App, connected accounts, granted scopes, active login, and encrypted vault path. Never returns tokens or the client secret.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const status = store.status()
      const lines = [
        `OAuth App: ${status.configured ? `configured (${status.clientIdMasked}, ${status.oauthAppMode})` : 'not configured'}`,
        `Connected: ${status.connected ? status.activeLogin : 'no'}`,
        `Accounts: ${status.accounts.length}`,
        `Scope: ${DEFAULT_SCOPE}`,
        status.decryptError ? `Vault error: ${status.decryptError}` : `Vault: ${status.vault.path}`,
      ]
      return envelope({ ok: true, code: status.connected ? 'OK' : 'NOT_CONNECTED', text: lines.join('\n'), data: status })
    },
  })

  add({
    name: 'gh_auth_start',
    description: 'Create a one-time OAuth state and return the GitHub authorization URL with full-permission scopes (repo, delete_repo, workflow, admin:public_key, gists, org, notifications). Open the URL in a browser; GitHub redirects back to the plugin callback, which exchanges the code and stores the encrypted token. The state expires after 10 minutes and is single use.',
    parameters: {
      type: 'object',
      properties: {
        publicUrl: { type: 'string', description: 'Origin the browser reaches DSH at, e.g. http://192.168.1.10:3080. Defaults to http://127.0.0.1:<port>.' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        if (!store.isConfigured()) {
          const env = defaultCredentials()
          if (!env.complete) {
            throw Object.assign(new Error(
              'GitHub OAuth App is not configured. Register one at https://github.com/settings/developers ' +
              'with callback <DSH origin>/plugins/github-oauth/callback, then call gh_auth_setup({clientId, clientSecret}) ' +
              'or set GITHUB_MANAGER_CLIENT_ID / GITHUB_MANAGER_CLIENT_SECRET.',
            ), { code: 'E_NOT_CONFIGURED' })
          }
          store.configure({ clientId: env.clientId, clientSecret: env.clientSecret })
        }
        const creds = store.credentials()
        const redirectUri = `${callbackBase(args.publicUrl)}${CALLBACK_PATH}`
        const pending = states.create({ redirectUri, scope: DEFAULT_SCOPE, browserBound: false })
        const authorizeUrl = buildAuthorizeUrl({ clientId: creds.clientId, redirectUri, state: pending.state, scope: DEFAULT_SCOPE })
        return envelope({
          ok: true,
          code: 'OK',
          text: `Open in browser to authorize GitHub (10 min, single use):\n${authorizeUrl}\n\nCallback: ${redirectUri}\nAfter approval, call gh_auth_status.`,
          data: { authorizeUrl, redirectUri, scope: DEFAULT_SCOPE, expiresAt: new Date(pending.expiresAt).toISOString() },
        })
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_auth_setup',
    description: 'Set the GitHub OAuth App used for the authorization-code flow. This package ships no credentials: register an app at https://github.com/settings/developers with callback URL <DSH origin>/plugins/github-oauth/callback, then pass clientId + clientSecret (stored AES-256-GCM encrypted) or rely on the GITHUB_MANAGER_CLIENT_ID / GITHUB_MANAGER_CLIENT_SECRET environment variables. Call with no arguments to read the current setting.',
    parameters: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'OAuth App client id' },
        clientSecret: { type: 'string', description: 'OAuth App client secret; may be omitted when GITHUB_MANAGER_CLIENT_SECRET is set' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const hasArgs = typeof args.clientId === 'string' && args.clientId.trim() !== ''
        if (!hasArgs) {
          const status = store.status()
          return envelope({
            ok: true,
            code: status.configured ? 'OK' : 'E_NOT_CONFIGURED',
            text: status.configured
              ? `OAuth App: ${status.clientIdMasked} (${status.oauthAppMode})`
              : 'No OAuth App configured. Register one and call gh_auth_setup({clientId, clientSecret}).',
            data: { configured: status.configured, clientIdMasked: status.clientIdMasked, mode: status.oauthAppMode },
          })
        }
        store.configure({ clientId: args.clientId, clientSecret: args.clientSecret || '' })
        const status = store.status()
        return envelope({ ok: true, code: 'OK', text: `OAuth App saved: ${status.clientIdMasked} (${status.oauthAppMode})`, data: { clientIdMasked: status.clientIdMasked } })
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_auth_logout',
    description: 'Forget every stored GitHub account and access token. The encrypted OAuth App client id/secret stay configured. To drop a single account, use gh_account_remove.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      store.clearToken()
      return envelope({ ok: true, code: 'OK', text: 'All GitHub accounts and tokens removed.' })
    },
  })

  add({
    name: 'gh_accounts',
    description: 'List every GitHub account connected to this encrypted vault and show which one is active. Each entry reports login, display name, avatar URL, granted scopes, token expiry and whether it can refresh; the access token itself is never returned. Change the active account with gh_account_switch.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const accounts = store.accounts()
      const active = store.activeLogin()
      const text = accounts.length === 0
        ? 'No accounts connected.'
        : accounts.map((a) => `${a.login === active ? '* ' : '  '}${a.login} · scopes ${a.scopes.join(', ') || '(none)'}`).join('\n')
      return envelope({ ok: true, code: 'OK', text, data: { accounts, activeLogin: active } })
    },
  })

  add({
    name: 'gh_account_switch',
    description: "Switch the active GitHub account. Every later gh_* call uses the selected account's token, so this changes who reads and writes. Use gh_accounts to see the saved logins.",
    parameters: {
      type: 'object',
      required: ['login'],
      properties: { login: { type: 'string', description: 'Exact GitHub login of a stored account' } },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const status = store.switchAccount(String(args.login || ''))
        return envelope({ ok: true, code: 'OK', text: `Active account: ${status.activeLogin}`, data: { activeLogin: status.activeLogin } })
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_account_remove',
    description: 'Forget one stored GitHub account and its encrypted token. Removing the active account promotes the next saved account; the OAuth App credentials and every other account stay untouched.',
    parameters: {
      type: 'object',
      required: ['login'],
      properties: { login: { type: 'string', description: 'Exact GitHub login of the account to forget' } },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const status = store.removeAccount(String(args.login || ''))
        return envelope({ ok: true, code: 'OK', text: `Removed ${args.login}. Active: ${status.activeLogin || '(none)'}`, data: { activeLogin: status.activeLogin } })
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_preferences',
    description: 'Read or update the GitHub preferences kept in the encrypted vault: default repository and pinned repositories. Call with no arguments to read; pass defaultRepo:"" to clear, or pinnedRepos [] to clear pins.',
    parameters: {
      type: 'object',
      properties: {
        defaultRepo: { type: 'string' },
        pinnedRepos: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const patch = {}
      if (args.defaultRepo !== undefined) patch.defaultRepo = String(args.defaultRepo)
      if (args.pinnedRepos !== undefined) patch.pinnedRepos = args.pinnedRepos.map(String)
      const prefs = Object.keys(patch).length === 0 ? store.preferences() : store.setPreferences(patch)
      return envelope({ ok: true, code: 'OK', text: bounded(prefs), data: prefs })
    },
  })

  // ---- universal REST ------------------------------------------------------
  add({
    name: 'gh_api',
    description: 'Call any GitHub REST API endpoint with the stored token, e.g. GET /user or POST /repos/owner/name/issues. path is the API path only (no host), and query/body are JSON values. Non-2xx responses are returned with ok:false instead of throwing.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'], description: 'HTTP method, defaults to GET' },
        path: { type: 'string', description: 'Absolute API path such as /repos/octocat/Hello-World' },
        query: { type: 'json', description: 'Query string parameters as a JSON object' },
        body: { type: 'json', description: 'JSON request body (POST/PATCH/PUT)' },
        maxChars: { type: 'integer', description: 'Response text budget in characters, default 20000' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET'
        const api = await client()
        const response = await api.request(method, String(args.path), { query: args.query, body: args.body })
        const max = Math.min(MAX_TEXT, Math.max(1000, Number(args.maxChars) || 20000))
        const payload = response.json === null ? response.text : response.json
        return respond(response, () => ({
          text: `${method} ${args.path} → HTTP ${response.status}\n${bounded(payload, max)}`,
          data: { status: response.status, body: payload },
        }))
      } catch (error) { return failure(error) }
    },
  })

  // ---- repos ---------------------------------------------------------------
  add({
    name: 'gh_repo',
    description: 'Fetch metadata for one repository: description, stars, language, default branch, topics and URLs. Omit repo to use the default repository.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name form; omit to use the default repository' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const response = await api.get(`/repos/${fullName}`)
        return respond(response, (j) => ({
          text: `${j.full_name || fullName} · ★ ${j.stargazers_count || 0} · ${j.language || 'n/a'} · default ${j.default_branch || '?'}\n${j.description || ''}\n${j.html_url || ''}`,
          data: {
            fullName: j.full_name, description: j.description, stars: j.stargazers_count,
            language: j.language, defaultBranch: j.default_branch, topics: j.topics,
            htmlUrl: j.html_url, cloneUrl: j.clone_url, private: j.private,
          },
        }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_repo_create',
    description: 'Create a new repository under the authenticated user or a specified organization. private defaults to false. autoInit adds an initial README commit. Requires the create-repo scope.',
    parameters: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        autoInit: { type: 'boolean', description: 'Create an initial README commit' },
        org: { type: 'string', description: 'Organization owner; omit to create under the authenticated user' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const name = String(args.name || '').trim()
        if (name === '') throw inputError('name is required')
        const payload = {
          name,
          description: typeof args.description === 'string' ? args.description : '',
          private: args.private === true,
          auto_init: args.autoInit === true,
        }
        const api = await client()
        const path = typeof args.org === 'string' && args.org.trim() !== ''
          ? `/orgs/${args.org.trim()}/repos`
          : '/user/repos'
        const response = await api.post(path, payload)
        return respond(response, (j) => ({
          text: `Created ${j.full_name || name}${j.html_url ? `\n${j.html_url}` : ''}`,
          data: { fullName: j.full_name, htmlUrl: j.html_url, private: j.private, cloneUrl: j.clone_url },
        }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_repo_delete',
    description: 'Delete a repository permanently. This is destructive and cannot be undone. The token must carry the delete_repo scope. Pass confirm:"DELETE" to proceed; any other value is refused.',
    parameters: {
      type: 'object',
      required: ['repo', 'confirm'],
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name form' },
        confirm: { type: 'string', description: 'Must be exactly DELETE to proceed' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        if (args.confirm !== 'DELETE') throw inputError('pass confirm:"DELETE" to delete a repository')
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const response = await api.delete(`/repos/${fullName}`)
        return respond(response, () => ({ text: `Deleted ${fullName}`, data: { repo: fullName, deleted: response.status === 204 } }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_repos',
    description: 'List repositories visible to the authenticated user. Defaults to repositories the user owns, sorted by recently updated.',
    parameters: {
      type: 'object',
      properties: {
        affiliation: { type: 'string', description: 'owner, collaborator, organization_member, or comma-separated combination' },
        sort: { type: 'string', enum: ['created', 'updated', 'pushed', 'full_name'], description: 'Sort field' },
        perPage: { type: 'integer', description: 'Results per page, max 100' },
        query: { type: 'json', description: 'Additional raw query parameters' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const api = await client()
        const query = Object.assign({
          per_page: Math.min(100, Number(args.perPage) || 30),
          sort: args.sort || 'updated',
          affiliation: args.affiliation || 'owner',
        }, args.query && typeof args.query === 'object' ? args.query : {})
        const response = await api.get('/user/repos', { query })
        return respond(response, (j) => ({
          text: Array.isArray(j) ? j.map((r) => `${r.full_name}${r.private ? ' [private]' : ''}`).join('\n') || '(none)' : '(none)',
          data: Array.isArray(j) ? j.map((r) => ({ fullName: r.full_name, private: r.private, htmlUrl: r.html_url })) : [],
        }))
      } catch (error) { return failure(error) }
    },
  })

  // ---- files ---------------------------------------------------------------
  add({
    name: 'gh_file',
    description: 'Read one file or list one directory from a repository through the contents API. File text is decoded from base64 and truncated to maxChars; binary files report their size instead of the bytes.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name form; omit to use the default repository' },
        path: { type: 'string', description: 'Repository-relative path, e.g. src/index.ts' },
        ref: { type: 'string', description: 'Branch, tag or commit SHA; defaults to the default branch' },
        maxChars: { type: 'integer', description: 'Text budget for file content, default 40000' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const filePath = String(args.path || '').replace(/^\/+/, '')
        const api = await client()
        const query = {}
        if (args.ref) query.ref = args.ref
        const response = await api.get(`/repos/${fullName}/contents/${encodeURI(filePath)}`, { query })
        const max = Math.min(MAX_TEXT, Math.max(1000, Number(args.maxChars) || 40000))
        return respond(response, (j) => {
          if (Array.isArray(j)) {
            return {
              text: j.map((e) => `${e.type === 'dir' ? 'd' : 'f'} ${e.path}`).join('\n') || '(empty)',
              data: j.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })),
            }
          }
          const binary = j.encoding !== 'base64'
          let content = ''
          if (!binary) {
            try { content = Buffer.from(String(j.content || '').replace(/\s+/g, ''), 'base64').toString('utf8') } catch {}
          }
          const truncated = content.length > max
          if (truncated) content = content.slice(0, max)
          return {
            text: binary
              ? `${fullName}/${j.path} is binary (${j.size} B). ${j.html_url || ''}`
              : `${fullName}/${j.path} (${j.size} B)\n${j.html_url || ''}\n\n${content}${truncated ? '\n…(truncated)' : ''}`,
            data: { path: j.path, size: j.size, sha: j.sha, htmlUrl: j.html_url, content: binary ? '' : content, truncated },
          }
        })
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_file_write',
    description: 'Create or update a file in a repository via the contents API. If sha is omitted the file is created (and fails if it exists); pass the current blob sha to update. Requires a commit message.',
    parameters: {
      type: 'object',
      required: ['path', 'content', 'message'],
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name form; omit to use the default repository' },
        path: { type: 'string', description: 'Repository-relative file path' },
        content: { type: 'string', description: 'New file contents (plain text)' },
        message: { type: 'string', description: 'Commit message' },
        branch: { type: 'string', description: 'Branch to commit to; defaults to the default branch' },
        sha: { type: 'string', description: 'Current blob sha when updating an existing file' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const payload = {
          message: String(args.message || '').trim() || 'update via dsh-github-manager',
          content: Buffer.from(String(args.content || ''), 'utf8').toString('base64'),
        }
        if (args.branch) payload.branch = String(args.branch)
        if (args.sha) payload.sha = String(args.sha)
        const response = await api.put(`/repos/${fullName}/contents/${encodeURI(String(args.path || '').replace(/^\/+/, ''))}`, payload)
        return respond(response, (j) => ({
          text: `Wrote ${fullName}/${args.path}\n${j.commit && j.commit.html_url ? j.commit.html_url : ''}`,
          data: { path: j.content && j.content.path, sha: j.content && j.content.sha, commitUrl: j.commit && j.commit.html_url },
        }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_file_delete',
    description: 'Delete a file from a repository via the contents API. Requires the current blob sha and a commit message.',
    parameters: {
      type: 'object',
      required: ['path', 'sha', 'message'],
      properties: {
        repo: { type: 'string' },
        path: { type: 'string', description: 'Repository-relative file path' },
        sha: { type: 'string', description: 'Current blob sha of the file' },
        message: { type: 'string', description: 'Commit message' },
        branch: { type: 'string' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const payload = { message: String(args.message || '').trim() || 'delete via dsh-github-manager', sha: String(args.sha) }
        if (args.branch) payload.branch = String(args.branch)
        const response = await api.request('DELETE', `/repos/${fullName}/contents/${encodeURI(String(args.path || '').replace(/^\/+/, ''))}`, { body: payload })
        return respond(response, (j) => ({ text: `Deleted ${fullName}/${args.path}`, data: { path: args.path, commitUrl: j.commit && j.commit.html_url } }))
      } catch (error) { return failure(error) }
    },
  })

  // ---- push local files ----------------------------------------------------
  add({
    name: 'gh_push',
    description:
      'Push local files to a repository branch through the Git Data API — no git binary, no clone, no token setup beyond the OAuth login. ' +
      'Only files whose content differs from the remote are uploaded, secrets (.env, private keys, vaults, GitHub tokens) are blocked, and the ' +
      'branch is created when it does not exist. Use this instead of git push: on a phone the git TLS handshake often stalls and a push uploads ' +
      'far more than necessary. Returns the commit sha, the changed paths and anything skipped.',
    parameters: {
      type: 'object',
      required: ['repo', 'dir', 'message'],
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name form' },
        dir: { type: 'string', description: 'Absolute local directory to publish' },
        message: { type: 'string', description: 'Commit message' },
        branch: { type: 'string', description: 'Target branch; created when missing. Defaults to main' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths to leave out' },
        deletePaths: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths to delete in the same commit' },
        force: { type: 'boolean', description: 'Overwrite the branch even when the remote moved ahead' },
        dryRun: { type: 'boolean', description: 'Report what would change without uploading' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const dir = String(args.dir || '')
        if (dir === '') throw inputError('dir is required')
        const collected = collectFiles(dir, { exclude: args.exclude })
        const api = await client()
        const report = await pushFiles({
          api,
          repo: String(args.repo || ''),
          branch: typeof args.branch === 'string' && args.branch !== '' ? args.branch : 'main',
          files: collected.files,
          message: String(args.message || ''),
          force: args.force === true,
          deletePaths: Array.isArray(args.deletePaths) ? args.deletePaths.map(String) : [],
          dryRun: args.dryRun === true,
        })
        const blocked = collected.skipped.filter((s) => s.reason.startsWith('blocked:'))
        const lines = []
        if (report.noop) {
          lines.push(`没有变化：${report.repo}@${report.branch} 已是最新（比对 ${collected.files.length} 个文件）`)
        } else if (report.dryRun) {
          lines.push(`预演：将向 ${report.repo}@${report.branch} 提交 ${report.changed.length} 个文件`)
          lines.push(report.changed.slice(0, 20).join('\n'))
        } else {
          lines.push(`${report.created ? '已创建分支' : '已提交'} ${report.repo}@${report.branch}`)
          lines.push(`commit ${report.commit.slice(0, 10)} · 变更 ${report.changed.length} · 未变 ${report.unchanged}${report.deleted.length > 0 ? ` · 删除 ${report.deleted.length}` : ''}`)
          if (report.commitUrl) lines.push(report.commitUrl)
        }
        if (blocked.length > 0) {
          lines.push(`已拦截 ${blocked.length} 个疑似凭据文件：${blocked.map((b) => b.path).join(', ')}`)
        }
        return envelope({ ok: true, code: 'OK', text: lines.join('\n'), data: { ...report, blocked, skipped: collected.skipped } })
      } catch (error) { return failure(error) }
    },
  })

  // ---- branches / commits --------------------------------------------------
  add({
    name: 'gh_branch_list',
    description: 'List branches of a repository with their commit sha.',
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string' }, perPage: { type: 'integer' } },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const response = await api.get(`/repos/${fullName}/branches`, { query: { per_page: Math.min(100, Number(args.perPage) || 30) } })
        return respond(response, (j) => ({
          text: Array.isArray(j) ? j.map((b) => `${b.name} ${b.commit && b.commit.sha ? b.commit.sha.slice(0, 8) : ''}`).join('\n') : '(none)',
          data: Array.isArray(j) ? j.map((b) => ({ name: b.name, sha: b.commit && b.commit.sha, protected: b.protected })) : [],
        }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_commit_list',
    description: 'List recent commits of a repository or a specific branch.',
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string' }, sha: { type: 'string', description: 'Branch or commit sha' }, perPage: { type: 'integer' } },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const query = { per_page: Math.min(100, Number(args.perPage) || 20) }
        if (args.sha) query.sha = args.sha
        const response = await api.get(`/repos/${fullName}/commits`, { query })
        return respond(response, (j) => ({
          text: Array.isArray(j) ? j.map((c) => `${(c.sha || '').slice(0, 8)} ${String(c.commit && c.commit.message || '').split('\n')[0]}`).join('\n') : '(none)',
          data: Array.isArray(j) ? j.map((c) => ({ sha: c.sha, message: c.commit && c.commit.message, author: c.author && c.author.login })) : [],
        }))
      } catch (error) { return failure(error) }
    },
  })

  // ---- issues / PRs --------------------------------------------------------
  add({
    name: 'gh_issues',
    description: 'List issues of a repository (pull requests are filtered out). Supports state, label filtering and a limit. Omit repo to use the default repository.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        labels: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', description: 'Maximum issues to return, 1-100' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const response = await api.get(`/repos/${fullName}/issues`, {
          query: { state: args.state || 'open', labels: args.labels || [], per_page: Math.min(100, Number(args.limit) || 20) },
        })
        return respond(response, (j) => {
          const issues = Array.isArray(j) ? j.filter((i) => i.pull_request === undefined) : []
          return {
            text: issues.map((i) => `#${i.number} ${i.title}`).join('\n') || '(none)',
            data: issues.map((i) => ({ number: i.number, title: i.title, state: i.state, labels: (i.labels || []).map((l) => l.name), htmlUrl: i.html_url })),
          }
        })
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_issue_create',
    description: 'Create an issue in a repository. Requires the token to carry repository write permission. Omit repo to use the default repository.',
    parameters: {
      type: 'object',
      required: ['title'],
      properties: {
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const response = await api.post(`/repos/${fullName}/issues`, {
          title: String(args.title || ''), body: typeof args.body === 'string' ? args.body : '', labels: args.labels || [],
        })
        return respond(response, (j) => ({ text: `Created issue #${j.number}: ${j.title}\n${j.html_url || ''}`, data: { number: j.number, htmlUrl: j.html_url } }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_pulls',
    description: 'List pull requests of a repository with review/merge state and head/base branches. Omit repo to use the default repository.',
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] }, limit: { type: 'integer' } },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const response = await api.get(`/repos/${fullName}/pulls`, { query: { state: args.state || 'open', per_page: Math.min(100, Number(args.limit) || 20) } })
        return respond(response, (j) => ({
          text: Array.isArray(j) ? j.map((p) => `#${p.number} ${p.title} [${p.head && p.head.ref} → ${p.base && p.base.ref}]`).join('\n') : '(none)',
          data: Array.isArray(j) ? j.map((p) => ({ number: p.number, title: p.title, state: p.state, head: p.head && p.head.ref, base: p.base && p.base.ref, htmlUrl: p.html_url })) : [],
        }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_pr_create',
    description: 'Create a pull request. head is the branch containing changes, base is the branch to merge into. Requires repository write permission.',
    parameters: {
      type: 'object',
      required: ['title', 'head', 'base'],
      properties: {
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string', description: 'Branch containing the changes' },
        base: { type: 'string', description: 'Branch to merge into' },
        body: { type: 'string' },
        draft: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const response = await api.post(`/repos/${fullName}/pulls`, {
          title: String(args.title || ''), head: String(args.head || ''), base: String(args.base || ''),
          body: typeof args.body === 'string' ? args.body : '', draft: args.draft === true,
        })
        return respond(response, (j) => ({ text: `Created PR #${j.number}: ${j.title}\n${j.html_url || ''}`, data: { number: j.number, htmlUrl: j.html_url } }))
      } catch (error) { return failure(error) }
    },
  })

  // ---- keys / secrets / workflow -------------------------------------------
  // Account-level SSH keys: created with the OAuth token itself, no gh CLI and
  // no separate PAT required. The token only needs admin:public_key (in scope).
  add({
    name: 'gh_my_key_list',
    description: 'List SSH keys on the authenticated account. Returns id, title, fingerprint and age; the private key is never stored or returned.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      try {
        const api = await client()
        const response = await api.get('/user/keys')
        return respond(response, (j) => ({
          text: Array.isArray(j) ? j.map((k) => `#${k.id} ${k.title} ${k.fingerprint || ''}`).join('\n') || '(none)' : '(none)',
          data: Array.isArray(j) ? j.map((k) => ({ id: k.id, title: k.title, key: k.key, fingerprint: k.fingerprint, verified: k.verified, createdAt: k.created_at })) : [],
        }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_my_key_add',
    description: 'Add an SSH public key to the authenticated account using the full-permission OAuth token (no gh CLI, no separate PAT). Pass the public key (ssh-ed25519 / ssh-rsa / ecdsa-sha2-nistp256).',
    parameters: {
      type: 'object',
      required: ['title', 'key'],
      properties: {
        title: { type: 'string', description: 'Label for the key' },
        key: { type: 'string', description: 'SSH public key string' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const api = await client()
        const response = await api.post('/user/keys', { title: String(args.title || ''), key: String(args.key || '').trim() })
        return respond(response, (j) => ({
          text: `Added account SSH key #${j.id}: ${j.title}${j.fingerprint ? ` (${j.fingerprint})` : ''}`,
          data: { id: j.id, title: j.title, fingerprint: j.fingerprint, htmlUrl: j.html_url },
        }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_my_key_remove',
    description: 'Remove an SSH public key from the authenticated account by numeric id.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'integer', description: 'Numeric key id from gh_my_key_list' } },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const api = await client()
        const response = await api.delete(`/user/keys/${Number(args.id)}`)
        return respond(response, () => ({ text: `Removed account SSH key ${args.id}`, data: { id: args.id } }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_gpg_key_list',
    description: 'List GPG keys on the authenticated account with id, key id and email.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      try {
        const api = await client()
        const response = await api.get('/user/gpg_keys')
        return respond(response, (j) => ({
          text: Array.isArray(j) ? j.map((k) => `#${k.id} ${k.key_id} ${k.email || ''}`).join('\n') || '(none)' : '(none)',
          data: Array.isArray(j) ? j.map((k) => ({ id: k.id, keyId: k.key_id, primaryKeyId: k.primary_key_id, email: k.email, verified: k.verified })) : [],
        }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_gpg_key_add',
    description: 'Add an ASCII-armored GPG public key to the authenticated account using the full-permission OAuth token.',
    parameters: {
      type: 'object',
      required: ['armoredKey'],
      properties: { armoredKey: { type: 'string', description: 'ASCII-armored GPG public key block' } },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const api = await client()
        const response = await api.post('/user/gpg_keys', { armored_key: String(args.armoredKey || '') })
        return respond(response, (j) => ({
          text: `Added GPG key #${j.id} ${j.key_id || ''}`,
          data: { id: j.id, keyId: j.key_id, fingerprint: j.fingerprint, htmlUrl: j.html_url },
        }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_gpg_key_remove',
    description: 'Remove a GPG key from the authenticated account by numeric id.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'integer' } },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const api = await client()
        const response = await api.delete(`/user/gpg_keys/${Number(args.id)}`)
        return respond(response, () => ({ text: `Removed GPG key ${args.id}`, data: { id: args.id } }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_key_list',
    description: 'List deploy keys of a repository.',
    parameters: { type: 'object', properties: { repo: { type: 'string' } }, additionalProperties: false },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const response = await api.get(`/repos/${fullName}/keys`)
        return respond(response, (j) => ({
          text: Array.isArray(j) ? j.map((k) => `#${k.id} ${k.title} (${k.key_type || 'ssh'})`).join('\n') || '(none)' : '(none)',
          data: Array.isArray(j) ? j.map((k) => ({ id: k.id, title: k.title, keyType: k.key_type, readOnly: k.read_only, verified: k.verified })) : [],
        }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_key_add',
    description: 'Add a deploy key to a repository. Pass the public SSH key (ssh-ed25519 or ssh-rsa). readOnly defaults to true.',
    parameters: {
      type: 'object',
      required: ['repo', 'title', 'key'],
      properties: {
        repo: { type: 'string' },
        title: { type: 'string' },
        key: { type: 'string', description: 'Public SSH key' },
        readOnly: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const response = await api.post(`/repos/${fullName}/keys`, {
          title: String(args.title || ''), key: String(args.key || ''), read_only: args.readOnly !== false,
        })
        return respond(response, (j) => ({ text: `Added deploy key #${j.id}: ${j.title}`, data: { id: j.id, title: j.title, verified: j.verified } }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_key_remove',
    description: 'Remove a deploy key from a repository by its numeric id.',
    parameters: {
      type: 'object',
      required: ['repo', 'id'],
      properties: { repo: { type: 'string' }, id: { type: 'integer' } },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const response = await api.delete(`/repos/${fullName}/keys/${Number(args.id)}`)
        return respond(response, () => ({ text: `Removed deploy key ${args.id}`, data: { id: args.id } }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_secret_list',
    description: 'List GitHub Actions secrets metadata for a repository (names and update times only; values are never returned).',
    parameters: { type: 'object', properties: { repo: { type: 'string' } }, additionalProperties: false },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const response = await api.get(`/repos/${fullName}/actions/secrets`)
        return respond(response, (j) => ({
          text: j && Array.isArray(j.secrets) ? j.secrets.map((s) => `${s.name} (updated ${s.updated_at})`).join('\n') || '(none)' : '(none)',
          data: j && Array.isArray(j.secrets) ? j.secrets.map((s) => ({ name: s.name, updatedAt: s.updated_at, createdAt: s.created_at })) : [],
        }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_secret_put',
    description: 'Create or update a GitHub Actions secret for a repository. The value is encrypted with the repository public key before sending; use gh_secret_public_key first or let this tool fetch it. Values are never echoed back.',
    parameters: {
      type: 'object',
      required: ['repo', 'name', 'value'],
      properties: {
        repo: { type: 'string' },
        name: { type: 'string', description: 'Secret name' },
        value: { type: 'string', description: 'Secret value' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const pub = await api.get(`/repos/${fullName}/actions/secrets/public-key`)
        if (!pub.ok || !pub.json || !pub.json.key || !pub.json.key_id) {
          throw new Error(`cannot read public key: ${pub.text.slice(0, 200)}`)
        }
        const { encryptSecret } = require('./secrets')
        const encrypted = encryptSecret(String(args.value), pub.json.key)
        const response = await api.put(`/repos/${fullName}/actions/secrets/${encodeURIComponent(String(args.name))}`, {
          encrypted_value: encrypted, key_id: pub.json.key_id,
        })
        return respond(response, () => ({ text: `Secret ${args.name} saved (HTTP ${response.status})`, data: { name: args.name, status: response.status } }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_secret_delete',
    description: 'Delete a GitHub Actions secret from a repository.',
    parameters: {
      type: 'object',
      required: ['repo', 'name'],
      properties: { repo: { type: 'string' }, name: { type: 'string' } },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const response = await api.delete(`/repos/${fullName}/actions/secrets/${encodeURIComponent(String(args.name))}`)
        return respond(response, () => ({ text: `Deleted secret ${args.name}`, data: { name: args.name } }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_workflow_list',
    description: 'List GitHub Actions workflows of a repository.',
    parameters: { type: 'object', properties: { repo: { type: 'string' } }, additionalProperties: false },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const response = await api.get(`/repos/${fullName}/actions/workflows`)
        return respond(response, (j) => ({
          text: j && Array.isArray(j.workflows) ? j.workflows.map((w) => `${w.id} ${w.name} (${w.state})`).join('\n') || '(none)' : '(none)',
          data: j && Array.isArray(j.workflows) ? j.workflows.map((w) => ({ id: w.id, name: w.name, state: w.state, path: w.path })) : [],
        }))
      } catch (error) { return failure(error) }
    },
  })

  add({
    name: 'gh_workflow_run',
    description: 'Trigger a GitHub Actions workflow via workflow_dispatch. Pass workflow file name or id, and optional ref and inputs.',
    parameters: {
      type: 'object',
      required: ['repo', 'workflow'],
      properties: {
        repo: { type: 'string' },
        workflow: { type: 'string', description: 'Workflow file name (e.g. ci.yml) or numeric id' },
        ref: { type: 'string', description: 'Branch or tag to run on; defaults to the default branch' },
        inputs: { type: 'json', description: 'Workflow inputs as a JSON object' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const fullName = resolveRepo(args.repo)
        const api = await client()
        const ref = typeof args.ref === 'string' && args.ref !== '' ? args.ref : (await api.get(`/repos/${fullName}`)).json.default_branch
        const response = await api.post(`/repos/${fullName}/actions/workflows/${encodeURIComponent(String(args.workflow))}/dispatches`, {
          ref, inputs: args.inputs && typeof args.inputs === 'object' ? args.inputs : {},
        })
        return respond(response, () => ({ text: `Workflow ${args.workflow} dispatched on ${ref} (HTTP ${response.status})`, data: { workflow: args.workflow, ref, status: response.status } }))
      } catch (error) { return failure(error) }
    },
  })

  // ---- search --------------------------------------------------------------
  add({
    name: 'gh_search',
    description: 'Search GitHub repositories, issues/PRs, code or users. Uses the GitHub search API with its own rate limits.',
    parameters: {
      type: 'object',
      required: ['q'],
      properties: {
        q: { type: 'string', description: 'Search query, GitHub syntax such as "repo:owner/name is:open label:bug"' },
        type: { type: 'string', enum: ['repositories', 'issues', 'code', 'users'] },
        limit: { type: 'integer', description: 'Maximum results, 1-100' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const api = await client()
        const type = args.type || 'repositories'
        const response = await api.get(`/search/${type}`, { query: { q: String(args.q || ''), per_page: Math.min(100, Number(args.limit) || 20) } })
        return respond(response, (j) => ({
          text: `Found ${j.total_count || 0} results`,
          data: { totalCount: j.total_count, items: (j.items || []).slice(0, 30).map((i) => ({ title: i.full_name || i.title || i.login, htmlUrl: i.html_url, description: i.description })) },
        }))
      } catch (error) { return failure(error) }
    },
  })

  return tools
}

module.exports = { buildTools, OUTPUT_SCHEMA }
