// sync-gate-verify.js
// Cross-lane sync-gate verification.
// Evidence-first, fail-closed behavior.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { deriveKeyId } = require('../.global/deriveKeyId');

const VERIFICATION_DIR = path.resolve('S:/self-organizing-library/verification');

const TRUST_STORE_CANDIDATES = [
  path.resolve('S:/self-organizing-library/lanes/broadcast/trust-store.json'),
  path.resolve('S:/kernel-lane/lanes/broadcast/trust-store.json'),
  path.resolve('S:/Archivist-Agent/lanes/broadcast/trust-store.json'),
];

const LANE_SNAPSHOT_CANDIDATES = {
  archivist: [
    path.resolve('S:/Archivist-Agent/.identity/snapshot.json'),
  ],
  library: [
    path.resolve('S:/self-organizing-library/.identity/snapshot.json'),
  ],
  kernel: [
    path.resolve('S:/kernel-lane/.identity/snapshot.json'),
  ],
  swarmmind: [
    path.resolve('S:/SwarmMind/.identity/snapshot.json'),
  ],
};

const BUNDLE_FILES = [
  'behavioral-test-results.json',
  'hardening-drill-results.json',
  'recovery-discipline-results.json',
  'usage-lane-complete-report.json',
  'verdict.json',
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function deriveKeyIdCanonical(pem) {
  if (!pem || typeof pem !== 'string') return null;
  return deriveKeyId(pem);
}

function parseTrustStoreFile(candidate) {
  if (!fs.existsSync(candidate)) {
    return { path: candidate, exists: false, parse_ok: false, valid_count: 0, lanes: null };
  }

  const trust = readJson(candidate);
  if (!trust || typeof trust !== 'object') {
    return { path: candidate, exists: true, parse_ok: false, valid_count: 0, lanes: null };
  }

  let validCount = 0;
  const lanes = {};
  for (const lane of ['archivist', 'library', 'swarmmind', 'kernel']) {
    const entry = trust[lane] || null;
    if (!entry) {
      lanes[lane] = { missing: true, stored_key_id: null, derived_key_id: null, matches_derivation: false };
      continue;
    }

    const stored = typeof entry.key_id === 'string' ? entry.key_id : null;
    const pem = typeof entry.public_key_pem === 'string' ? entry.public_key_pem : null;
    const derived = pem ? deriveKeyIdCanonical(pem) : null;
    const matches = !!(stored && derived && stored === derived);
    if (matches) validCount += 1;

    lanes[lane] = {
      stored_key_id: stored,
      derived_key_id: derived,
      matches_derivation: matches,
    };
  }

  return {
    path: candidate,
    exists: true,
    parse_ok: true,
    valid_count: validCount,
    lanes,
  };
}

function resolveTrustStore() {
  const candidates = TRUST_STORE_CANDIDATES.map(parseTrustStoreFile);

  let selected = null;
  for (const c of candidates) {
    if (!c.parse_ok || !c.lanes) continue;
    if (!selected || c.valid_count > selected.valid_count) {
      selected = c;
    }
  }

  if (!selected) {
    return {
      selected: null,
      candidates,
      error: 'No readable trust-store found in configured candidates.',
    };
  }

  return {
    selected,
    candidates,
    error: null,
  };
}

function readLaneSnapshots() {
  const out = {};
  for (const lane of Object.keys(LANE_SNAPSHOT_CANDIDATES)) {
    const candidates = LANE_SNAPSHOT_CANDIDATES[lane];
    let p = null;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        p = candidate;
        break;
      }
    }
    if (!p) {
      out[lane] = { path: candidates[0], exists: false, key_id: null };
      continue;
    }

    const data = readJson(p);
    let keyId = null;
    if (data && typeof data === 'object') {
      if (typeof data.key_id === 'string') keyId = data.key_id;
      if (!keyId && data.identity && typeof data.identity.key_id === 'string') {
        keyId = data.identity.key_id;
      }
    }

    out[lane] = { path: p, exists: true, key_id: keyId };
  }
  return out;
}

function collectBundleEvidence() {
  const results = {};
  for (const file of BUNDLE_FILES) {
    const p = path.join(VERIFICATION_DIR, file);
    const exists = fs.existsSync(p);
    results[file] = {
      path: p,
      exists,
      parse_ok: exists ? !!readJson(p) : false,
    };
  }
  return results;
}

function evaluate(trustStoreResolution, snapshots) {
  const issues = [];
  const mismatches = [];

  if (!trustStoreResolution.selected) {
    issues.push({ code: 'TRUST_STORE_UNRESOLVED', message: trustStoreResolution.error || 'Trust-store unresolved.' });
    return { pass: false, issues, mismatches };
  }

  const trustStore = trustStoreResolution.selected;
  if (trustStore.valid_count < 4) {
    issues.push({
      code: 'TRUST_STORE_PARTIAL_VALIDITY',
      message: `Selected trust-store has ${trustStore.valid_count}/4 derivation matches.`,
      path: trustStore.path,
    });
  }

  for (const lane of ['archivist', 'library', 'swarmmind', 'kernel']) {
    const trust = trustStore.lanes[lane];
    const snap = snapshots[lane];

    if (!trust || trust.missing) {
      issues.push({ code: 'TRUST_ENTRY_MISSING', lane, message: `Missing trust-store entry for ${lane}.` });
      continue;
    }

    if (!trust.matches_derivation) {
      mismatches.push({
        code: 'TRUST_DERIVATION_MISMATCH',
        lane,
        expected: trust.derived_key_id,
        observed: trust.stored_key_id,
        source: trustStore.path,
      });
    }

    if (!snap || !snap.exists) {
      issues.push({ code: 'SNAPSHOT_MISSING', lane, path: snap ? snap.path : null, message: `Snapshot missing for ${lane}.` });
      continue;
    }

    if (!snap.key_id) {
      issues.push({ code: 'SNAPSHOT_KEY_ID_MISSING', lane, path: snap.path, message: `key_id missing in ${lane} snapshot.` });
      continue;
    }

    if (trust.stored_key_id !== snap.key_id) {
      mismatches.push({
        code: 'SNAPSHOT_TRUST_MISMATCH',
        lane,
        expected: trust.stored_key_id,
        observed: snap.key_id,
        source: snap.path,
      });
    }
  }

  const pass = issues.length === 0 && mismatches.length === 0;
  return { pass, issues, mismatches };
}

(function main() {
  const trustStoreResolution = resolveTrustStore();
  const snapshots = readLaneSnapshots();
  const bundleEvidence = collectBundleEvidence();
  const verdict = evaluate(trustStoreResolution, snapshots);

  const output = {
    status: verdict.pass ? 'PASS' : 'FAIL',
    timestamp: new Date().toISOString(),
    evidence: {
      trust_store: trustStoreResolution,
      snapshots,
      verification_bundles: bundleEvidence,
    },
    issues: verdict.issues,
    mismatches: verdict.mismatches,
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(verdict.pass ? 0 : 1);
})();
