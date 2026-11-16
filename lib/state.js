'use strict'

/** One-time OAuth state values, 256-bit, single-use, 10-minute TTL. */

const { randomBytes } = require('./crypto')

const DEFAULT_TTL_MS = 10 * 60 * 1000

class PendingStates {
  constructor({ ttlMs = DEFAULT_TTL_MS, max = 32 } = {}) {
    this.ttlMs = ttlMs
    this.max = max
    this.pending = new Map()
  }

  sweep() {
    const now = Date.now()
    for (const [state, entry] of this.pending) {
      if (entry.expiresAt < now) this.pending.delete(state)
    }
  }

  create({ redirectUri, scope, browserBound = true }) {
    this.sweep()
    while (this.pending.size >= this.max) {
      const first = this.pending.keys().next().value
      if (first === undefined) break
      this.pending.delete(first)
    }
    const state = randomBytes(32).toString('base64url')
    const createdAt = Date.now()
    this.pending.set(state, { redirectUri, scope, browserBound, createdAt, expiresAt: createdAt + this.ttlMs })
    return { state, expiresAt: createdAt + this.ttlMs }
  }

  peek(state) {
    this.sweep()
    const entry = this.pending.get(state)
    return entry === undefined ? null : entry
  }

  take(state) {
    this.sweep()
    const entry = this.pending.get(state)
    if (entry === undefined) return null
    this.pending.delete(state)
    return entry
  }
}

module.exports = { PendingStates }
