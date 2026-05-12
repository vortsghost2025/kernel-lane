#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var LANE_ROOT = process.env.LANE_ROOT || path.resolve(__dirname, '..');

var TRUST_STORE_PATH = path.join(LANE_ROOT, 'lanes/broadcast/trust-store.json');

var algoHelpersPath = path.join(LANE_ROOT, '.global/algorithm-helpers.js');
var deriveKeyIdPath = path.join(LANE_ROOT, '.global/deriveKeyId.js');

if (!fs.existsSync(algoHelpersPath)) {
    console.error('algorithm-helpers.js not found at ' + algoHelpersPath);
    process.exit(1);
}
if (!fs.existsSync(deriveKeyIdPath)) {
    console.error('deriveKeyId.js not found at ' + deriveKeyIdPath);
    process.exit(1);
}

var algoHelpers = require(algoHelpersPath);
var getVerifyParamsFromPem = algoHelpers.getVerifyParamsFromPem;
var ALG_RSA = algoHelpers.ALG_RSA;
var ALG_EDDSA = algoHelpers.ALG_EDDSA;
var SUPPORTED_ALGORITHMS = algoHelpers.SUPPORTED_ALGORITHMS;

var deriveKeyId = require(deriveKeyIdPath).deriveKeyId || require(deriveKeyIdPath);

var passed = 0;
var failed = 0;
var failures = [];

function assert(condition, label) {
    if (condition) {
        passed++;
        console.log(' PASS: ' + label);
    } else {
        failed++;
        failures.push(label);
        console.log(' FAIL: ' + label);
    }
}

function loadTrustStore() {
    if (!fs.existsSync(TRUST_STORE_PATH)) {
        console.error('Trust store not found at ' + TRUST_STORE_PATH);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(TRUST_STORE_PATH, 'utf8'));
}

function getLaneEntry(trustStore, laneId) {
    return trustStore[laneId] || (trustStore.keys && trustStore.keys[laneId]);
}

function testAlgorithmParams() {
    console.log('\n--- Algorithm params detection ---');
    var trustStore = loadTrustStore();
    var laneIds = ['archivist', 'kernel', 'swarmmind', 'library'];

    assert(SUPPORTED_ALGORITHMS.indexOf(ALG_RSA) !== -1, 'RS256 in SUPPORTED_ALGORITHMS');
    assert(SUPPORTED_ALGORITHMS.indexOf(ALG_EDDSA) !== -1, 'EdDSA in SUPPORTED_ALGORITHMS');

    var testedEd25519 = false;
    var testedRsa = false;

    for (var i = 0; i < laneIds.length; i++) {
        var laneId = laneIds[i];
        var entry = getLaneEntry(trustStore, laneId);
        if (!entry || !entry.public_key_pem) continue;

        try {
            var params = getVerifyParamsFromPem(entry.public_key_pem);
            if (params.alg === ALG_EDDSA && !testedEd25519) {
                assert(params.alg === ALG_EDDSA, 'Ed25519 public key detected as EdDSA (from ' + laneId + ')');
                assert(params.verifyAlg === null, 'Ed25519 verifyAlg is null');
                testedEd25519 = true;
            }
        } catch (e) {
            assert(false, laneId + ' Ed25519 param detection failed: ' + e.message);
        }
    }

    var archivedKeys = trustStore.archived_keys || {};
    var archivedIds = Object.keys(archivedKeys);
    for (var j = 0; j < archivedIds.length; j++) {
        var archived = archivedKeys[archivedIds[j]];
        if (!archived.public_key_pem) continue;

        try {
            var rsaParams = getVerifyParamsFromPem(archived.public_key_pem);
            if (rsaParams.alg === ALG_RSA && !testedRsa) {
                assert(rsaParams.alg === ALG_RSA, 'RSA public key detected as RS256 (from archived ' + archived.lane_id + ')');
                assert(rsaParams.verifyAlg === 'RSA-SHA256', 'RSA verifyAlg is RSA-SHA256');
                testedRsa = true;
            }
        } catch (e) {
            assert(false, archived.lane_id + ' RSA param detection failed: ' + e.message);
        }
    }

    if (!testedEd25519) { assert(false, 'No Ed25519 key tested from trust store'); }
    if (!testedRsa) { assert(false, 'No RSA key tested from archived keys'); }
}

