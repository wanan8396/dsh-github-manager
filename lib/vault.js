'use strict'

/**
 * Encrypted credential vault for @local/github-manager.
 *
 * Stores the OAuth App client secret and access tokens for several accounts in
 * one AES-256-GCM envelope. The master key lives in a separate 0600 file so a
 * backup of vault.json alone is worthless. Every read decrypts afresh so an
 * out-of-process tool can edit the vault without a stale cache.
 *
 * Data directory: GITHUB_MANAGER_DATA_DIR, else <DSH_HOME>/github-manager.
 */

const fs = require('node:fs')
const path = require('node:path')
const { newMasterKey, encryptJson, decryptJson } = require('./crypto')

const KEY_FILE = 'master.key'
const VAULT_FILE = 'vault.json'

function resolveDataDir(env = process.env) {
  const explicit = typeof env.GITHUB_MANAGER_DATA_DIR === 'string' && env.GITHUB_MANAGER_DATA_DIR.trim() !== ''
    ? env.GITHUB_MANAGER_DATA_DIR.trim()
    : ''
  if (explicit !== '') return path.resolve(explicit)
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : path.join(require('node:os').homedir(), '.dsh')
  return path.join(path.resolve(home), 'github-manager')
}

function emptyVault() {
  return {
    version: 2,
    oauthApp: { clientId: '', clientSecret: '', mode: 'default', updatedAt: null },
    accounts: [],
    activeLogin: '',
    preferences: { defaultRepo: '', pinnedRepos: [], updatedAt: null },
  }
}

function normalizeScopes(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  return value.split(/[\s,]+/).filter(Boolean)
}

