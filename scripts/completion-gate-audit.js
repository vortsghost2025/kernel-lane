#!/usr/bin/env node
'use strict';

const fs = require("fs");
const path = require("path");

const TERMINAL_TYPES = new Set(["ack", "acknowledgment", "heartbeat", "notification", "response"]);

const COMPLETION_PROOF_FIELDS = ["completion_artifact_path", "completion_message_id", "resolved_by_task_id", "terminal_decision"];

function hasCompletionProof(msg) {
  if (typeof msg !== "object" || msg === null) return false;
  return COMPLETION_PROOF_FIELDS.some(function(field) {
    var val = msg[field];
    return val !== undefined && val !== null && val !== "" && val !== false;
  });
}

function hasFollowupObligation(msg) {
  if (typeof msg !== "object" || msg === null) return false;
  return !!(msg.depends_on || msg.creates_followup || msg.links_to_contradiction);
}

function isTerminalInformational(msg) {
  if (typeof msg !== "object" || msg === null) return false;
  if (msg.requires_action !== false) return false;
  var type = String(msg.type || "").toLowerCase().trim();
  if (!TERMINAL_TYPES.has(type)) return false;
  if (hasFollowupObligation(msg)) return false;
  return true;
}

function evaluate(msg) {
  if (typeof msg !== "object" || msg === null) {
    return { pass: false, reason: "INVALID_MESSAGE", detail: "Message is null or not an object" };
  }

  if (msg.requires_action === true) {
    if (hasCompletionProof(msg)) {
      return { pass: true, reason: "ACTIONABLE_WITH_PROOF", detail: null };
    }
    return {
      pass: false,
      reason: "ACTIONABLE_MISSING_PROOF",
      detail: "Actionable message (type=" + msg.type + ", priority=" + msg.priority + ") requires one of: " + COMPLETION_PROOF_FIELDS.join(", "),
    };
  }

  if (isTerminalInformational(msg)) {
    return { pass: true, reason: "TERMINAL_INFORMATIONAL", detail: null };
  }

  if (msg.requires_action === false && !TERMINAL_TYPES.has(String(msg.type || "").toLowerCase().trim())) {
    return {
      pass: false,
      reason: "NON_TERMINAL_TYPE",
      detail: "type=\"" + msg.type + "\" is not a terminal type. Terminal types: " + Array.from(TERMINAL_TYPES).join(", "),
    };
  }

  if (msg.requires_action === false && hasFollowupObligation(msg)) {
    return {
      pass: false,
      reason: "HAS_FOLLOWUP_OBLIGATION",
      detail: "Message has followup obligation (depends_on=" + !!msg.depends_on + ", creates_followup=" + !!msg.creates_followup + ", links_to_contradiction=" + !!msg.links_to_contradiction + ")",
    };
  }

  if (msg.requires_action === undefined || msg.requires_action === null) {
    return {
      pass: false,
      reason: "AMBIGUOUS_REQUIRES_ACTION",
      detail: "requires_action is " + msg.requires_action + " -- must be explicitly true or false",
    };
  }

  return {
    pass: false,
    reason: "UNKNOWN_FAILURE",
    detail: "Message does not meet any gate criteria (requires_action=" + msg.requires_action + ", type=" + msg.type + ")",
  };
}

var LANES = {
  archivist: { processed: "S:/Archivist-Agent/lanes/archivist/inbox/processed" },
  kernel: { processed: "S:/kernel-lane/lanes/kernel/inbox/processed" },
  library: { processed: "S:/self-organizing-library/lanes/library/inbox/processed" },
  swarmmind: { processed: "S:/SwarmMind/lanes/swarmmind/inbox/processed" },
};

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

(function main() {
  var summary = {
    timestamp: new Date().toISOString(),
    schema_version: "1.0",
    lanes: [],
    totals: {
      scanned: 0,
      passed: 0,
      blocked_count: 0,
      lifecycle_violations: 0,
      terminal_messages_verified: 0,
      actionable_with_proof: 0
    }
  };

  for (var ln of Object.keys(LANES)) {
    var cfg = LANES[ln];
    var result = {
      lane: ln,
      scanned: 0,
      passed: 0,
      blocked_count: 0,
      lifecycle_violations: [],
      terminal_messages_verified: 0,
      actionable_with_proof: 0
    };

    if (!fs.existsSync(cfg.processed)) {
      result.processed_ok = true;
      summary.lanes.push(result);
      continue;
    }

    var files = fs.readdirSync(cfg.processed).filter(function(f) { return f.endsWith(".json"); });
    result.scanned = files.length;

    for (var i = 0; i < files.length; i++) {
      var msg = safeReadJson(path.join(cfg.processed, files[i]));
      if (!msg) continue;

      var verdict = evaluate(msg);

      if (verdict.pass) {
        result.passed += 1;
        if (verdict.reason === "TERMINAL_INFORMATIONAL") {
          result.terminal_messages_verified += 1;
        } else if (verdict.reason === "ACTIONABLE_WITH_PROOF") {
          result.actionable_with_proof += 1;
        }
      } else {
        result.blocked_count += 1;
        result.lifecycle_violations.push({
          file: files[i],
          id: msg.id || msg.task_id || null,
          type: msg.type || null,
          priority: msg.priority || null,
          requires_action: msg.requires_action,
          reason: verdict.reason,
          detail: verdict.detail,
          subject: (msg.subject || "").substring(0, 80)
        });
      }
    }

    result.processed_ok = result.blocked_count === 0;

    summary.lanes.push(result);
    summary.totals.scanned += result.scanned;
    summary.totals.passed += result.passed;
    summary.totals.blocked_count += result.blocked_count;
    summary.totals.lifecycle_violations += result.lifecycle_violations.length;
    summary.totals.terminal_messages_verified += result.terminal_messages_verified;
    summary.totals.actionable_with_proof += result.actionable_with_proof;
  }

  summary.processed_ok = summary.totals.blocked_count === 0;

  console.log(JSON.stringify(summary, null, 2));

  if (summary.totals.blocked_count > 0) {
    process.exit(10);
  }
})();
