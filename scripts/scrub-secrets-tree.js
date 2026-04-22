// Git history scrubber — removes JWS signatures, PEM keys, and Ed25519 key pairs from committed JSON files
// Called by: git filter-branch --tree-filter "node 'S:/kernel-lane/scripts/scrub-secrets-tree.js'"
// MUST be called with ABSOLUTE PATH because filter-branch runs in a temp .git-rewrite/t/ directory
const fs = require('fs');
const path = require('path');

function scrubObject(obj, filename) {
  let changed = false;

  // Scrub JWS signatures (top-level)
  if (obj.signature && typeof obj.signature === 'string' && obj.signature.startsWith('eyJ')) {
    obj.signature = 'REF:' + filename.replace('.json', '.jws');
    obj.signature_ref = filename.replace('.json', '.jws');
    changed = true;
  }

  // Scrub public_key_pem (top-level, trust-store.json format)
  if (obj.public_key_pem && typeof obj.public_key_pem === 'string' && obj.public_key_pem.includes('BEGIN PUBLIC KEY')) {
    delete obj.public_key_pem;
    obj.public_key_path = obj.lane_id ? obj.lane_id + '-public.pem' : 'unknown-public.pem';
    obj.public_key_ref = 'see .identity/public.pem on respective lane';
    changed = true;
  }

  // Scrub Ed25519 public_key / private_key pairs (top-level)
  if (obj.public_key && typeof obj.public_key === 'string' && obj.public_key.includes('BEGIN PUBLIC KEY')) {
    delete obj.public_key;
    obj.public_key_path = obj.lane_id ? obj.lane_id + '-public.pem' : 'unknown-public.pem';
    obj.public_key_ref = 'see .identity/public.pem on respective lane';
    changed = true;
  }
  if (obj.private_key && typeof obj.private_key === 'string' && (obj.private_key.includes('BEGIN PRIVATE KEY') || obj.private_key.includes('BEGIN ENCRYPTED PRIVATE KEY'))) {
    delete obj.private_key;
    obj.private_key_ref = 'see .identity/private.pem on respective lane (never committed)';
    changed = true;
  }

  // Scrub nested lane entries (trust-store format, e.g. { archivist: { public_key_pem: ... } })
  for (const [key, val] of Object.entries(obj)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      // Nested public_key_pem
      if (val.public_key_pem && typeof val.public_key_pem === 'string' && val.public_key_pem.includes('BEGIN PUBLIC KEY')) {
        delete val.public_key_pem;
        val.public_key_path = (val.lane_id || key) + '-public.pem';
        val.public_key_ref = 'see .identity/public.pem on respective lane';
        changed = true;
      }
      // Nested Ed25519 public_key
      if (val.public_key && typeof val.public_key === 'string' && val.public_key.includes('BEGIN PUBLIC KEY')) {
        delete val.public_key;
        val.public_key_path = (val.lane_id || key) + '-public.pem';
        val.public_key_ref = 'see .identity/public.pem on respective lane';
        changed = true;
      }
      // Nested private_key
      if (val.private_key && typeof val.private_key === 'string' && (val.private_key.includes('BEGIN PRIVATE KEY') || val.private_key.includes('BEGIN ENCRYPTED PRIVATE KEY'))) {
        delete val.private_key;
        val.private_key_ref = 'see .identity/private.pem on respective lane (never committed)';
        changed = true;
      }
      // Recurse into deeper nesting (e.g. trust-store.keys.lane_id)
      if (!val.public_key_pem && !val.public_key && !val.private_key) {
        const nestedChanged = scrubObject(val, filename);
        if (nestedChanged) changed = true;
      }
    }
  }

  return changed;
}

function processDir(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return; }

  for (const entry of entries) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      processDir(fp);
    } else if (entry.name.endsWith('.json')) {
      try {
        const content = fs.readFileSync(fp, 'utf8');
        const msg = JSON.parse(content);
        const changed = scrubObject(msg, entry.name);
        if (changed) {
          fs.writeFileSync(fp, JSON.stringify(msg, null, 2), 'utf8');
        }
      } catch(e) { /* skip non-JSON or malformed files */ }
    }
  }
}

// Process lanes/ directory
processDir(path.join(process.cwd(), 'lanes'));

// Also handle root-level trust-store if it exists
const rootTs = path.join(process.cwd(), 'trust-store.json');
if (fs.existsSync(rootTs)) {
  try {
    const msg = JSON.parse(fs.readFileSync(rootTs, 'utf8'));
    const changed = scrubObject(msg, 'trust-store.json');
    if (changed) fs.writeFileSync(rootTs, JSON.stringify(msg, null, 2), 'utf8');
  } catch(e) {}
}
