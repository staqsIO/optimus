import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/credentials');

/**
 * AES-256-GCM encrypt/decrypt for account credentials.
 * Key from CREDENTIALS_ENCRYPTION_KEY env var (32-byte hex string).
 *
 * Wire format: iv (12 bytes) + authTag (16 bytes) + ciphertext
 */

function getKey() {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate with: node -e "log.info(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a JSON object to a Buffer (iv + authTag + ciphertext).
 * @param {Object} jsonObj - Credentials object to encrypt
 * @returns {Buffer} Encrypted bytes
 */
export function encryptCredentials(jsonObj) {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const plaintext = JSON.stringify(jsonObj);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Wire format: iv (12) + authTag (16) + ciphertext
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a Buffer back to a JSON object.
 * @param {Buffer} buffer - Encrypted bytes (iv + authTag + ciphertext)
 * @returns {Object} Decrypted credentials object
 */
export function decryptCredentials(buffer) {
  const key = getKey();
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}
