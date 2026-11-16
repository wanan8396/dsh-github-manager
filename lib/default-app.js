'use strict'

/**
 * OAuth App credentials.
 *
 * No credential ships with this package. Register your own OAuth App and give
 * the plugin its Client ID and Secret in one of two ways:
 *
 *   1. Environment (read at start-up, never written to disk):
 *        GITHUB_MANAGER_CLIENT_ID=...  GITHUB_MANAGER_CLIENT_SECRET=...
 *
 *   2. Settings → GitHub 管理 → 自定义 OAuth App, or
 *      `gh_auth_setup({ clientId, clientSecret })` — stored AES-256-GCM
 *      encrypted in $DSH_HOME/github-manager/vault.json.
 *
 * The callback URL to register on the app is
 *   <your DSH origin>/plugins/github-oauth/callback
 */

function envCredentials(env = process.env) {
  const id = typeof env.GITHUB_MANAGER_CLIENT_ID === 'string' ? env.GITHUB_MANAGER_CLIENT_ID.trim() : ''
  const secret = typeof env.GITHUB_MANAGER_CLIENT_SECRET === 'string' ? env.GITHUB_MANAGER_CLIENT_SECRET.trim() : ''
  return { clientId: id, clientSecret: secret, mode: 'env', complete: id !== '' && secret !== '' }
}

/**
 * Credentials from the environment only. A package that ships a few bytes of
 * secret cannot call them secret, so this build has none.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{clientId: string, clientSecret: string, mode: string, complete: boolean}}
 */
function defaultCredentials(env = process.env) {
  return envCredentials(env)
}

module.exports = { defaultCredentials, envCredentials }
