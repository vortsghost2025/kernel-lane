#!/usr/bin/env node
'use strict';

const MIN_NODE_MAJOR = 18;
const MIN_NODE_MINOR = 0;

function check() {
  const parts = process.versions.node.split('.').map(Number);
  const major = parts[0] || 0;
  const minor = parts[1] || 0;

  if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
    console.error(`FATAL: Node v${process.version} is below minimum v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.`);
    console.error('Install Node v18+ via nvm: source ~/.nvm/nvm.sh && nvm use 20');
    process.exit(1);
  }

  return { major, minor, version: process.version };
}

function requireMinVersion(scriptPath) {
  const info = check();
  return info;
}

module.exports = { check, requireMinVersion };

if (require.main === module) {
  const info = check();
  console.log(`OK: Node v${info.version} meets minimum v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`);
}
