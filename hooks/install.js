#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_DIR = path.join(REPO_ROOT, 'hooks');
const GIT_HOOKS_DIR = path.join(REPO_ROOT, '.git', 'hooks');

const HOOKS_TO_INSTALL = [
  { src: 'pre-commit.js', dest: 'pre-commit' }
];

function detectLane() {
  const basename = path.basename(REPO_ROOT).toLowerCase();
  if (basename.includes('archivist')) return 'archivist';
  if (basename.includes('kernel')) return 'kernel';
  if (basename.includes('swarmmind') || basename.includes('swarm')) return 'swarmmind';
  if (basename.includes('library') || basename.includes('self-organizing')) return 'library';
  return 'unknown';
}

function installHooks(dryRun) {
  if (!fs.existsSync(GIT_HOOKS_DIR)) {
    if (dryRun) {
      console.log('[DRY RUN] Would create .git/hooks/ directory');
    } else {
      fs.mkdirSync(GIT_HOOKS_DIR, { recursive: true });
    }
  }

  const lane = detectLane();

  for (const hook of HOOKS_TO_INSTALL) {
    const srcPath = path.join(HOOKS_DIR, hook.src);
    const destPath = path.join(GIT_HOOKS_DIR, hook.dest);

    if (!fs.existsSync(srcPath)) {
      console.error('ERROR: Source hook not found: ' + srcPath);
      process.exit(1);
    }

    if (fs.existsSync(destPath)) {
      const existingContent = fs.readFileSync(destPath, 'utf8');
      const newContent = fs.readFileSync(srcPath, 'utf8');
      if (existingContent.trim() === newContent.trim()) {
        console.log('[install] ' + hook.dest + ' already up to date, skipping');
        continue;
      }
      const backupPath = destPath + '.bak';
      if (dryRun) {
        console.log('[DRY RUN] Would back up existing ' + hook.dest + ' to ' + backupPath);
      } else {
        fs.copyFileSync(destPath, backupPath);
        console.log('[install] Backed up existing ' + hook.dest + ' to ' + backupPath);
      }
    }

    if (dryRun) {
      console.log('[DRY RUN] Would copy ' + hook.src + ' -> .git/hooks/' + hook.dest);
      console.log('[DRY RUN] Would set permissions to 0o755');
    } else {
      fs.copyFileSync(srcPath, destPath);
      try { fs.chmodSync(destPath, 0o755); } catch (e) {
        console.warn('[install] Could not set execute permission (Windows OK): ' + e.message);
      }
      console.log('[install] Installed ' + hook.dest + ' (lane: ' + lane + ')');
    }
  }

  console.log('');
  console.log('Lane: ' + lane);
  console.log('Config: hooks/lane-config.json');
  console.log('');
  if (dryRun) {
    console.log('[DRY RUN] No files were modified');
  } else {
    console.log('[install] Done. Pre-commit hook is active.');
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-n');

installHooks(dryRun);
