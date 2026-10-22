const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 12 bytes standard for GCM

/**
 * Resolve 32-byte master encryption key for AES-256-GCM.
 * Prioritizes GOOGLE_OAUTH_ENCRYPTION_KEY from environment,
 * falling back to SHA-256 derived key from SESSION_SECRET.
 */
function getEncryptionKey() {
  const envKey = process.env.GOOGLE_OAUTH_ENCRYPTION_KEY;
  if (envKey) {
    if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
      return Buffer.from(envKey, 'hex');
    }
    if (Buffer.byteLength(envKey, 'utf8') === 32) {
      return Buffer.from(envKey, 'utf8');
    }
    // If arbitrary string length, derive 32-byte key via SHA-256
    return crypto.createHash('sha256').update(envKey).digest();
  }

  const sessionSecret = process.env.SESSION_SECRET || 'mdm-secure-fallback-encryption-seed-2025';
  return crypto.createHash('sha256').update('google-drive-oauth:' + sessionSecret).digest();
}

/**
 * Encrypt plaintext string using AES-256-GCM
 *
 * @param {string} text Plaintext string to encrypt (e.g. refresh token)
 * @returns {{ encryptedData: string, iv: string, authTag: string }}
 */
function encryptToken(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Encryption error: Text must be a non-empty string');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encryptedData: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag
  };
}

/**
 * Decrypt ciphertext using AES-256-GCM
 *
 * @param {string} encryptedData Hex-encoded ciphertext
 * @param {string} iv Hex-encoded 12-byte IV
 * @param {string} authTag Hex-encoded 16-byte authentication tag
 * @returns {string} Plaintext decrypted string
 */
function decryptToken(encryptedData, iv, authTag) {
  if (!encryptedData || !iv || !authTag) {
    throw new Error('Decryption error: Missing encryptedData, iv, or authTag');
  }

  const key = getEncryptionKey();
  const ivBuffer = Buffer.from(iv, 'hex');
  const authTagBuffer = Buffer.from(authTag, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuffer);
  decipher.setAuthTag(authTagBuffer);

  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

module.exports = {
  encryptToken,
  decryptToken,
  getEncryptionKey
};
