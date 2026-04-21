/**
* Signer.js - Phase 4.3 JWS Signing
*
* Creates JSON Web Signatures (JWS) for queue items, audit events,
* and continuity records using RSA private keys.
*
* ENFORCEMENT: Canonical 'lane' field in all payloads
*/

const crypto = require('crypto');
const { stableStringify } = require('./stableStringify');

class Signer {
constructor(options = {}) {
this.algorithm = 'RS256';
this.typ = 'JWT';
this.expiresInMs = options.expiresInMs || 86400000; // 24 hours default
}

_base64UrlEncode(data) {
const base64 = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');
return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

_createHeader(keyId) {
return {
alg: this.algorithm,
typ: this.typ,
kid: keyId
};
}

sign(payload, privateKey, keyId) {
const header = this._createHeader(keyId);
const headerB64 = this._base64UrlEncode(JSON.stringify(header));

const payloadWithTimestamp = {
...payload,
iat: Math.floor(Date.now() / 1000),
exp: Math.floor((Date.now() + this.expiresInMs) / 1000)
};

// Use stable stringify for deterministic serialization
const payloadB64 = this._base64UrlEncode(stableStringify(payloadWithTimestamp));

const signingInput = `${headerB64}.${payloadB64}`;
const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
const signatureB64 = this._base64UrlEncode(signature);

return {
jws: `${headerB64}.${payloadB64}.${signatureB64}`,
header,
payload: payloadWithTimestamp,
signature: signatureB64
};
}

signQueueItem(item, privateKey, keyId) {
// Canonical lane field (not origin_lane)
const lane = item.lane || item.origin_lane;

const signablePayload = {
id: item.id,
timestamp: item.timestamp,
lane: lane, // CANONICAL FIELD
target_lane: item.target_lane,
type: item.type
};

// Only add payload if it exists and is not undefined
if (item.payload !== undefined && item.payload !== null) {
signablePayload.payload = item.payload;
}

const result = this.sign(signablePayload, privateKey, keyId);
return {
...item,
lane: lane, // Ensure canonical field in returned item
signature: result.jws,
signature_alg: this.algorithm,
key_id: keyId
};
}

signAuditEvent(event, privateKey, keyId) {
const signablePayload = {
timestamp: event.timestamp,
lane: event.lane,
event: event.event,
...event
};

const result = this.sign(signablePayload, privateKey, keyId);
return {
...event,
signature: result.jws,
signature_alg: this.algorithm,
key_id: keyId
};
}

signContinuityRecord(record, privateKey, keyId) {
const signablePayload = {
lane: record.lane || record.lane_id, // Canonical field
fingerprint: record.fingerprint,
timestamp: record.timestamp || new Date().toISOString()
};

const result = this.sign(signablePayload, privateKey, keyId);
return {
...record,
lane: signablePayload.lane,
signature: result.jws,
signature_alg: this.algorithm,
key_id: keyId
};
}

signApprovalRequest(request, privateKey, keyId) {
const signablePayload = {
id: request.id,
lane_id: request.lane_id,
action: request.action,
artifact_path: request.artifact_path,
timestamp: request.timestamp || new Date().toISOString()
};

const result = this.sign(signablePayload, privateKey, keyId);
return {
...request,
signature: result.jws,
signature_alg: this.algorithm,
key_id: keyId
};
}
}

module.exports = { Signer };