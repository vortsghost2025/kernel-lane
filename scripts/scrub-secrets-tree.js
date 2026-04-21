// Git history scrubber — removes JWS signatures and PEM keys from committed JSON files
// Called by: git filter-branch --tree-filter "node scripts/scrub-secrets-tree.js"
const fs = require('fs');
const path = require('path');

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
        let changed = false;

        // Scrub JWS signatures
        if (msg.signature && typeof msg.signature === 'string' && msg.signature.startsWith('eyJ')) {
          msg.signature = 'REF:' + entry.name.replace('.json', '.jws');
          msg.signature_ref = entry.name.replace('.json', '.jws');
          changed = true;
        }

        // Scrub public_key_pem (trust-store.json format)
        if (msg.public_key_pem && typeof msg.public_key_pem === 'string' && msg.public_key_pem.includes('BEGIN PUBLIC KEY')) {
          delete msg.public_key_pem;
          msg.public_key_path = msg.lane_id ? msg.lane_id + '-public.pem' : 'unknown-public.pem';
          msg.public_key_ref = 'see .identity/public.pem on respective lane';
          changed = true;
        }

        // Scrub nested lane entries (trust-store format)
        for (const [key, val] of Object.entries(msg)) {
          if (val && typeof val === 'object' && !Array.isArray(val) && val.public_key_pem && val.public_key_pem.includes('BEGIN PUBLIC KEY')) {
            delete val.public_key_pem;
            val.public_key_path = (val.lane_id || key) + '-public.pem';
            val.public_key_ref = 'see .identity/public.pem on respective lane';
            changed = true;
          }
        }

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
    let changed = false;
    for (const [key, val] of Object.entries(msg)) {
      if (val && typeof val === 'object' && val.public_key_pem) {
        delete val.public_key_pem;
        val.public_key_path = (val.lane_id || key) + '-public.pem';
        val.public_key_ref = 'see .identity/public.pem on respective lane';
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(rootTs, JSON.stringify(msg, null, 2), 'utf8');
  } catch(e) {}
}
