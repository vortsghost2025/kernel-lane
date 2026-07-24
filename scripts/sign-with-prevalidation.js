#!/usr/bin/env node
/**
 * Pre-send validator + signing wrapper.
 * Usage: node sign-with-prevalidation.js <message.json> [--lane <lane>] [--force]
 * Runs pre-send-validator.js first; if successful, signs the message using
 * sign-outbox-message.js (which writes the signed JSON back to the same file).
 */
const { execSync } = require('child_process');
const path = require('path');

function usage() {
  console.error('Usage: node sign-with-prevalidation.js <message.json> [--lane <lane>] [--force]');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 1) usage();

const messagePath = args[0];
const laneIdx = args.indexOf('--lane');
const lane = laneIdx !== -1 ? args[laneIdx + 1] : null;
const force = args.includes('--force');

try {
  // Run pre‑send validation (will exit non‑zero on failure)
  const validatorPath = path.join(__dirname, 'pre-send-validator.js');
  execSync(`node ${validatorPath} ${messagePath}`, { stdio: 'inherit' });
} catch (e) {
  console.error('[sign-with-prevalidation] PRE‑SEND VALIDATION FAILED');
  process.exit(1);
}

// Validation succeeded – now sign the message
try {
  const signerPath = path.join(__dirname, 'sign-outbox-message.js');
  const signArgs = ['--message', messagePath];
  if (lane) {
    signArgs.push('--lane', lane);
  }
  if (force) {
    signArgs.push('--force');
  }
  execSync(`node ${signerPath} ${signArgs.join(' ')}`, { stdio: 'inherit' });
} catch (e) {
  console.error('[sign-with-prevalidation] SIGNING FAILED');
  process.exit(1);
}
