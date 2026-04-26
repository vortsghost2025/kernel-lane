const crypto = require('crypto');
const fs = require('fs');

const idDir = 'S:/Archivist-Agent/.identity';
fs.mkdirSync(idDir, { recursive: true });

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
});

fs.writeFileSync('S:/Archivist-Agent/.identity/public.pem', publicKey);
fs.writeFileSync('S:/Archivist-Agent/.identity/private.pem', privateKey);

const keyId = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
console.log('Generated .identity/ directory with RSA-2048 keypair');
console.log('Public Key ID:', keyId);

const trustPath = 'S:/Archivist-Agent/lanes/broadcast/trust-store.json';
const trust = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
console.log('Trust store archivist key_id:', trust.archivist?.key_id);
console.log('Match:', trust.archivist?.key_id === keyId ? 'YES' : 'NO — update trust store to ' + keyId);