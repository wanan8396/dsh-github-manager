'use strict'

/**
 * Push local files to a repository through the GitHub Git Data API.
 *
 * Why not `git push`: on a phone the TLS handshake to github.com frequently
 * stalls for tens of seconds, and a push that uploads one blob per object is
 * slow even when the link works. The API path sends only the files that
 * changed, in a handful of HTTPS calls, and reports exactly what it did.
 *
 * The five steps of one commit:
 *   1. read the branch head (or the empty tree for a new branch)
 *   2. upload one blob per changed file
 *   3. build a tree with base_tree so untouched files survive
 *   4. create the commit
 *   5. move the branch ref (non-fast-forward is refused unless forced)
 */

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.pnpm', '.venv', 'venv', '__pycache__',
  '.next', 'dist', 'build', 'target', '.cache', '.idea', '.vscode',
])

const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db'])

const MAX_FILES = 2000
const MAX_TOTAL_BYTES = 90 * 1024 * 1024

class PushError extends Error {
  constructor(message, code = 'E_PUSH') {
    super(message)
    this.name = 'PushError'
    this.code = code
  }
}

/** Decide whether a path looks like a secret we must never publish. */
function looksSecret(relativePath, content) {
  const name = path.basename(relativePath).toLowerCase()
  if (/^(\.env|\.env\..+|\.npmrc|\.netrc|id_rsa|id_ed25519|id_ecdsa)$/.test(name)) return 'secret filename'
  if (/\.(pem|key|p12|pfx|keystore)$/.test(name)) return 'key/certificate file'
  if (name === 'master.key' || name === 'vault.json') return 'credential vault'
  if (/\.(sqlite|db|log)$/.test(name)) return 'local state'

  // Content-level checks: a token pasted into a README is still a leak.
  const text = content.toString('utf8')
  const patterns = [
    [/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
    [/github_pat_[A-Za-z0-9_]{40,}/, 'GitHub fine-grained token'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
    [/(?:client_secret|clientSecret)\s*[:=]\s*['"][A-Za-z0-9]{20,}['"]/, 'OAuth client secret'],
    [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  ]
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) return label
  }
  return ''
}

/**
 * Walk a directory and return the files worth publishing.
 * @param {string} root absolute directory
 * @param {{exclude?: string[], maxFiles?: number}} [options]
 * @returns {{files: {path: string, absolute: string, bytes: Buffer}[], skipped: {path: string, reason: string}[], totalBytes: number}}
 */
function collectFiles(root, options = {}) {
  const excluded = new Set((options.exclude || []).map((p) => p.replace(/^\/+|\/+$/g, '')))
  const maxFiles = Math.min(MAX_FILES, Number(options.maxFiles) || MAX_FILES)
  const files = []
  const skipped = []
  let totalBytes = 0

  const walk = (dir, prefix) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      skipped.push({ path: prefix || '.', reason: `unreadable: ${error.code || error.message}` })
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (excluded.has(rel)) continue
      if (entry.isSymbolicLink()) {
        skipped.push({ path: rel, reason: 'symlink' })
        continue
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skipped.push({ path: rel, reason: 'ignored directory' })
          continue
        }
        walk(path.join(dir, entry.name), rel)
        continue
      }
      if (!entry.isFile()) continue
      if (SKIP_FILES.has(entry.name)) {
        skipped.push({ path: rel, reason: 'ignored file' })
        continue
      }
      let bytes
      try {
        bytes = fs.readFileSync(path.join(dir, entry.name))
      } catch (error) {
        skipped.push({ path: rel, reason: `unreadable: ${error.code || error.message}` })
        continue
      }
      const secret = looksSecret(rel, bytes)
      if (secret !== '') {
        skipped.push({ path: rel, reason: `blocked: ${secret}` })
        continue
      }
      if (files.length >= maxFiles) {
        skipped.push({ path: rel, reason: `file cap reached (${maxFiles})` })
        continue
      }
      totalBytes += bytes.length
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new PushError(`内容超过 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB，请用 exclude 缩小范围`, 'E_TOO_LARGE')
      }
      files.push({ path: rel, absolute: path.join(dir, entry.name), bytes })
    }
  }

  const stat = fs.statSync(root)
  if (!stat.isDirectory()) throw new PushError(`${root} is not a directory`, 'E_NOT_A_DIR')
  walk(root, '')
  return { files, skipped, totalBytes }
}

/** git blob sha1, so unchanged files can be detected without uploading. */
function blobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/**
 * Push files to one repository branch.
 * @param {{api: object, repo: string, branch?: string, files: {path: string, bytes: Buffer}[],
 *          message: string, force?: boolean, deletePaths?: string[], author?: {name: string, email: string},
 *          dryRun?: boolean}} input
 * @returns {Promise<object>} a report of what changed.
 */