function testRsaBackwardCompatibility() {
    console.log('\n--- RSA backward compatibility ---');
    var trustStore = loadTrustStore();
    var archivedKeys = trustStore.archived_keys || {};

    if (Object.keys(archivedKeys).length === 0) {
        assert(false, 'archived_keys exist in trust store');
        return;
    }
    assert(true, 'archived_keys exist (' + Object.keys(archivedKeys).length + ' keys)');

    var keyIds = Object.keys(archivedKeys);
    for (var i = 0; i < keyIds.length; i++) {
        var keyId = keyIds[i];
        var archived = archivedKeys[keyId];
        var pubPem = archived.public_key_pem;
        assert(!!pubPem, archived.lane_id + ' archived RSA key has public_key_pem');
        assert(archived.algorithm === 'RS256', archived.lane_id + ' archived key is RS256');

        try {
            var verifyParams = getVerifyParamsFromPem(pubPem);
            assert(verifyParams.alg === 'RS256', archived.lane_id + ' verify params alg=RS256');
            assert(verifyParams.verifyAlg === 'RSA-SHA256', archived.lane_id + ' verify params verifyAlg=RSA-SHA256');
        } catch (e) {
            assert(false, archived.lane_id + ' getVerifyParamsFromPem failed: ' + e.message);
        }

        try {
            var publicKey = crypto.createPublicKey({ key: pubPem, format: 'pem' });
            assert(publicKey.type === 'public', archived.lane_id + ': archived RSA public key loads correctly');
            var testData = Buffer.from('rsa-backcompat-test-' + Date.now());
            var verifyResult = crypto.verify('RSA-SHA256', testData, {
                key: publicKey,
                padding: crypto.constants.RSA_PKCS1_PADDING,
            }, Buffer.alloc(256));
            assert(verifyResult === false, archived.lane_id + ': RSA verify with garbage sig returns false (correct)');
        } catch (e) {
            assert(false, archived.lane_id + ' RSA crypto operation failed: ' + e.message);
        }
    }
}

function testTrustStoreEd25519KeysPresent() {
    console.log('\n--- Trust store Ed25519 keys present ---');
    var trustStore = loadTrustStore();
    var laneIds = ['archivist', 'kernel', 'swarmmind', 'library'];

    for (var i = 0; i < laneIds.length; i++) {
        var laneId = laneIds[i];
        var entry = getLaneEntry(trustStore, laneId);
        assert(!!entry, laneId + ' has trust store entry');
        if (entry) {
            assert(entry.algorithm === 'EdDSA', laneId + ' algorithm is EdDSA (got ' + entry.algorithm + ')');
            assert(!!entry.key_id, laneId + ' has key_id');
            assert(!!entry.public_key_pem, laneId + ' has public_key_pem');
            assert(entry.public_key_pem.indexOf('BEGIN PUBLIC KEY') !== -1, laneId + ' public_key_pem is valid PEM');

            try {
                var derivedKeyId = deriveKeyId(entry.public_key_pem);
                assert(derivedKeyId === entry.key_id, laneId + ' derived key_id matches trust store (' + derivedKeyId + ' vs ' + entry.key_id + ')');
            } catch (e) {
                assert(false, laneId + ' deriveKeyId failed: ' + e.message);
            }
        }
    }
}

function testTrustStoreArchivedKeysValid() {
    console.log('\n--- Trust store archived keys valid ---');
    var trustStore = loadTrustStore();
    var archivedKeys = trustStore.archived_keys || {};
    var keyIds = Object.keys(archivedKeys);

    assert(keyIds.length === 4, 'exactly 4 archived keys (got ' + keyIds.length + ')');

    for (var i = 0; i < keyIds.length; i++) {
        var keyId = keyIds[i];
        var archived = archivedKeys[keyId];
        assert(archived.algorithm === 'RS256', 'archived key ' + keyId + ' is RS256');
        assert(!!archived.superseded_by, 'archived key ' + keyId + ' has superseded_by');
        assert(!!archived.lane_id, 'archived key ' + keyId + ' has lane_id');
        assert(archived.archived_reason === 'ed25519-migration', 'archived key ' + keyId + ' has ed25519-migration reason');
    }
}

function testTrustStoreRotationPolicyPresent() {
    console.log('\n--- Trust store rotation policy present ---');
    var trustStore = loadTrustStore();

    assert(!!trustStore.rotation_policy, 'rotation_policy exists');
    if (trustStore.rotation_policy) {
        assert(typeof trustStore.rotation_policy.rotation_days === 'number', 'rotation_days is number');
        assert(typeof trustStore.rotation_policy.warning_days === 'number', 'warning_days is number');
        assert(typeof trustStore.rotation_policy.grace_days === 'number', 'grace_days is number');
        assert(!!trustStore.rotation_policy.last_rotated, 'last_rotated is set');
    }
}

