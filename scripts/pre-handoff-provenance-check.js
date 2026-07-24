#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function extractJsonObject(raw) {
  const firstBrace = raw.indexOf("{");
  if (firstBrace < 0) {
    throw new Error("No JSON object found");
  }

  const jsonText = raw.slice(firstBrace);
  return JSON.parse(jsonText);
}

function hasRequiredProv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .slice(0, 16)
    .map((s) => s.trim());

  return (
    lines[0] === "OUTPUT_PROVENANCE:" &&
    lines.some((l) => l.startsWith("agent:")) &&
    lines.some((l) => l.startsWith("lane:")) &&
    lines.some((l) => l.startsWith("generated_at:")) &&
    lines.some((l) => l.startsWith("session_id:"))
  );
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/pre-handoff-provenance-check.js <message-file>");
  process.exit(2);
}

const full = path.resolve(process.cwd(), file);
if (!fs.existsSync(full)) {
  console.error(`FAIL: file not found: ${full}`);
  process.exit(2);
}

const raw = fs.readFileSync(full, "utf8");

let msg;
try {
  msg = extractJsonObject(raw);
} catch (e) {
  console.error(`FAIL: invalid envelope/JSON: ${e.message}`);
  process.exit(1);
}

const body = typeof msg.body === "string" ? msg.body : JSON.stringify(msg.body ?? "");
if (!hasRequiredProv(body)) {
  console.error("FAIL: OUTPUT_PROVENANCE missing/incomplete in message.body");
  process.exit(1);
}

console.log("PASS: envelope parsed + OUTPUT_PROVENANCE valid in body");
