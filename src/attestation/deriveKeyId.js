'use strict';

const crypto = require('crypto');

function deriveKeyId(pem) {
  if (!pem || typeof pem !== 'string') {
    throw new Error('deriveKeyId requires a non-empty PEM string');
  }
  const keyObj = crypto.createPublicKey(pem);
  const der = keyObj.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').substring(0, 16);
}

module.exports = { deriveKeyId };