async function pushFiles({ api, repo, branch = 'main', files, message, force = false, deletePaths = [], author, dryRun = false }) {
  const fullName = String(repo || '').trim()
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) throw new PushError(`repo must be owner/name, got "${fullName}"`, 'E_REPO')
  if (typeof message !== 'string' || message.trim() === '') throw new PushError('commit message is required', 'E_MESSAGE')
  const targetBranch = String(branch || 'main').trim()

  // 1. Current head, or none when the branch does not exist yet.
  let baseCommit = ''
  let baseTree = ''
  const refReply = await api.get(`/repos/${fullName}/git/ref/heads/${encodeURIComponent(targetBranch)}`)
  if (refReply.ok) {
    baseCommit = refReply.json && refReply.json.object ? refReply.json.object.sha : ''
  } else if (refReply.status !== 404) {
    throw new PushError(`cannot read ${targetBranch}: HTTP ${refReply.status} ${refReply.text.slice(0, 200)}`, 'E_REF')
  }
  if (baseCommit !== '') {
    const commitReply = await api.get(`/repos/${fullName}/git/commits/${baseCommit}`)
    if (!commitReply.ok) throw new PushError(`cannot read base commit: HTTP ${commitReply.status}`, 'E_REF')
    baseTree = commitReply.json && commitReply.json.tree ? commitReply.json.tree.sha : ''
  }

  // 2. Which files actually differ from what the tree already holds.
  const existing = new Map()
  if (baseTree !== '') {
    const treeReply = await api.get(`/repos/${fullName}/git/trees/${baseTree}`, { query: { recursive: '1' } })
    if (treeReply.ok && Array.isArray(treeReply.json && treeReply.json.tree)) {
      for (const node of treeReply.json.tree) {
        if (node.type === 'blob') existing.set(node.path, node.sha)
      }
    }
  }

  const changed = []
  const unchanged = []
  for (const file of files) {
    const sha = blobSha(file.bytes)
    if (existing.get(file.path) === sha) {
      unchanged.push(file.path)
    } else {
      changed.push({ ...file, sha })
    }
  }

  const report = {
    repo: fullName,
    branch: targetBranch,
    commit: '',
    commitUrl: '',
    created: baseCommit === '',
    changed: changed.map((f) => f.path),
    unchanged: unchanged.length,
    deleted: deletePaths.slice(),
    skipped: [],
    dryRun,
  }

  if (changed.length === 0 && deletePaths.length === 0) {
    report.noop = true
    return report
  }
  if (dryRun) return report

  // 3. Upload blobs, then build the tree on top of the existing one.
  const treeEntries = []
  for (const file of changed) {
    const blobReply = await api.post(`/repos/${fullName}/git/blobs`, {
      content: file.bytes.toString('base64'),
      encoding: 'base64',
    })
    if (!blobReply.ok) {
      throw new PushError(`blob upload failed for ${file.path}: HTTP ${blobReply.status} ${blobReply.text.slice(0, 200)}`, 'E_BLOB')
    }
    treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blobReply.json.sha })
  }
  for (const victim of deletePaths) {
    // sha:null removes the path from the tree.
    treeEntries.push({ path: String(victim).replace(/^\/+/, ''), mode: '100644', type: 'blob', sha: null })
  }

  const treePayload = { tree: treeEntries }
  if (baseTree !== '') treePayload.base_tree = baseTree
  const treeReply = await api.post(`/repos/${fullName}/git/trees`, treePayload)
  if (!treeReply.ok) {
    throw new PushError(`tree creation failed: HTTP ${treeReply.status} ${treeReply.text.slice(0, 300)}`, 'E_TREE')
  }

  // 4. Commit.
  const commitPayload = { message: message.trim(), tree: treeReply.json.sha, parents: baseCommit === '' ? [] : [baseCommit] }
  if (author && author.name && author.email) {
    commitPayload.author = { name: author.name, email: author.email, date: new Date().toISOString() }
  }
  const commitReply = await api.post(`/repos/${fullName}/git/commits`, commitPayload)
  if (!commitReply.ok) {
    throw new PushError(`commit failed: HTTP ${commitReply.status} ${commitReply.text.slice(0, 300)}`, 'E_COMMIT')
  }
  report.commit = commitReply.json.sha
  report.commitUrl = commitReply.json.html_url || ''

  // 5. Move the ref (create it when the branch is new).
  if (baseCommit === '') {
    const createReply = await api.post(`/repos/${fullName}/git/refs`, {
      ref: `refs/heads/${targetBranch}`,
      sha: report.commit,
    })
    if (!createReply.ok) throw new PushError(`cannot create ${targetBranch}: HTTP ${createReply.status} ${createReply.text.slice(0, 300)}`, 'E_REF')
  } else {
    const moveReply = await api.request('PATCH', `/repos/${fullName}/git/refs/heads/${encodeURIComponent(targetBranch)}`, {
      body: { sha: report.commit, force: force === true },
    })
    if (!moveReply.ok) {
      throw new PushError(
        `cannot move ${targetBranch}: HTTP ${moveReply.status} ${moveReply.text.slice(0, 300)}` +
        (moveReply.status === 422 ? '（远端有新提交，先 pull 或在参数里加 force）' : ''),
        'E_REF',
      )
    }
  }

  return report
}

module.exports = { collectFiles, pushFiles, blobSha, looksSecret, PushError, SKIP_DIRS }
