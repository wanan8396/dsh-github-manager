'use strict'

/** Authorization glue shared by the HTTP callback and the agent tools. */

const { exchangeCode, refreshAccessToken, fetchAccount, parseScopes } = require('./oauth')

const REFRESH_WINDOW_MS = 60 * 1000
const refreshing = new WeakMap()

class AuthError extends Error {
  constructor(message, code = 'E_AUTH') {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

async function completeAuthorization(store, { code, redirectUri, fetchImpl = fetch }) {
  const credentials = store.credentials()
  if (credentials.clientId === '' || credentials.clientSecret === '') {
    throw new AuthError('GitHub OAuth App credentials are not configured', 'E_NOT_CONFIGURED')
  }
  const token = await exchangeCode({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    code,
    redirectUri,
    fetchImpl,
  })
  const { account, scopes } = await fetchAccount({ accessToken: token.accessToken, fetchImpl })
  return store.setToken(token, account, scopes.length > 0 ? scopes : parseScopes(token.scope))
}

async function refreshOnce(store, token, { fetchImpl = fetch, login = '' } = {}) {
  const existing = refreshing.get(store)
  if (existing !== undefined) return existing
  const pending = (async () => {
    const credentials = store.credentials()
    if (credentials.clientId === '' || credentials.clientSecret === '') {
      throw new AuthError('cannot refresh token: OAuth App credentials are missing', 'E_NOT_CONFIGURED')
    }
    if (token.refreshToken === '') {
      throw new AuthError('the GitHub token has expired and no refresh token is stored; reconnect', 'E_TOKEN_EXPIRED')
    }
    const fresh = await refreshAccessToken({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      refreshToken: token.refreshToken,
      fetchImpl,
    })
    const owner = login || token.login
    store.updateToken(owner, {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      expiresAt: fresh.expiresAt,
      scopes: parseScopes(fresh.scope || token.scopes),
    })
    return { accessToken: fresh.accessToken, login: owner }
  })()
  refreshing.set(store, pending)
  try {
    return await pending
  } finally {
    refreshing.delete(store)
  }
}

async function requireAccessToken(store, { fetchImpl = fetch, now = Date.now } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = store.token()
    if (token === null) throw new AuthError('GitHub is not connected; run gh_auth_start and finish the browser flow', 'E_NOT_CONNECTED')
    const usable = token.accessToken !== '' && (token.expiresAt === 0 || token.expiresAt - now() >= REFRESH_WINDOW_MS)
    if (usable) return token.accessToken
    const inFlight = refreshing.get(store)
    if (inFlight !== undefined) {
      try { await inFlight } catch {}
      continue
    }
    await refreshOnce(store, token, { fetchImpl, login: store.activeLogin() })
  }
  const final = store.token()
  if (final !== null && final.accessToken !== '' && (final.expiresAt === 0 || final.expiresAt - now() >= REFRESH_WINDOW_MS)) {
    return final.accessToken
  }
  throw new AuthError('could not obtain a fresh GitHub token; reconnect with gh_auth_start', 'E_TOKEN_EXPIRED')
}

module.exports = { AuthError, completeAuthorization, refreshOnce, requireAccessToken }
