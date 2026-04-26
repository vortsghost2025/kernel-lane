#!/usr/bin/env node
'use strict';
/**
 * run-compact-with-audit.js
 * Wrapper to execute the compact workflow (placeholder) and then run the post-compact audit.
 * It aborts with a non‑zero exit code only if the audit status is 'conflicted',
 * indicating a hard failure that should stop further processing.
 * On success it emits a concise JSON summary to STDOUT for quick triage.
 */

const { PostCompactAudit } = require('./post-compact-audit');
const path = require('path');
const fs = require('fs');

// Placeholder for actual compact operation – replace with real logic when ready.
async function performCompact() {
  console.log('[compact] Starting placeholder compact operation...');
  // TODO: Implement the real compact workflow (e.g., data pruning, artifact generation).
  // This stub simulates a short delay for now.
  await new Promise((res) => setTimeout(res, 500));
  console.log('[compact] Placeholder compact completed.');
}

(async () => {
  try {
    await performCompact();
    const audit = new PostCompactAudit();
    const result = audit.run();

    // Emit concise structured summary
    const summary = {
      status: result.status,
      contradictions: result.diff.unexpected_changes,
      message_loss: result.diff.message_loss,
      trust_chain_intact: result.diff.trust_chain_intact,
      constraints_intact: result.diff.constraints_intact,
      governance_intact: result.diff.governance_intact,
      bootstrap_intact: result.diff.bootstrap_intact,
      risk_set_preserved: result.diff.risk_set_preserved,
      file_integrity_violations: result.diff.file_integrity_violations || []
    };
    console.log(JSON.stringify(summary, null, 2));

    // Exit code: 0 for all statuses except 'conflicted'
    if (result.status === 'conflicted') {
      console.error('[compact] Audit reported CONFLICTED – aborting.');
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('[compact] Fatal error:', err);
    process.exit(2);
  }
})();
