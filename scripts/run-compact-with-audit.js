#!/usr/bin/env node
'use strict';
/**
 * run-compact-with-audit.js
 * Wrapper to execute the compact workflow and then run the post‑compact audit.
 * Implements a staged, crash‑safe compact sequence:
 *   1️⃣ Capture pre‑compact snapshot (already performed).
 *   2️⃣ Perform the compact operation.
 *   3️⃣ Restore critical files (trust store).
 *   4️⃣ **Stage A –** generate tamper‑evident handoff hash log.
 *   5️⃣ **Stage B –** run quick recovery tests (lane liveness) and write
 *      `RECOVERY_TEST_RESULTS.json`.
 *   6️⃣ **Stage C –** run the full post‑compact audit.
 *   7️⃣ Emit a concise JSON summary and exit with appropriate code.
 * The script updates `.compact-audit/meta.json` to track status and provide a
 * fallback flag if the compact is interrupted.
 */

const { PostCompactAudit } = require('./post-compact-audit');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Path to compact meta file (shared across runs)
const META_PATH = path.join('S:/Archivist-Agent/.compact-audit', 'meta.json');

/** Load or create meta object */
function loadMeta() {
  if (fs.existsSync(META_PATH)) {
    try { return JSON.parse(fs.readFileSync(META_PATH, 'utf8')); }
    catch (_) { return {}; }
  }
  return {};
}
/** Persist meta object */
function saveMeta(meta) {
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), 'utf8');
}
/** Mark compact as incomplete if an error occurs */
function markIncomplete(meta, reason, err) {
  meta.compact_status = 'incomplete';
  meta.fallback_attempted = true;
  meta.fallback_reason = reason;
  meta.fallback_error = err ? err.toString() : null;
  saveMeta(meta);
}

async function performCompact() {
  const compactCommand = process.env.COMPACT_COMMAND;
  if (compactCommand && compactCommand.trim()) {
    console.log(`[compact] Running COMPACT_COMMAND: ${compactCommand}`);
    execSync(compactCommand, { stdio: 'inherit' });
    console.log('[compact] COMPACT_COMMAND completed.');
    return;
  }

  // Safe fallback when no real compact command is configured.
  console.log('[compact] No COMPACT_COMMAND set; running placeholder compact operation...');
  await new Promise((res) => setTimeout(res, 500));
  console.log('[compact] Placeholder compact completed.');
}

function maybeRunExtraArchive() {
  const enabled = String(process.env.COMPACT_ARCHIVE || '').toLowerCase() === 'true';
  if (!enabled) return null;

  const scriptPath = 'S:/Archivist-Agent/scripts/compact-archive-extra.ps1';
  const manifestPath = 'S:/Archivist-Agent/.compact-audit/extra-archive.json';
  console.log('[compact] COMPACT_ARCHIVE=true -> running extra archive step...');
  execSync(`pwsh -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, { stdio: 'inherit' });

  if (fs.existsSync(manifestPath)) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      console.warn('[compact] Failed to parse extra archive manifest:', err.message);
    }
  }
  return null;
}

/** Stage B – quick recovery test (lane liveness) */
function runRecoveryTests(audit) {
  const laneStates = audit._getLaneHeartbeats();
  const total = Object.keys(laneStates).length;
  const alive = Object.values(laneStates).filter(s => s.status === 'alive').length;
  const passed = alive === total;
  const result = {
    tests_passed: alive,
    tests_total: total,
    lane_liveness: passed ? 'passed' : 'failed',
    overall: passed
  };
  const recPath = path.join(audit.auditDir, 'RECOVERY_TEST_RESULTS.json');
  fs.writeFileSync(recPath, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

(async () => {
  const meta = loadMeta();
  // Mark start of a new compact run
  meta.compact_status = 'running';
  meta.fallback_attempted = false;
  saveMeta(meta);

  try {
    // Capture pre‑compact state and backup critical files
    const preAudit = new PostCompactAudit();
    preAudit.capturePreCompact(); // writes PRE_COMPACT_SNAPSHOT.json
    const trustStorePath = preAudit.trustStorePath;
    const trustStoreBackup = fs.readFileSync(trustStorePath, 'utf8');

    await performCompact();
    const extraArchive = maybeRunExtraArchive();
    // Restore trust store to avoid unintended key changes
    fs.writeFileSync(trustStorePath, trustStoreBackup, 'utf8');

    // ---- Stage A: Tamper‑evident handoff hash log ----
    const audit = new PostCompactAudit();
    if (fs.existsSync(audit.handoffPath)) {
      const handoffContent = fs.readFileSync(audit.handoffPath, 'utf8');
      audit.generateTamperEvidentHandoff(handoffContent);
    } else {
      console.warn('[compact] No handoff file found – skipping hash log.');
    }

    // ---- Stage B: Recovery tests ----
    const recoveryResult = runRecoveryTests(audit);

    // ---- Stage C: Full post‑compact audit ----
    const postResult = audit.run();

    // ---- Emit concise summary ----
    const summary = {
      status: postResult.status,
      contradictions: postResult.diff.unexpected_changes,
      message_loss: postResult.diff.message_loss,
      trust_chain_intact: postResult.diff.trust_chain_intact,
      constraints_intact: postResult.diff.constraints_intact,
      governance_intact: postResult.diff.governance_intact,
      bootstrap_intact: postResult.diff.bootstrap_intact,
      risk_set_preserved: postResult.diff.risk_set_preserved,
      file_integrity_violations: postResult.diff.file_integrity_violations || [],
      recovery: recoveryResult,
      extra_archive: extraArchive
    };
    console.log(JSON.stringify(summary, null, 2));

    if (extraArchive) {
      const auditPath = path.join(audit.auditDir, 'POST_COMPACT_AUDIT.json');
      if (fs.existsSync(auditPath)) {
        try {
          const auditJson = JSON.parse(fs.readFileSync(auditPath, 'utf8').replace(/^\uFEFF/, ''));
          auditJson.extra_archive = extraArchive;
          fs.writeFileSync(auditPath, JSON.stringify(auditJson, null, 2) + '\n', 'utf8');
        } catch (err) {
          console.warn('[compact] Failed to append extra_archive to audit:', err.message);
        }
      }
    }

    // Update meta to idle (successful run)
    meta.compact_status = 'idle';
    meta.last_checkpoint_ts = Date.now();
    meta.last_handoff_hash = audit._hashFile(audit.handoffPath) || '';
    saveMeta(meta);

    // Exit code: 0 for all statuses except 'conflicted'
    if (postResult.status === 'conflicted') {
      console.error('[compact] Audit reported CONFLICTED – aborting.');
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('[compact] Fatal error:', err);
    // Mark incomplete in meta for fallback handling
    markIncomplete(meta, 'exception_during_compact', err);
    process.exit(2);
  }
})();
