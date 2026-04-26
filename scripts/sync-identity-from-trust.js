const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LANES = {
  archivist: { root: 'S:/Archivist-Agent', ts: 'S:/Archivist-Agent/lanes/broadcast/trust-store.json' },
  library: { root: 'S:/self-organizing-library', ts: 'S:/self-organizing-library/lanes/broadcast/trust-store.json' },
  swarmmind: { root: 'S:/SwarmMind', ts: 'S:/Archivist-Agent/lanes/broadcast/trust-store.json' },
  kernel: { root: 'S:/kernel-lane', ts: 'S:/Archivist-Agent/lanes/broadcast/trust-store.json' }
};

function kid(pem) {
  return crypto.createHash('sha256').update(pem.trim()).digest('hex').slice(0, 16);
}

function loadTrust(tsPath, laneId) {
  if (!fs.existsSync(tsPath)) return null;
  try {
    const t = JSON.parse(fs.readFileSync(tsPath, 'utf8'));
    return t[laneId] || null;
  } catch { return null; }
}

console.log('=== Identity Sync: Extract PEM from trust store → write .identity/public.pem ===\n');

const results = {};

for (const [laneId, cfg] of Object.entries(LANES)) {
  const entry = loadTrust(cfg.ts, laneId);
  if (!entry || !entry.public_key_pem) {
    results[laneId] = 'NO_TRUST_ENTRY';
    console.log(`${laneId}: NO_TRUST_ENTRY`);
    continue;
  }

  const expectedKeyId = entry.key_id;
  const pemStr = entry.public_key_pem;
  const derivedKeyId = kid(pemStr);

  if (derivedKeyId !== expectedKeyId) {
    console.log(`${laneId}: KEY_ID_DERIVATION_MISMATCH — PEM in trust store gives ${derivedKeyId}, expected ${expectedKeyId}`);
    results[laneId] = 'KEY_ID_MISMATCH';
    continue;
  }

  const idDir = path.join(cfg.root, '.identity');
  fs.mkdirSync(idDir, { recursive: true });

  const pubPath = path.join(idDir, 'public.pem');
  fs.writeFileSync(pubPath, pemStr);
  console.log(`${laneId}: WROTE public.pem (key_id=${expectedKeyId})`);

  results[laneId] = expectedKeyId;
}

console.log('\n=== Verification ===\n');

for (const [laneId, cfg] of Object.entries(LANES)) {
  const pubPath = path.join(cfg.root, '.identity', 'public.pem');
  if (fs.existsSync(pubPath)) {
    const pem = fs.readFileSync(pubPath, 'utf8').trim();
    const computed = kid(pem);
    const entry = loadTrust(cfg.ts, laneId);
    const expected = entry?.key_id || 'NO_TRUST';
    const match = computed === expected ? 'MATCH' : 'MISMATCH';
    console.log(`${laneId}: computed=${computed} expected=${expected} [${match}]`);
  } else {
    console.log(`${laneId}: NO public.pem`);
  }
}

console.log('\nNote: private.pem generation requires private key material not in trust store. For full normalization, private keys must be generated separately and their public counterparts matched to trust store entries.');
console.log('\nPublic PEM sync complete. Private keys need separate generation.');