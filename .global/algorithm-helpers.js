#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const path = require('path');

const ALG_RSA = 'RS256';
const ALG_EDDSA = 'EdDSA';
const SIGN_ALG_RSA = 'RSA-SHA256';
const SIGN_ALG_EDDSA = null;

function getAlgorithmParams(privateKey) {
	const keyType = privateKey.asymmetricKeyType;
	if (keyType === 'ed25519') {
		return { alg: ALG_EDDSA, signAlg: SIGN_ALG_EDDSA };
	}
	if (keyType === 'rsa') {
		return { alg: ALG_RSA, signAlg: SIGN_ALG_RSA };
	}
	throw new Error(`UNKNOWN_KEY_TYPE: unsupported asymmetric key type '${keyType}'`);
}

function getAlgorithmParamsFromPem(privateKeyPem, passphrase) {
	let privateKey;
	if (passphrase) {
		privateKey = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem', passphrase });
	} else {
		privateKey = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem' });
	}
	return getAlgorithmParams(privateKey);
}

function getVerifyParams(publicKey) {
	const keyType = publicKey.asymmetricKeyType;
	if (keyType === 'ed25519') {
		return { alg: ALG_EDDSA, verifyAlg: SIGN_ALG_EDDSA };
	}
	if (keyType === 'rsa') {
		return { alg: ALG_RSA, verifyAlg: SIGN_ALG_RSA };
	}
	throw new Error(`UNKNOWN_KEY_TYPE: unsupported asymmetric key type '${keyType}'`);
}

function getVerifyParamsFromPem(publicKeyPem) {
	const publicKey = crypto.createPublicKey({ key: publicKeyPem, format: 'pem' });
	return getVerifyParams(publicKey);
}

function sign(signAlg, data, privateKey) {
	if (signAlg === null) {
		return crypto.sign(null, data, privateKey);
	}
	return crypto.sign(signAlg, data, privateKey);
}

function verify(verifyAlg, data, publicKeyInput, signature) {
	if (verifyAlg === null) {
		const keyObj = typeof publicKeyInput === 'string'
			? crypto.createPublicKey({ key: publicKeyInput, format: 'pem' })
			: publicKeyInput;
		return crypto.verify(null, data, keyObj, signature);
	}
	return crypto.verify(verifyAlg, data, publicKeyInput, signature);
}

function loadPrivateKey(privateKeyPem, passphrase) {
	if (passphrase) {
		return crypto.createPrivateKey({ key: privateKeyPem, format: 'pem', passphrase });
	}
	try {
		return crypto.createPrivateKey({ key: privateKeyPem, format: 'pem' });
	} catch (err) {
		if (err.message.includes('PEM decryption') || err.message.includes('unsupported') || err.message.includes('bad decrypt')) {
			throw new Error(`PRIVATE_KEY_DECRYPT_FAILED: key requires passphrase but none provided (${err.message})`);
		}
		throw err;
	}
}

function isPassphraseRequired(privateKeyPem) {
	return privateKeyPem.includes('ENCRYPTED');
}

function getAlgorithmForLane(trustStore, laneId) {
	const entry = (trustStore && trustStore[laneId]) || (trustStore && trustStore.keys && trustStore.keys[laneId]);
	if (!entry) {
		return ALG_RSA;
	}
	if (entry.algorithm === ALG_EDDSA || entry.algorithm === 'EdDSA') {
		return ALG_EDDSA;
	}
	return ALG_RSA;
}

function generateKeyPair(algorithm) {
	if (algorithm === 'ed25519' || algorithm === ALG_EDDSA) {
		return crypto.generateKeyPairSync('ed25519', {
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
		});
	}
	if (algorithm === 'rsa' || algorithm === ALG_RSA) {
		return crypto.generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: {
				type: 'pkcs8',
				format: 'pem',
				cipher: 'aes-256-cbc',
				passphrase: 'archivist-lane-key'
			}
		});
	}
	throw new Error(`UNKNOWN_ALGORITHM: '${algorithm}'. Use 'rsa' or 'ed25519'.`);
}

const SUPPORTED_ALGORITHMS = [ALG_RSA, ALG_EDDSA];

if (require.main === module) {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		console.log('algorithm-helpers.js - Shared algorithm detection utilities');
		console.log('');
		console.log('Supported algorithms:', SUPPORTED_ALGORITHMS.join(', '));
		console.log('');
		console.log('Usage:');
		console.log('  node algorithm-helpers.js detect <pem-file-path> [--passphrase <pass>]');
		console.log('  node algorithm-helpers.js generate <rsa|ed25519>');
		console.log('');
		console.log('Exported functions:');
		console.log('  getAlgorithmParams(privateKey) -> { alg, signAlg }');
		console.log('  getAlgorithmParamsFromPem(pem, passphrase) -> { alg, signAlg }');
		console.log('  getVerifyParams(publicKey) -> { alg, verifyAlg }');
		console.log('  getVerifyParamsFromPem(pem) -> { alg, verifyAlg }');
		console.log('  sign(signAlg, data, privateKey) -> Buffer');
		console.log('  verify(verifyAlg, data, publicKey, signature) -> boolean');
		console.log('  loadPrivateKey(pem, passphrase) -> KeyObject');
		console.log('  isPassphraseRequired(pem) -> boolean');
		console.log('  getAlgorithmForLane(trustStore, laneId) -> string');
		console.log('  generateKeyPair(algorithm) -> { publicKey, privateKey }');
		process.exit(0);
	}

	const command = args[0];

	if (command === 'detect') {
		const fs = require('fs');
		const pemPath = args[1];
		const passIdx = args.indexOf('--passphrase');
		const passphrase = passIdx !== -1 ? args[passIdx + 1] : null;

		if (!pemPath || !fs.existsSync(pemPath)) {
			console.error('Provide a valid PEM file path');
			process.exit(1);
		}

		const pem = fs.readFileSync(pemPath, 'utf8');
		const params = getAlgorithmParamsFromPem(pem, passphrase);
		console.log(JSON.stringify(params, null, 2));
	} else if (command === 'generate') {
		const algo = args[1];
		if (!algo || !['rsa', 'ed25519'].includes(algo)) {
			console.error('Specify algorithm: rsa or ed25519');
			process.exit(1);
		}
		const pair = generateKeyPair(algo);
		console.log('--- PUBLIC KEY ---');
		console.log(pair.publicKey);
		console.log('--- PRIVATE KEY ---');
		console.log(pair.privateKey);
	} else {
		console.error(`Unknown command: ${command}`);
		process.exit(1);
	}
}

module.exports = {
	getAlgorithmParams,
	getAlgorithmParamsFromPem,
	getVerifyParams,
	getVerifyParamsFromPem,
	sign,
	verify,
	loadPrivateKey,
	isPassphraseRequired,
	getAlgorithmForLane,
	generateKeyPair,
	SUPPORTED_ALGORITHMS,
	ALG_RSA,
	ALG_EDDSA,
	SIGN_ALG_RSA,
	SIGN_ALG_EDDSA
};
