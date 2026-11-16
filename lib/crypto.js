'use strict'

/** AES-256-GCM envelope: iv(12) | tag(16) | ciphertext, base64 encoded. */

const nodeCrypto = require('node:crypto')

const IV_BYTES = 12
const TAG_BYTES = 16
const AAD_TEXT = 'dsh-github-manager/vault/v2'

function randomBytes(size) {
  return nodeCrypto.randomBytes(size)
}

function newMasterKey() {
  return nodeCrypto.randomBytes(32).toString('base64')
}

function normalizeKey(masterKey) {
  if (typeof masterKey !== 'string' || masterKey.trim() === '') {
    throw new Error('master key is required')
  }
  const key = Buffer.from(masterKey.trim(), 'base64')
  if (key.length !== 32) throw new Error('master key must be 32 random bytes in base64')
  return key
}

function encryptJson(value, masterKey) {
  const iv = randomBytes(IV_BYTES)
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', normalizeKey(masterKey), iv)
  cipher.setAAD(Buffer.from(AAD_TEXT, 'utf8'))
  const plain = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

function decryptJson(payload, masterKey) {
  const raw = Buffer.from(String(payload === null || payload === undefined ? '' : payload).trim(), 'base64')
  if (raw.length < IV_BYTES + TAG_BYTES + 1) throw new Error('vault payload is too short')
  const iv = raw.subarray(0, IV_BYTES)
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES)
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', normalizeKey(masterKey), iv)
  decipher.setAAD(Buffer.from(AAD_TEXT, 'utf8'))
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plain.toString('utf8'))
}

module.exports = {
  AAD_TEXT,
  randomBytes,
  newMasterKey,
  normalizeKey,
  encryptJson,
  decryptJson,
}
