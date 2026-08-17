'use strict';
// Symmetric AES-256-GCM encryption for Lightspeed refresh tokens stored in
// the tenants.ls_refresh_token column.
//
// Storage format:  enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
// - iv:  12 random bytes per record (never reused)
// - tag: 16-byte GCM auth tag (integrity + auth)
// - ciphertext: AES-256-GCM(plaintext, key, iv)
//
// The "enc:v1:" prefix lets us distinguish encrypted values from legacy
// plaintext ones during migration (decrypt() falls through to plaintext
// with a warning, so existing installs keep working while ops re-run
// OAuth to persist encrypted versions).
//
// Key management:
// - Loaded from env var TENANT_TOKEN_KEY (64 hex chars = 32 bytes).
// - Generate one with: openssl rand -hex 32
// - Rotating the key requires a re-write of every stored token — do it
//   via OAuth re-authorization for each tenant.

const crypto = require('crypto');

const KEY_ENV = 'TENANT_TOKEN_KEY';
const ALGO    = 'aes-256-gcm';
const PREFIX  = 'enc:v1:';

let _cachedKey = null;
function getKey() {
  if (_cachedKey) return _cachedKey;
  const hex = process.env[KEY_ENV];
  if (!hex) {
    throw new Error(`${KEY_ENV} env var not set — cannot en/decrypt Lightspeed tokens. Generate: openssl rand -hex 32`);
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error(`${KEY_ENV} must be 64 hex chars (32 bytes), got ${buf.length} bytes`);
  }
  _cachedKey = buf;
  return buf;
}

function isEncrypted(stored) {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  // Idempotent: don't double-encrypt if already wrapped.
  if (isEncrypted(plaintext)) return plaintext;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decrypt(stored) {
  if (!stored) return null;
  if (!isEncrypted(stored)) {
    // Legacy plaintext — return as-is with a warning so ops can migrate.
    // Not an error because pre-encryption installs need a soft rollout.
    console.warn('[token-crypto] plaintext Lightspeed token detected — re-run OAuth to persist encrypted version');
    return stored;
  }
  const key = getKey();
  const rest = stored.slice(PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 3) throw new Error('token-crypto: malformed encrypted value (expected iv:tag:ct)');
  const iv  = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const ct  = Buffer.from(parts[2], 'hex');
  if (iv.length !== 12) throw new Error('token-crypto: iv must be 12 bytes');
  if (tag.length !== 16) throw new Error('token-crypto: tag must be 16 bytes');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, isEncrypted, PREFIX, KEY_ENV };
