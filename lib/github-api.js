'use strict'

/**
 * Thin GitHub REST client: required headers, JSON parsing, status and rate-limit
 * metadata. It does not decide whether a non-2xx response is an error — the
 * tool layer translates that. Supports GET/POST/PATCH/PUT/DELETE/HEAD.
 */

const { API_BASE, USER_AGENT } = require('./oauth')

const DEFAULT_MAX_BYTES = 512 * 1024

class GitHubApiError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'GitHubApiError'
    this.code = options.code || 'E_API'
    this.status = Number.isInteger(options.status) ? options.status : 0
  }
}

function applyQuery(query, url) {
  if (query === null || typeof query !== 'object') return
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length > 0) url.searchParams.set(key, value.join(','))
      continue
    }
    url.searchParams.set(key, String(value))
  }
}

class GitHubApi {
  constructor({ accessToken, baseUrl = API_BASE, fetchImpl = fetch, userAgent = USER_AGENT, cache = null, cacheTtlMs = 0 }) {
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new GitHubApiError('an access token is required', { code: 'E_NOT_CONNECTED' })
    }
    this.accessToken = accessToken
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.fetchImpl = fetchImpl
    this.userAgent = userAgent
    this.cache = cache
    this.cacheTtlMs = cacheTtlMs
  }

  clearCache() {
    if (this.cache !== null) this.cache.clear()
  }

  async request(method, apiPath, options = {}) {
    const verb = (method || 'GET').toUpperCase()
    const url = new URL(`${this.baseUrl}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`)
    applyQuery(options.query, url)
    const headers = {
      authorization: `Bearer ${this.accessToken}`,
      accept: options.accept || 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': this.userAgent,
    }
    const init = { method: verb, headers }
    if (options.body !== undefined && options.body !== null && verb !== 'GET' && verb !== 'HEAD') {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }

    const cacheKey = `${verb} ${url.toString()}`
    const now = Date.now()
    if (verb === 'GET' && this.cache !== null) {
      const hit = this.cache.get(cacheKey)
      if (hit !== undefined && now - hit.at < this.cacheTtlMs) return hit.value
    }

    let response
    try {
      response = await this.fetchImpl(url.toString(), init)
    } catch (error) {
      throw new GitHubApiError(`network error: ${error.message}`, { code: 'E_NETWORK' })
    }
    const remaining = response.headers && response.headers.get ? response.headers.get('x-ratelimit-remaining') : null
    const reset = response.headers && response.headers.get ? response.headers.get('x-ratelimit-reset') : null
    const limit = response.headers && response.headers.get ? response.headers.get('x-ratelimit-limit') : null
    const rateLimit = {
      remaining: remaining === null ? null : Number(remaining),
      reset: reset === null ? null : Number(reset),
      limit: limit === null ? null : Number(limit),
    }
    const link = response.headers && response.headers.get ? (response.headers.get('link') || '') : ''

    const reader = response.body && typeof response.body.getReader === 'function'
      ? response.body.getReader()
      : null
    let text = ''
    let truncated = false
    const max = Number(options.maxBytes) || DEFAULT_MAX_BYTES
    if (reader !== null) {
      const decoder = new TextDecoder('utf-8')
      let bytes = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > max) {
          truncated = true
          break
        }
        text += decoder.decode(value, { stream: true })
      }
      if (!truncated) text += decoder.decode()
      try { await reader.cancel() } catch {}
    } else {
      text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > max) {
        truncated = true
        text = text.slice(0, max)
      }
    }

    let json = null
    const contentType = (response.headers && response.headers.get && response.headers.get('content-type')) || ''
    if (/json/i.test(contentType) || text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try { json = JSON.parse(text) } catch {}
    }

    const result = {
      ok: response.ok && !truncated,
      status: response.status,
      url: url.toString(),
      json,
      text,
      truncated,
      contentType,
      rateLimit,
      link,
    }
    if (verb === 'GET' && this.cache !== null && this.cacheTtlMs > 0) {
      this.cache.set(cacheKey, { at: now, value: result })
    }
    return result
  }

  get(apiPath, options = {}) { return this.request('GET', apiPath, options) }
  post(apiPath, body, options = {}) { return this.request('POST', apiPath, { ...options, body }) }
  put(apiPath, body, options = {}) { return this.request('PUT', apiPath, { ...options, body }) }
  patch(apiPath, body, options = {}) { return this.request('PATCH', apiPath, { ...options, body }) }
  delete(apiPath, options = {}) { return this.request('DELETE', apiPath, options) }
}

module.exports = { GitHubApi, GitHubApiError, API_BASE, USER_AGENT, DEFAULT_MAX_BYTES }
