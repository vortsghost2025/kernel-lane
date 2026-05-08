'use strict';

const crypto = require('crypto');

function sha256(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return crypto.createHash('sha256').update(s).digest('hex');
}

module.exports = { sha256 };