function testTrustStoreKeyLineagePresent() {
    console.log('\n--- Trust store key_lineage present ---');
    var trustStore = loadTrustStore();

    assert(!!trustStore.key_lineage, 'key_lineage exists');
    if (trustStore.key_lineage) {
        assert(!!trustStore.key_lineage.rotations, 'key_lineage has rotations');
        if (trustStore.key_lineage.rotations) {
            var laneIds = ['archivist', 'kernel', 'swarmmind', 'library'];
            var hasEd25519Migration = false;
            for (var i = 0; i < laneIds.length; i++) {
                var rot = trustStore.key_lineage.rotations[laneIds[i]];
                if (rot && rot.reason && rot.reason.indexOf('Ed25519') !== -1) {
                    hasEd25519Migration = true;
                }
                assert(!!rot, 'key_lineage.rotations has ' + laneIds[i]);
                if (rot) {
                    assert(!!rot.previous_key_id, laneIds[i] + ' rotation has previous_key_id');
                    assert(!!rot.current_key_id, laneIds[i] + ' rotation has current_key_id');
                    assert(!!rot.rotated_at, laneIds[i] + ' rotation has rotated_at');
                }
            }
            assert(hasEd25519Migration, 'key_lineage.rotations contains Ed25519 migration entry');
        }
    }
}

function testEnforcerRejectsUnsigned() {
    console.log('\n--- Enforcer rejects unsigned ---');
    var enforcerPath = path.join(LANE_ROOT, 'scripts/identity-enforcer.js');
    if (!fs.existsSync(enforcerPath)) {
        console.log(' SKIP: identity-enforcer.js not found');
        return;
    }

    try {
        var IdentityEnforcer = require(enforcerPath).IdentityEnforcer;
        var enforcer = new IdentityEnforcer({ enforcementMode: 'enforce' });
        var unsigned = { from: 'archivist', to: 'kernel', body: 'no sig', id: 'test-unsigned' };
        var result = enforcer.enforceMessage(unsigned);
        assert(!result.authenticated, 'unsigned message not authenticated');
        assert(result.decision === 'reject', 'unsigned message rejected (got ' + result.decision + ')');
    } catch (e) {
        assert(false, 'enforcer test failed: ' + e.message);
    }
}

function testEnforcerLookupArchivedKeys() {
    console.log('\n--- Enforcer archived key lookup ---');
    var enforcerPath = path.join(LANE_ROOT, 'scripts/identity-enforcer.js');
    if (!fs.existsSync(enforcerPath)) {
        console.log(' SKIP: identity-enforcer.js not found');
        return;
    }

    try {
        var IdentityEnforcer = require(enforcerPath).IdentityEnforcer;
        var enforcer = new IdentityEnforcer({ enforcementMode: 'enforce' });

        var trustStore = loadTrustStore();
        var archivedKeys = trustStore.archived_keys || {};
        var keyIds = Object.keys(archivedKeys);
        for (var i = 0; i < keyIds.length; i++) {
            var keyId = keyIds[i];
            var archived = archivedKeys[keyId];
            var result = enforcer._getPublicKeyByKeyId(keyId);
            assert(!!result, 'enforcer finds archived key ' + keyId + ' (' + archived.lane_id + ')');
            assert(result && result.archived === true, 'enforcer marks ' + keyId + ' as archived');
            assert(result && result.publicKey && result.publicKey.indexOf('BEGIN PUBLIC KEY') !== -1, 'enforcer returns valid PEM for ' + keyId);
        }
    } catch (e) {
        assert(false, 'enforcer archived key lookup failed: ' + e.message);
    }
}

function main() {
    console.log('========================================');
    console.log('CI Signing Integrity Test Suite');
    console.log('Time: ' + new Date().toISOString());
    console.log('Node: ' + process.version);
    console.log('LANE_ROOT: ' + LANE_ROOT);
    console.log('Trust store: ' + TRUST_STORE_PATH);
    console.log('NOTE: Keyless CI mode (no .identity/ required)');
    console.log('========================================');

    testAlgorithmParams();
    testRsaBackwardCompatibility();
    testTrustStoreEd25519KeysPresent();
    testTrustStoreArchivedKeysValid();
    testTrustStoreRotationPolicyPresent();
    testTrustStoreKeyLineagePresent();
    testEnforcerRejectsUnsigned();
    testEnforcerLookupArchivedKeys();

    console.log('\n========================================');
    console.log('RESULTS: ' + passed + ' passed, ' + failed + ' failed');
    if (failures.length > 0) {
        console.log('FAILURES:');
        for (var f = 0; f < failures.length; f++) {
            console.log(' - ' + failures[f]);
        }
    }
    console.log('========================================');

    process.exit(failed > 0 ? 1 : 0);
}

main();
