#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

const LANES = [
  { name: 'archivist', root: 'S:/Archivist-Agent' },
  { name: 'library', root: 'S:/self-organizing-library' },
  { name: 'kernel', root: 'S:/kernel-lane' },
  { name: 'swarmmind', root: 'S:/SwarmMind' }
];

function runNodeScript(cwd, args) {
  return spawnSync('node', args, { cwd, encoding: 'utf8' });
}

function refreshHeartbeats() {
  const results = [];
  for (const lane of LANES) {
    const res = runNodeScript(lane.root, ['scripts/heartbeat.js', '--lane', lane.name, '--once']);
    results.push({
      lane: lane.name,
      ok: res.status === 0,
      status: res.status,
      stderr: (res.stderr || '').trim()
    });
  }
  return results;
}

function runRecoverySuite() {
  return runNodeScript('S:/Archivist-Agent', ['scripts/recovery-test-suite.js']);
}

function main() {
  const args = process.argv.slice(2);
  const withRecovery = args.includes('--with-recovery');

  console.log('=== RECOVERY PREFLIGHT ===');
  console.log('Refreshing heartbeats for all lanes...');
  const heartbeat = refreshHeartbeats();
  const failed = heartbeat.filter((r) => !r.ok);
  for (const r of heartbeat) {
    console.log(`- ${r.lane}: ${r.ok ? 'OK' : 'FAIL'}${r.stderr ? ` (${r.stderr})` : ''}`);
  }

  if (failed.length > 0) {
    console.log(`Heartbeat refresh failed for ${failed.length} lane(s).`);
    process.exit(1);
  }

  if (!withRecovery) {
    console.log('Preflight completed. Tip: pass --with-recovery to run recovery-test-suite automatically.');
    return;
  }

  console.log('\nRunning recovery-test-suite...');
  const rec = runRecoverySuite();
  if (rec.stdout) process.stdout.write(rec.stdout);
  if (rec.stderr) process.stderr.write(rec.stderr);

  if (rec.status !== 0) {
    console.log('\nPreflight finished, but recovery suite reported non-zero exit.');
    process.exit(rec.status || 1);
  }

  console.log('\nPreflight + recovery completed successfully.');
}

if (require.main === module) {
  main();
}
