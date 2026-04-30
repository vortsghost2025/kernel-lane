#!/usr/bin/env node
/**
 * Pre-send validator + signing wrapper.
 * Usage: node sign-with-prevalidation.js <message.json> [--lane <lane>] [--force]
 */
const { execSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node sign-with-prevalidation.js <message.json> [--lane <lane>] [--force]');
  process.exit(1);
}

const messagePath = args[0];
const laneIdx = args.indexOf('--lane');
const lane = laneIdx !== -1 ? args[laneIdx + 1] : null;
const force = args.includes('--force');

try {
  const validatorPath = path.join(__dirname, 'pre-send-validator.js');
  execSync(`node ${validatorPath} ${messagePath}`, { stdio: 'inherit' });
} catch (e) {
  console.error('[sign-with-prevalidation] PRE‑SEND VALIDATION FAILED');
  process.exit(1);
}

try {
  const signerPath = path.join(__dirname, 'sign-outbox-message.js');
  const signArgs = ['--message', messagePath];
  if (lane) { signArgs.push('--lane', lane); }
  if (force) { signArgs.push('--force'); }
  execSync(`node ${signerPath} ${signArgs.join(' ')}`, { stdio: 'inherit' });
} catch (e) {
  console.error('[sign-with-prevalidation] SIGNING FAILED');
  process.exit(1);
}
