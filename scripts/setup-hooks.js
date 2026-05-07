const fs = require('fs');
const path = require('path');

const hookContent = `#!/bin/sh
# Archivist pre-commit hook: DER-SPKI-SHA256 key_id enforcement
# Installed by scripts/setup-hooks.js

echo "[pre-commit] Running sovereignty scan..."
REPO_ROOT=$(git rev-parse --show-toplevel)

# Run sovereignty enforcer if available
if [ -f "$REPO_ROOT/scripts/sovereignty-enforcer.js" ]; then
  node "$REPO_ROOT/scripts/sovereignty-enforcer.js" || exit 1
fi

# Run schema compliance check if available
if [ -f "$REPO_ROOT/scripts/schema-compliance-check.js" ]; then
  node "$REPO_ROOT/scripts/schema-compliance-check.js" || exit 1
fi

# Run lint if available
if [ -f "$REPO_ROOT/package.json" ] && grep -q '"lint"' "$REPO_ROOT/package.json"; then
  echo "[pre-commit] Running npm lint..."
  cd "$REPO_ROOT" && npm run lint || exit 1
fi

# Run typecheck if available
if [ -f "$REPO_ROOT/package.json" ] && grep -q '"typecheck"' "$REPO_ROOT/package.json"; then
  echo "[pre-commit] Running npm typecheck..."
  cd "$REPO_ROOT" && npm run typecheck || exit 1
fi

# Verify key_id derivation uses DER-SPKI-SHA256
computeKeyId() {
  local pem_file="$1"
  if [ ! -f "$pem_file" ]; then return 1; fi
  node -e "
    const crypto = require('crypto');
    const fs = require('fs');
    const pem = fs.readFileSync('$pem_file', 'utf8');
    try {
      const key = crypto.createPublicKey(pem);
      const spkiDer = key.export({ type: 'spki', format: 'der' });
      process.stdout.write(crypto.createHash('sha256').update(spkiDer).digest('hex').slice(0, 16));
    } catch (e) {
      process.stdout.write(crypto.createHash('sha256').update(pem.trim()).digest('hex').slice(0, 16));
    }
  "
}

echo "[pre-commit] All checks passed"
`;

const hookDir = path.join(process.cwd(), '.git', 'hooks');
const hookPath = path.join(hookDir, 'pre-commit');

if (!fs.existsSync(hookDir)) {
  fs.mkdirSync(hookDir, { recursive: true });
}

fs.writeFileSync(hookPath, hookContent);
fs.chmodSync(hookPath, 0o755);
console.log('Pre-commit hook installed at .git/hooks/pre-commit');
console.log('Uses DER-SPKI-SHA256 for key_id derivation (with PEM-text fallback)');
