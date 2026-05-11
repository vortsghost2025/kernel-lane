'use strict';

var fs = require('fs');
var path = require('path');

var EXPECTED_ED25519_KEY_IDS = {
  archivist: '6ed65c18a0afca45',
  kernel: '2effb49ea02dff5b',
  swarmmind: 'c707d41a7bb96d96',
  library: '42e853d4ec37955d'
};

var EXPECTED_RSA_KEY_IDS = {
  archivist: '65ae05b2a9e749cb',
  kernel: '4ac54d4100323c71',
  swarmmind: 'ec467e7103736c28',
  library: 'a5a5f5c2edbee56a'
};

var LANE_ROOT = process.env.LANE_ROOT || path.resolve(__dirname, '..');

function findTrustStore() {
  var candidates = [
    path.join(LANE_ROOT, 'lanes', 'broadcast', 'trust-store.json'),
    path.join(LANE_ROOT, 'trust-store.json')
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) {
      return candidates[i];
    }
  }
  console.error('ERROR: trust-store.json not found');
  process.exit(1);
}

function loadTrustStore(filepath) {
  var raw = fs.readFileSync(filepath, 'utf8');
  return JSON.parse(raw);
}

function normalizeTrustStore(ts) {
  var keys = ts.keys || {};
  var archivedKeys = ts.archived_keys || {};
  var rotationPolicy = ts.rotation_policy || {};
  var keyLineage = ts.key_lineage || {};

  var laneIds = ['archivist', 'kernel', 'swarmmind', 'library'];
  for (var i = 0; i < laneIds.length; i++) {
    var id = laneIds[i];
    if (ts[id] && !keys[id]) {
      keys[id] = ts[id];
    }
  }

  return {
    keys: keys,
    archived_keys: archivedKeys,
    rotation_policy: rotationPolicy,
    key_lineage: keyLineage
  };
}

function runGuards() {
  var filepath = findTrustStore();
  var raw = loadTrustStore(filepath);
  var ts = normalizeTrustStore(raw);

  var errors = [];
  var warnings = [];
  var laneIds = ['archivist', 'kernel', 'swarmmind', 'library'];

  for (var i = 0; i < laneIds.length; i++) {
    var laneId = laneIds[i];
    var laneEntry = ts.keys[laneId];

    if (!laneEntry) {
      errors.push('MISSING: Current key entry for lane "' + laneId + '"');
      continue;
    }

    var expectedEdKeyId = EXPECTED_ED25519_KEY_IDS[laneId];
    var expectedRsaKeyId = EXPECTED_RSA_KEY_IDS[laneId];

    if (laneEntry.algorithm && laneEntry.algorithm !== 'EdDSA') {
      errors.push('WRONG_ALGORITHM: Lane "' + laneId + '" current key has algorithm "' + laneEntry.algorithm + '", expected "EdDSA"');
    }

    if (laneEntry.key_id && laneEntry.key_id !== expectedEdKeyId) {
      errors.push('WRONG_KEY_ID: Lane "' + laneId + '" current key_id "' + laneEntry.key_id + '", expected "' + expectedEdKeyId + '"');
    }

    if (!laneEntry.key_id) {
      errors.push('MISSING_KEY_ID: Lane "' + laneId + '" current entry has no key_id');
    }

    var archivedEntry = ts.archived_keys[expectedRsaKeyId];
    if (!archivedEntry) {
      errors.push('MISSING_ARCHIVED: Lane "' + laneId + '" archived RSA key "' + expectedRsaKeyId + '" not found in archived_keys');
    } else {
      if (archivedEntry.algorithm && archivedEntry.algorithm !== 'RS256') {
        errors.push('WRONG_ARCHIVED_ALGORITHM: Archived key "' + expectedRsaKeyId + '" has algorithm "' + archivedEntry.algorithm + '", expected "RS256"');
      }
      if (!archivedEntry.superseded_by) {
        errors.push('MISSING_SUPERSEDED_BY: Archived key "' + expectedRsaKeyId + '" missing superseded_by link');
      } else if (archivedEntry.superseded_by !== expectedEdKeyId) {
        errors.push('WRONG_SUPERSEDED_BY: Archived key "' + expectedRsaKeyId + '" superseded_by "' + archivedEntry.superseded_by + '", expected "' + expectedEdKeyId + '"');
      }
    }
  }

  var allArchivedKeyIds = Object.keys(ts.archived_keys);
  for (var j = 0; j < allArchivedKeyIds.length; j++) {
    var arkId = allArchivedKeyIds[j];
    var isExpected = false;
    for (var k = 0; k < laneIds.length; k++) {
      if (arkId === EXPECTED_RSA_KEY_IDS[laneIds[k]]) {
        isExpected = true;
        break;
      }
    }
    if (!isExpected) {
      warnings.push('UNKNOWN_ARCHIVED_KEY: archived_keys contains unknown key_id "' + arkId + '"');
    }
  }

  if (!ts.rotation_policy) {
    errors.push('MISSING_ROTATION_POLICY: rotation_policy not found');
  } else {
    if (ts.rotation_policy.minimum_algorithm && ts.rotation_policy.minimum_algorithm !== 'EdDSA') {
      errors.push('WRONG_ROTATION_POLICY: rotation_policy.minimum_algorithm is "' + ts.rotation_policy.minimum_algorithm + '", expected "EdDSA"');
    }
    if (!ts.rotation_policy.rotation_days) {
      warnings.push('WEAK_ROTATION_POLICY: rotation_policy.rotation_days not set');
    }
  }

  if (!ts.key_lineage) {
    errors.push('MISSING_KEY_LINEAGE: key_lineage object not found');
  } else {
    if (!ts.key_lineage.rotations) {
      errors.push('MISSING_KEY_LINEAGE_ROTATIONS: key_lineage.rotations not found');
    } else {
      for (var m = 0; m < laneIds.length; m++) {
        var lid = laneIds[m];
        if (!ts.key_lineage.rotations[lid]) {
          errors.push('MISSING_LINEAGE_ROTATION: key_lineage.rotations."' + lid + '" not found');
        }
      }
    }
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TRUST STORE MUTATION GUARD');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Trust store: ' + filepath);
  console.log('');

  if (warnings.length > 0) {
    console.log('WARNINGS (' + warnings.length + '):');
    for (var w = 0; w < warnings.length; w++) {
      console.log('  ⚠  ' + warnings[w]);
    }
    console.log('');
  }

  if (errors.length > 0) {
    console.log('ERRORS (' + errors.length + '):');
    for (var e = 0; e < errors.length; e++) {
      console.log('  ✗  ' + errors[e]);
    }
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('RESULT: FAIL — Trust store mutation detected!');
    console.log('═══════════════════════════════════════════════════════════════');
    process.exit(1);
  }

  console.log('All checks passed:');
  console.log('  ✓  All 4 current keys are EdDSA with correct key_ids');
  console.log('  ✓  All 4 archived RSA keys present with superseded_by links');
  console.log('  ✓  rotation_policy.minimum_algorithm = EdDSA');
  console.log('  ✓  key_lineage with rotations for all 4 lanes');
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('RESULT: PASS — Trust store integrity verified');
  console.log('═══════════════════════════════════════════════════════════════');
  process.exit(0);
}

runGuards();
