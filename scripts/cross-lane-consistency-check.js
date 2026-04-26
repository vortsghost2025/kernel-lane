const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const lanes = ['archivist', 'kernel', 'library', 'swarmmind'];
const roots = {
  archivist: 'S:/Archivist-Agent',
  kernel: 'S:/kernel-lane',
  library: 'S:/self-organizing-library',
  swarmmind: 'S:/SwarmMind'
};

console.log('=== CROSS-LANE CONSISTENCY CHECK ===\n');

// 1. Trust stores
console.log('1. TRUST STORES');
const trustHashes = {};
for (const lane of lanes) {
  const tsPath = path.join(roots[lane], 'lanes/broadcast/trust-store.json');
  const content = fs.readFileSync(tsPath, 'utf8');
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  trustHashes[lane] = hash;
  const ts = JSON.parse(content);
  const keyIds = Object.entries(ts).map(([k, v]) => k + ':' + v.key_id).join(', ');
  console.log('  ' + lane + ': hash=' + hash + ' | ' + keyIds);
}
const uniqueTrustHashes = [...new Set(Object.values(trustHashes))];
console.log('  Consistent: ' + (uniqueTrustHashes.length === 1 ? 'YES' : 'NO'));

// 2. Schema validators
console.log('\n2. SCHEMA VALIDATOR ENUMS');
const enumFields = [
  'execution.mode', 'execution.engine', 'execution.actor',
  'task_kind', 'artifact_type', 'type', 'priority'
];
for (const field of enumFields) {
  const values = {};
  for (const lane of lanes) {
    const svPath = path.join(roots[lane], 'src/lane/SchemaValidator.js');
    if (!fs.existsSync(svPath)) { values[lane] = 'NO_FILE'; continue; }
    const code = fs.readFileSync(svPath, 'utf8');
    // Find the line with this enum
    const escaped = field.replace('.', '\\.');
    const regex = new RegExp("'" + escaped + "'\\s*:\\s*\\[([^\\]]+)\\]");
    const match = code.match(regex);
    if (match) {
      values[lane] = match[1].replace(/\s/g, '').split(',').sort().join(',');
    } else {
      values[lane] = 'NOT_FOUND';
    }
  }
  const uniqueVals = [...new Set(Object.values(values))];
  const synced = uniqueVals.length === 1;
  console.log('  ' + field + ': ' + (synced ? 'SYNCED' : 'DIVERGED'));
  if (!synced) {
    for (const [lane, v] of Object.entries(values)) {
      console.log('    ' + lane + ': ' + v.slice(0, 100));
    }
  }
}

// 3. System state
console.log('\n3. SYSTEM STATE');
for (const lane of lanes) {
  const ssPath = path.join(roots[lane], 'lanes/broadcast/system_state.json');
  const ss = JSON.parse(fs.readFileSync(ssPath, 'utf8'));
  console.log('  ' + lane + ': status=' + ss.system_status +
    ' | contradictions=' + (ss.total_contradictions || 0) +
    ' | processed_ok=' + ss.processed_ok);
}

// 4. Shared script sizes
console.log('\n4. SHARED SCRIPT VERSIONS (by file size)');
const scripts = [
  'lane-worker.js', 'generic-task-executor.js', 'post-compact-audit.js',
  'create-signed-message.js', 'identity-enforcer.js', 'relay-daemon.js',
  'artifact-resolver.js', 'completion-proof.js', 'heartbeat.js'
];
for (const script of scripts) {
  const sizes = {};
  for (const lane of lanes) {
    const sPath = path.join(roots[lane], 'scripts', script);
    sizes[lane] = fs.existsSync(sPath) ? fs.statSync(sPath).size : 'MISSING';
  }
  const numSizes = Object.values(sizes).filter(v => typeof v === 'number');
  const allSame = numSizes.length > 0 && numSizes.every(v => v === numSizes[0]);
  const status = allSame ? 'SYNCED' : 'DIVERGED';
  console.log('  ' + script + ': ' + status);
  if (!allSame) {
    for (const [lane, size] of Object.entries(sizes)) {
      console.log('    ' + lane + ': ' + size);
    }
  }
}

// 5. .gitignore coverage
console.log('\n5. .IDENTITY IN .GITIGNORE');
for (const lane of lanes) {
  const giPath = path.join(roots[lane], '.gitignore');
  if (fs.existsSync(giPath)) {
    const gi = fs.readFileSync(giPath, 'utf8');
    console.log('  ' + lane + ': ' + (gi.includes('.identity') ? 'COVERED' : 'NOT COVERED'));
  } else {
    console.log('  ' + lane + ': NO .GITIGNORE');
  }
}

// 6. Key material in git history
console.log('\n6. PEM FILES IN GIT HISTORY');
for (const lane of lanes) {
  const root = roots[lane];
  try {
    const result = require('child_process').execSync(
      'git log --all --diff-filter=A --name-only --pretty=format: -- "*.pem" "*.key"',
      { cwd: root, encoding: 'utf8', timeout: 10000 }
    );
    const found = result.trim().split('\n').filter(l => l.trim());
    console.log('  ' + lane + ': ' + (found.length > 0 ? found.length + ' PEM/KEY files found' : 'CLEAN'));
    if (found.length > 0 && found.length <= 5) {
      found.forEach(f => console.log('    ' + f.trim()));
    }
  } catch (e) {
    console.log('  ' + lane + ': check failed');
  }
}

// 7. Quarantine/block audit
console.log('\n7. INBOX HYGIENE');
for (const lane of lanes) {
  const inboxBase = path.join(roots[lane], 'lanes', lane, 'inbox');
  const counts = {};
  for (const sub of ['', 'action-required', 'processed', 'blocked', 'quarantine']) {
    const dir = path.join(inboxBase, sub);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('heartbeat'));
      counts[sub || 'root'] = files.length;
    }
  }
  console.log('  ' + lane + ': root=' + (counts.root || 0) +
    ' ar=' + (counts['action-required'] || 0) +
    ' proc=' + (counts.processed || 0) +
    ' block=' + (counts.blocked || 0) +
    ' quar=' + (counts.quarantine || 0));
}

// 8. BOOTSTRAP.md consistency
console.log('\n8. BOOTSTRAP.MD CONSISTENCY');
const bootstrapHashes = {};
for (const lane of lanes) {
  const bpPath = path.join(roots[lane], 'BOOTSTRAP.md');
  if (fs.existsSync(bpPath)) {
    const content = fs.readFileSync(bpPath, 'utf8');
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    bootstrapHashes[lane] = hash;
  }
}
const uniqueBP = [...new Set(Object.values(bootstrapHashes))];
console.log('  Consistent: ' + (uniqueBP.length === 1 ? 'YES' : 'NO'));
if (uniqueBP.length > 1) {
  for (const [lane, h] of Object.entries(bootstrapHashes)) {
    console.log('    ' + lane + ': ' + h);
  }
}

console.log('\n=== END CONSISTENCY CHECK ===');
