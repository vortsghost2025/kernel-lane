#!/usr/bin/env node
/**
 * register-archivist-key.js - Register Archivist's public key in trust store
 */

const path = require('path');
const { KeyManager } = require('../src/attestation/KeyManager');
const { TrustStoreManager } = require('../src/attestation/TrustStoreManager');

function main() {
	const passphrase = process.env.LANE_KEY_PASSPHRASE;
	if (!passphrase) {
		console.error('ERROR: LANE_KEY_PASSPHRASE not set');
		process.exit(1);
	}

	const km = new KeyManager({
		identityDir: path.join(__dirname, '..', '.identity'),
		laneId: 'archivist'
	});

	const result = km.initialize(passphrase);
	console.log('Key ID:', result.keyId);
	console.log('Generated:', result.generated || false);

	const info = km.exportForTrustStore();

	const tsm = new TrustStoreManager({
		trustStorePath: path.join(__dirname, '..', '.trust', 'keys.json')
	});

	tsm.registerKey('archivist', info.public_key_pem, info.key_id);

	console.log('\nArchivist key registered in trust store');
	console.log('Key ID:', info.key_id);
	console.log('Registered at:', info.registered_at);
	console.log('\nPublic key (first 80 chars):', info.public_key_pem.substring(0, 80) + '...');

	const stats = tsm.getStats();
	console.log('\nTrust store stats:', JSON.stringify(stats, null, 2));
}

main();
