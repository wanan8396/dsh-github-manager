'use strict'

/**
 * GitHub OAuth web-application flow and token exchange.
 *
 * The callback URL is the one registered on the built-in OAuth App, so it must
 * stay exactly `/plugins/github-oauth/callback` even though the package is now
 * named @local/github-manager.
 */

const AUTHORIZE_ENDPOINT = 'https://github.com/login/oauth/authorize'
const ACCESS_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token'
const API_BASE = 'https://api.github.com'
const USER_AGENT = 'dsh-github-manager/2.0.0'

// Full-permission scope: code/issue/PR read-write, repo create & delete,
// workflow files, deploy keys & hooks, gists, org read, notifications.
const DEFAULT_SCOPE = [
  'repo',
  'repo:status',
  'repo_deployment',
  'public_repo',
  'delete_repo',
  'workflow',
  'admin:public_key',
  'admin:repo_hook',
  'gist',
  'read:org',
  'read:user',
  'user:email',
  'notifications',
].join(' ')

const CALLBACK_PATH = '/plugins/github-oauth/callback'

class OAuthError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'OAuthError'
    this.code = options.code || 'E_OAUTH'
    this.status = Number.isInteger(options.status) ? options.status : 0
  }
}

function parseScopes(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value !== 'string' || value.trim() === '') return []
  return value.split(/[\s,]+/).filter(Boolean)
}

function buildAuthorizeUrl({ clientId, redirectUri, state, scope = DEFAULT_SCOPE }) {
  const url = new URL(AUTHORIZE_ENDPOINT)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('scope', scope)
  url.searchParams.set('allow_signup', 'true')
  return url.toString()
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl = fetch }) {
  const response = await fetchImpl(ACCESS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  })
  const body = await response.text()
  let json = null
  try { json = JSON.parse(body) } catch {}
  if (json && json.error) {
    throw new OAuthError(`token exchange failed: ${json.error_description || json.error}`, { code: 'E_EXCHANGE', status: response.status })
  }
  const accessToken = json && (json.access_token || '')
  if (accessToken === '') {
    throw new OAuthError(`token exchange returned no access_token: ${body.slice(0, 300)}`, { code: 'E_EXCHANGE', status: response.status })
  }
  return {
    accessToken,
    refreshToken: (json && json.refresh_token) || '',
    tokenType: (json && json.token_type) || 'bearer',
    scope: (json && json.scope) || '',
    expiresIn: Number(json && json.expires_in) || 0,
    expiresAt: Number(json && json.expires_in) > 0 ? Date.now() + Number(json.expires_in) * 1000 : 0,
  }
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  const response = await fetchImpl(ACCESS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })
  const body = await response.text()
  let json = null
  try { json = JSON.parse(body) } catch {}
  if (json && json.error) {
    throw new OAuthError(`token refresh failed: ${json.error_description || json.error}`, { code: 'E_REFRESH', status: response.status })
  }
  return {
    accessToken: (json && json.access_token) || '',
    refreshToken: (json && json.refresh_token) || refreshToken,
    tokenType: (json && json.token_type) || 'bearer',
    scope: (json && json.scope) || '',
    expiresAt: Number(json && json.expires_in) > 0 ? Date.now() + Number(json.expires_in) * 1000 : 0,
  }
}

async function fetchAccount({ accessToken, fetchImpl = fetch }) {
  const response = await fetchImpl(`${API_BASE}/user`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
    },
  })
  const body = await response.text()
  let json = null
  try { json = JSON.parse(body) } catch {}
  if (!response.ok || json === null) {
    throw new OAuthError(`fetch account failed: HTTP ${response.status} ${body.slice(0, 200)}`, { status: response.status })
  }
  return {
    account: {
      login: json.login,
      id: Number(json.id) || 0,
      name: json.name || '',
      avatarUrl: json.avatar_url || '',
    },
    scopes: parseScopes(response.headers.get && response.headers.get('x-oauth-scopes')),
  }
}

module.exports = {
  API_BASE,
  USER_AGENT,
  CALLBACK_PATH,
  DEFAULT_SCOPE,
  OAuthError,
  parseScopes,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  fetchAccount,
}
