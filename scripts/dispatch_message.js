#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

// Canonical inbox/outbox directories
const INBOX = "S:/kernel-lane/lanes/kernel/inbox";
const OUTBOX = "S:/kernel-lane/lanes/kernel/outbox";

function hasCompletionProof(msg) {
  // Completion proof is required: completed_at and completion_evidence fields must exist
  if (!msg.completed_at) return false;
  const evidence = msg.completion_evidence;
  if (!evidence) return false;
  if (!evidence.path || !evidence.hash) return false;
  return true;
}

function processMessage(file) {
  const content = fs.readFileSync(file, "utf8");
  const msg = JSON.parse(content);

  // Verify delivery flag before considering sent
  if (!msg.delivery_verification || !msg.delivery_verification.verified) {
    console.error(`[dispatch] Delivery not verified for ${path.basename(file)}`);
    return false;
  }

  // Enforce completion evidence for any action‑related message
  if (msg.type && ["task", "escalation", "request"].includes(String(msg.type).toLowerCase())) {
    if (!hasCompletionProof(msg)) {
      console.error(`[dispatch] Missing completion evidence for ${path.basename(file)}`);
      return false;
    }
  }

  // Write to outbox only if file exists (canonical check)
  const outPath = path.join(OUTBOX, path.basename(file));
  if (!fs.existsSync(path.dirname(outPath))) {
    console.error(`[dispatch] Outbox directory missing for ${outPath}`);
    return false;
  }

  fs.copyFileSync(file, outPath);
  console.log(`[dispatch] Message dispatched to outbox: ${outPath}`);
  return true;
}

// Process all messages in inbox
fs.readdirSync(INBOX).forEach(fn => {
  if (fn.endsWith(.json)) {
    const full = path.join(INBOX, fn);
    processMessage(full);
  }
});
