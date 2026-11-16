'use strict'

/**
 * Built-in GitHub OAuth App. Ships with the plugin so the web flow works right
 * after installation — the user only has to approve on GitHub's consent page.
 * Override with GITHUB_MANAGER_CLIENT_ID / GITHUB_MANAGER_CLIENT_SECRET, or
 * call gh_auth_setup with a custom app.
 *
 * The client secret is baked into the bundle: it is used only by this local
 * process against github.com, and the resulting token is still scoped to and
 * approved by the user who completes the browser flow.
 */

const DEFAULT_CLIENT_ID = 'Ov23li80U9STQlDW7Tui'
const DEFAULT_CLIENT_SECRET = 'e96223611e1410c750cb7e857b9a40756f0eee3d'

function defaultCredentials(env = process.env) {
  const id = typeof env.GITHUB_MANAGER_CLIENT_ID === 'string' ? env.GITHUB_MANAGER_CLIENT_ID.trim() : ''
  const secret = typeof env.GITHUB_MANAGER_CLIENT_SECRET === 'string' ? env.GITHUB_MANAGER_CLIENT_SECRET.trim() : ''
  return {
    clientId: id !== '' ? id : DEFAULT_CLIENT_ID,
    clientSecret: secret !== '' ? secret : DEFAULT_CLIENT_SECRET,
    mode: id !== '' || secret !== '' ? 'env' : 'default',
  }
}

module.exports = { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET, defaultCredentials }
