const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = 'S:/Archivist-Agent';
const TRUST_PATH = `${ROOT}/lanes/broadcast/trust-store.json`;
const LANE_CONFIGS = {
  archivist: `${ROOT}`,
  library: 'S:/self-organizing-library',
  swarmmind: 'S:/SwarmMind',
  kernel: 'S:/kernel-lane'
};

console.log('=== Multi-Source Consistency Debug ===\n');

const trust = JSON.parse(fs.readFileSync(TRUST_PATH, 'utf8'));

for (const [lane, config] of Object.entries(LANE_CONFIGS)) {
  const idPath = path.join(config, '.identity', 'public.pem');
  const exists = fs.existsSync(idPath);
  
  if (exists) {
    try {
      const pem = fs.readFileSync(idPath, 'utf8');
      const keyId = crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16);
      const trustKeyId = trust[lane]?.key_id || 'N/A';
      const match = keyId === trustKeyId ? 'MATCH' : 'MISMATCH';
      console.log(`${lane}: keyId=${keyId} trustStore=${trustKeyId} [${match}]`);
    } catch (e) {
      console.log(`${lane}: ERROR reading PEM - ${e.message}`);
    }
  } else {
    const trustKeyId = trust[lane]?.key_id || 'N/A';
    console.log(`${lane}: NO .identity/public.pem (trustStore=${trustKeyId})`);
  }
}

console.log('\n--- Heartbeat check ---');
for (const [lane, config] of Object.entries(LANE_CONFIGS)) {
  const hbPath = path.join(config, 'lanes', lane, 'inbox', `heartbeat-${lane}.json`);
  if (fs.existsSync(hbPath)) {
    try {
      const hb = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
      console.log(`${lane}: status=${hb.status || 'unknown'}`);
    } catch {
      console.log(`${lane}: heartbeat PARSE ERROR`);
    }
  } else {
    console.log(`${lane}: NO heartbeat file`);
  }
}