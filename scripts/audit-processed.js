#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const PROCESSED_DIR = path.join(__dirname, '..', 'lanes', 'kernel', 'inbox', 'processed');
const REOPENED_DIR = path.join(__dirname, '..', 'lanes', 'kernel', 'inbox', 'reopened');
const MANIFEST_PATH = path.join(__dirname, '..', 'lanes', 'kernel', 'inbox', 'false-processed-recovery-manifest-20260423.json');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

let falseProcessed = [];
let reviewed = [];

const files = fs.readdirSync(PROCESSED_DIR).filter(f => f.endsWith('.json'));

for (const file of files) {
  const filePath = path.join(PROCESSED_DIR, file);
  let msg;
  try { msg = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { continue; }

  if (msg.requires_action) {
    const hasProof = (msg.completion_artifact_path || msg.completion_message_id || msg.resolved_by_task_id || msg.terminal_decision);
    if (!hasProof) {
      falseProcessed.push(file);
      // Move to reopened/
      ensureDir(REOPENED_DIR);
      fs.copyFileSync(filePath, path.join(REOPENED_DIR, file));
      fs.unlinkSync(filePath);
    }
  }
  reviewed.push(file);
}

const manifest = {
  schema_version: "1.1",
  generated_at: new Date().toISOString(),
  description: `Audited ${reviewed.length} processed messages. Found ${falseProcessed.length} actionable messages lacking completion proof and restored them to reopened/.`,
  false_processed: falseProcessed,
  notes: falseProcessed.length ? "These messages were incorrectly marked processed. They have been moved to inbox/reopened/ for proper handling." : "No false-processed actionable messages found."
};

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log(`Audit complete: ${reviewed.length} reviewed, ${falseProcessed.length} restored.`);
console.log(`Manifest: ${MANIFEST_PATH}`);
