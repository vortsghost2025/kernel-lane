#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..');
process.chdir(repoRoot);

function run(cmd) {
  try {
    const result = execSync(cmd, { encoding: 'utf8', cwd: repoRoot, stdio: 'pipe' });
    return result.trim();
  } catch (e) {
    const stderr = (e.stderr || '').trim();
    const stdout = (e.stdout || '').trim();
    throw new Error(`FAILED: ${cmd}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
}

function tryRun(cmd) {
  try { return run(cmd); } catch { return ''; }
}

console.log('kernel-lane safe commit & push');
console.log('='.repeat(60));

// 1. Branch
const branch = run('git branch --show-current');
console.log(`Branch: ${branch}`);

// 2. Ensure .trust/ is in .gitignore
const gitignorePath = path.join(repoRoot, '.gitignore');
let gitignore = fs.readFileSync(gitignorePath, 'utf8');
if (!gitignore.includes('.trust/')) {
  gitignore = gitignore.replace('.identity/', '.identity/\n.trust/');
  fs.writeFileSync(gitignorePath, gitignore, 'utf8');
  console.log('Added .trust/ to .gitignore');
} else {
  console.log('.trust/ already in .gitignore');
}

// 3. Untrack protected dirs if tracked
const trackedTrust = tryRun('git ls-files .trust/');
if (trackedTrust.trim()) {
  console.log(`Untracking .trust/ from git index: ${trackedTrust.replace(/\n/g, ', ')}`);
  tryRun('git rm --cached -r .trust/');
} else {
  console.log('.trust/ not tracked in git index');
}

const trackedIdentity = tryRun('git ls-files .identity/');
if (trackedIdentity.trim()) {
  console.log(`UNTRACKING .identity/ (SECRET RISK): ${trackedIdentity.replace(/\n/g, ', ')}`);
  tryRun('git rm --cached -r .identity/');
} else {
  console.log('.identity/ not tracked in git index');
}

// 4. Stage all
console.log('\nStaging all files...');
run('git add -A');

// 5. Show staged
const statusShort = run('git status --short');
console.log(`\nStaged files:\n${statusShort || '(none)'}\n`);

// 6. Scan for secrets
console.log('Scanning staged files for secrets...');
const stagedFiles = run('git diff --cached --name-only');
const fileList = stagedFiles.split('\n').filter(Boolean);
const SECRET_EXTS = ['.pem', '.key', '.jws', '.p12', '.pfx', '.env'];
const SECRET_PATTERNS = [
  /BEGIN\s+(RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY/,
  /BEGIN\s+ENCRYPTED\s+PRIVATE\s+KEY/,
  /BEGIN\s+PGP\s+PRIVATE\s+KEY\s+BLOCK/,
];
let secrets = [];
let warnings = [];

for (const file of fileList) {
  const ext = path.extname(file).toLowerCase();
  if (SECRET_EXTS.includes(ext)) {
    secrets.push({ file, reason: `Secret file extension: ${ext}` });
    continue;
  }
  if (file.startsWith('.identity/') || file.startsWith('.trust/')) {
    secrets.push({ file, reason: 'File in protected directory' });
    continue;
  }
  try {
    const content = run(`git show :"${file}"`);
    for (const p of SECRET_PATTERNS) {
      if (p.test(content)) {
        secrets.push({ file, reason: `Private key detected in content` });
        break;
      }
    }
    if (/BEGIN\s+PUBLIC\s+KEY/.test(content)) {
      warnings.push({ file, reason: 'Embedded public key (not secret but noteworthy)' });
    }
  } catch {}
}

// 7. Unstage secrets
if (secrets.length > 0) {
  console.log('\n!!! SECRETS FOUND - UNSTAGING !!!');
  for (const s of secrets) {
    console.log(`  UNSTAGING: ${s.file} - ${s.reason}`);
    tryRun(`git reset HEAD -- "${s.file}"`);
  }
} else {
  console.log('No secrets found.');
}

if (warnings.length > 0) {
  console.log('\nWarnings (public keys embedded in JSON - not secret):');
  for (const w of warnings) {
    console.log(`  ${w.file} - ${w.reason}`);
  }
}

// 8. Re-check
const stagedAfter = tryRun('git diff --cached --name-only');
if (!stagedAfter.trim()) {
  console.log('\nNothing to commit after secret scan. Exiting.');
  process.exit(0);
}

// 9. Commit
const msg = 'UBO fixes: .trust/keys.json key_id updated from stale b677eb87f6be83f9 to canonical d475d23aeed6c7b8, lane-worker systemd services stopped+disabled. _ubo_action';
console.log('\nCommitting...');
console.log(run(`git commit -m ${JSON.stringify(msg)}`));

// 10. Push
console.log(`\nPushing to origin/${branch}...`);
console.log(run(`git push origin ${branch}`));

// 11. Verify
const finalStatus = run('git status');
console.log(`\nFinal git status:\n${finalStatus}`);

// Summary
console.log('\n' + '='.repeat(60));
console.log('SUMMARY');
console.log('='.repeat(60));
console.log(`Branch: ${branch}`);
console.log(`Committed files:\n${stagedAfter.split('\n').filter(Boolean).map(f => `  - ${f}`).join('\n')}`);
console.log(`Secrets found: ${secrets.length > 0 ? secrets.map(s => `${s.file}: ${s.reason}`).join('; ') : 'NONE'}`);
console.log(`Warnings: ${warnings.length > 0 ? warnings.map(w => `${w.file}: ${w.reason}`).join('; ') : 'NONE'}`);
console.log(`Pushed to: origin/${branch}`);
console.log('='.repeat(60));
