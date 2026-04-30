const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function getKeyId(pem) {
  const key = crypto.createPublicKey(pem);
  const der = key.export({type: 'spki', format: 'der'});
  return crypto.createHash('md5').update(der).digest('hex').slice(0, 16);
}

const lanes = [
  {name: 'archivist', path: 'S:/Archivist-Agent'},
  {name: 'library', path: 'S:/self-organizing-library'},
  {name: 'swarmmind', path: 'S:/SwarmMind'},
  {name: 'kernel', path: 'S:/kernel-lane'}
];

const trustStore = {};

for (const lane of lanes) {
  try {
    const privatePemPath = path.join(lane.path, '.identity/private.pem');
    const publicPemPath = path.join(lane.path, '.identity/public.pem');
    const privatePem = fs.readFileSync(privatePemPath, 'utf8');
    const publicPem = fs.readFileSync(publicPemPath, 'utf8');
    const keyId = getKeyId(publicPem);
    
    trustStore[lane.name] = {
      lane_id: lane.name,
      public_key_pem: publicPem.trim(),
      algorithm: 'RS256',
      key_id: keyId,
      registered_at: new Date().toISOString(),
      expires_at: null,
      revoked_at: null
    };
    console.log(lane.name + ': key_id=' + keyId);
  } catch (e) {
    console.error('Error for ' + lane.name + ':', e.message);
  }
}

// Write to all lane broadcast directories
const trustStoreJson = JSON.stringify(trustStore, null, 2);
const broadcastPaths = [
  'S:/Archivist-Agent/lanes/broadcast/trust-store.json',
  'S:/self-organizing-library/lanes/broadcast/trust-store.json',
  'S:/SwarmMind/lanes/broadcast/trust-store.json',
  'S:/kernel-lane/lanes/broadcast/trust-store.json'
];

for (const broadcastPath of broadcastPaths) {
  fs.writeFileSync(broadcastPath, trustStoreJson);
  console.log('Updated: ' + broadcastPath);
}

console.log('\\nTrust store regenerated successfully!');