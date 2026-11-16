'use strict'

/**
 * GitHub Actions secret encryption: sealed-box (X25519 + XSalsa20-Poly1305).
 * GitHub publishes a base64 Ed25519 public key for each repo; the Actions API
 * expects a base64 sealed box produced with libsodium's `crypto_box_seal`.
 *
 * tweetnacl is vendored as lib/nacl.js (MIT) so the plugin has no npm deps.
 */

const nacl = require('./nacl')
const { blake2b } = require('./blake2b')

function secretBoxSeal(messageBytes, recipientPublicKey) {
  const ephemeral = nacl.box.keyPair()
  // libsodium crypto_box_seal derives the nonce deterministically:
  //   nonce = BLAKE2b-24(ephemeral_pk || recipient_pk)
  const seeds = new Uint8Array(ephemeral.publicKey.length + recipientPublicKey.length)
  seeds.set(ephemeral.publicKey, 0)
  seeds.set(recipientPublicKey, ephemeral.publicKey.length)
  const nonce = blake2b(seeds, null, nacl.box.nonceLength)
  const box = nacl.box(messageBytes, nonce, recipientPublicKey, ephemeral.secretKey)
  if (box === null) throw new Error('failed to encrypt secret')
  // libsodium crypto_box_seal layout: ephemeral_pk(32) | box(ciphertext | mac)
  const out = new Uint8Array(ephemeral.publicKey.length + box.length)
  out.set(ephemeral.publicKey, 0)
  out.set(box, ephemeral.publicKey.length)
  return out
}

/** @returns {string} base64 sealed box ready for the Actions secrets API. */
function encryptSecret(value, base64PublicKey) {
  const pk = Uint8Array.from(Buffer.from(String(base64PublicKey).replace(/\s+/g, ''), 'base64'))
  if (pk.length !== nacl.box.publicKeyLength) {
    throw new Error(`invalid Actions public key length ${pk.length}, expected ${nacl.box.publicKeyLength}`)
  }
  const message = Buffer.from(String(value), 'utf8')
  const sealed = secretBoxSeal(message, pk)
  return Buffer.from(sealed).toString('base64')
}

module.exports = { encryptSecret }
