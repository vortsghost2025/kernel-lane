/**
 * deriveKeyId.js - Canonical Key ID Derivation
 * 
 * ALL lanes MUST use this function for key_id generation.
 * Method: SHA256(DER-encoded SPKI) -> first 16 hex chars
 * This is header-independent and canonical across the system.
 */

const crypto = require('crypto');

/**
 * Derive key_id from PEM public key using DER encoding (CANONICAL METHOD)
 * @param {string} publicKeyPem - PEM-formatted public key
 * @returns {string} - 16-char hex key_id
 */
function deriveKeyId(publicKeyPem) {
  const keyObj = crypto.createPublicKey(publicKeyPem);
  const der = keyObj.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').substring(0, 16);
}

/**
 * Alternative: derive from key object directly
 * @param {Object} keyObj - Node.js KeyObject
 * @returns {string} - 16-char hex key_id
 */
function deriveKeyIdFromKeyObj(keyObj) {
  const der = keyObj.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').substring(0, 16);
}

module.exports = { deriveKeyId, deriveKeyIdFromKeyObj };