class VaultError extends Error {
  constructor(message, code = 'E_VAULT') {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

class VaultStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || resolveDataDir())
    this.keyPath = path.join(this.dataDir, KEY_FILE)
    this.vaultPath = path.join(this.dataDir, VAULT_FILE)
  }

  ensure() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(this.dataDir, 0o700)
    } catch {}
    if (!fs.existsSync(this.keyPath)) {
      fs.writeFileSync(this.keyPath, `${newMasterKey()}\n`, { encoding: 'utf8', mode: 0o600 })
    }
    try {
      fs.chmodSync(this.keyPath, 0o600)
    } catch {}
    if (!fs.existsSync(this.vaultPath)) {
      this.write(emptyVault())
    }
    return this
  }

  key() {
    if (!fs.existsSync(this.keyPath)) throw new VaultError('master key is missing', 'E_KEY_MISSING')
    return fs.readFileSync(this.keyPath, 'utf8').trim()
  }

  read() {
    if (!fs.existsSync(this.vaultPath)) return emptyVault()
    const payload = fs.readFileSync(this.vaultPath, 'utf8').trim()
    if (payload === '') return emptyVault()
    try {
      const data = decryptJson(payload, this.key())
      return Object.assign(emptyVault(), data)
    } catch (error) {
      throw new VaultError(`cannot decrypt ${this.vaultPath}: ${error.message}`, 'E_VAULT_DECRYPT')
    }
  }

  write(data) {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    const payload = encryptJson(data, this.key())
    const tmp = `${this.vaultPath}.tmp`
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, this.vaultPath)
    return data
  }

  maskClientId() {
    const id = this.credentials().clientId
    if (id === '') return ''
    return id.length > 8 ? `${id.slice(0, 6)}…${id.slice(-4)}` : '••••'
  }

  // ---- OAuth App -----------------------------------------------------------
  credentials() {
    const data = this.read()
    if (data.oauthApp && typeof data.oauthApp.clientId === 'string') return data.oauthApp
    return emptyVault().oauthApp
  }

  isConfigured() {
    const c = this.credentials()
    return c.clientId !== '' && c.clientSecret !== ''
  }

  configure({ clientId, clientSecret } = {}) {
    const data = this.read()
    data.oauthApp = {
      clientId: typeof clientId === 'string' ? clientId.trim() : '',
      clientSecret: typeof clientSecret === 'string' ? clientSecret.trim() : '',
      mode: 'custom',
      updatedAt: new Date().toISOString(),
    }
    this.write(data)
    return this.maskClientId()
  }

  clearCredentials() {
    const data = this.read()
    data.oauthApp = emptyVault().oauthApp
    this.write(data)
  }

  // ---- Tokens / accounts ---------------------------------------------------
  accounts() {
    const data = this.read()
    return (Array.isArray(data.accounts) ? data.accounts : []).map((item) => ({
      login: item.login,
      name: item.name || '',
      avatarUrl: item.avatarUrl || '',
      scopes: normalizeScopes(item.scopes),
      expiresAt: Number(item.expiresAt) || 0,
      refreshable: typeof item.refreshToken === 'string' && item.refreshToken !== '',
      updatedAt: item.updatedAt || '',
    }))
  }

  activeLogin() {
    const data = this.read()
    const wanted = typeof data.activeLogin === 'string' ? data.activeLogin : ''
    if (wanted !== '' && (data.accounts || []).some((a) => a.login === wanted)) return wanted
    return (data.accounts || []).length > 0 ? data.accounts[0].login : ''
  }

  activeAccount() {
    const login = this.activeLogin()
    if (login === '') return null
    return this.accounts().find((item) => item.login === login) || null
  }

  token(login) {
    const data = this.read()
    const wanted = typeof login === 'string' && login !== '' ? login : this.activeLogin()
    const entry = (data.accounts || []).find((a) => a.login === wanted)
    if (entry === null || entry === undefined) return null
    return {
      accessToken: entry.accessToken || '',
      refreshToken: entry.refreshToken || '',
      tokenType: entry.tokenType || 'bearer',
      scopes: normalizeScopes(entry.scopes),
      expiresAt: Number(entry.expiresAt) || 0,
      login: entry.login,
    }
  }

  setToken(token, account, scopes) {
    const data = this.read()
    if (!Array.isArray(data.accounts)) data.accounts = []
    const login = String((account && account.login) || token.login || '').trim()
    if (login === '') throw new VaultError('cannot store a token without an account login', 'E_NO_LOGIN')
    const entry = {
      login,
      name: String((account && account.name) || ''),
      avatarUrl: String((account && account.avatarUrl) || ''),
      accessToken: String(token.accessToken || ''),
      refreshToken: String(token.refreshToken || ''),
      tokenType: String(token.tokenType || 'bearer'),
      scopes: normalizeScopes(scopes && scopes.length > 0 ? scopes : token.scope),
      expiresAt: Number(token.expiresAt) || 0,
      updatedAt: new Date().toISOString(),
    }
    const index = data.accounts.findIndex((a) => a.login === login)
    if (index >= 0) data.accounts[index] = entry
    else data.accounts.push(entry)
    data.activeLogin = login
    this.write(data)
    return this.status()
  }

  updateToken(login, patch) {
    const data = this.read()
    const entry = (data.accounts || []).find((a) => a.login === login)
    if (entry === undefined) throw new VaultError(`unknown account ${login}`, 'E_NO_ACCOUNT')
    Object.assign(entry, patch, { updatedAt: new Date().toISOString() })
    this.write(data)
  }

  switchAccount(login) {
    const data = this.read()
    if (!(data.accounts || []).some((a) => a.login === login)) {
      throw new VaultError(`unknown account ${login}`, 'E_NO_ACCOUNT')
    }
    data.activeLogin = login
    this.write(data)
    return this.status()
  }

  removeAccount(login) {
    const data = this.read()
    data.accounts = (data.accounts || []).filter((a) => a.login !== login)
    if (data.activeLogin === login) data.activeLogin = data.accounts.length > 0 ? data.accounts[0].login : ''
    this.write(data)
    return this.status()
  }

  clearToken() {
    const data = this.read()
    data.accounts = []
    data.activeLogin = ''
    this.write(data)
  }

  // ---- Preferences ---------------------------------------------------------
  preferences() {
    const data = this.read()
    return Object.assign({ defaultRepo: '', pinnedRepos: [], updatedAt: null }, data.preferences || {})
  }

  setPreferences(patch) {
    const data = this.read()
    data.preferences = Object.assign(this.preferences(), patch, { updatedAt: new Date().toISOString() })
    this.write(data)
    return data.preferences
  }

  status() {
    let configured = false
    let decryptError = ''
    try {
      configured = this.isConfigured()
    } catch (error) {
      decryptError = error.message
    }
    return {
      configured,
      connected: this.activeLogin() !== '',
      activeLogin: this.activeLogin(),
      clientIdMasked: decryptError === '' ? this.maskClientId() : '',
      accounts: decryptError === '' ? this.accounts() : [],
      oauthAppMode: decryptError === '' ? this.credentials().mode : '',
      decryptError,
      vault: { path: this.vaultPath, keyPath: this.keyPath, dataDir: this.dataDir },
    }
  }
}

module.exports = { VaultStore, VaultError, resolveDataDir, normalizeScopes, emptyVault }
