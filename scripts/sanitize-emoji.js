#!/usr/bin/env node
/**
 * sanitize-emoji.js
 * Strips non-ASCII characters from all lane message JSON files.
 * Replaces emoji with ASCII equivalents (e.g. ✅ -> [OK], ❌ -> [FAIL], 📢 -> [BROADCAST]).
 * Adds format_violation: true to messages that were modified.
 *
 * Constraint: All system messages MUST be emitted in English (ASCII).
 * Non-English = format violation. Re-request in English. Do not process for state transitions.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EMOJI_MAP = {
  '\u2705': '[OK]',       // ✅
  '\u274C': '[FAIL]',     // ❌
  '\uD83D\uDCE1': '[SIGNAL]', // 📡
  '\uD83D\uDCE2': '[BROADCAST]', // 📢
  '\uD83C\uDF89': '[MILESTONE]', // 🎉
  '\uD83D\uDEA1': '[SHUTDOWN]', // 🛑
  '\uD83D\uDD07': '[SILENT]', // 🔇
  '\u26A0': '[WARN]',     // ⚠
  '\uD83D\uDD12': '[LOCK]', // 🔒
  '\u2B50': '[STAR]',     // ⭐
  '\uD83D\uDCCA': '[CHART]', // 📊
  '\uD83D\uDD0D': '[SEARCH]', // 🔍
  '\uD83D\uDE80': '[LAUNCH]', // 🚀
  '\uD83E\uDEE3': '[DONE]', // 🧣
};

function replaceNonASCII(str) {
  if (typeof str !== 'string') return str;
  let result = str;
  // Replace known emoji first
  for (const [emoji, ascii] of Object.entries(EMOJI_MAP)) {
    result = result.split(emoji).join(ascii);
  }
  // Replace any remaining non-ASCII with [?]
  result = result.replace(/[^\x00-\x7F]/g, '[?]');
  return result;
}

function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.endsWith('.json') && !entry.name.startsWith('heartbeat')) {
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const msg = JSON.parse(raw);
        let modified = false;
        for (const key of Object.keys(msg)) {
          if (typeof msg[key] === 'string') {
            const cleaned = replaceNonASCII(msg[key]);
            if (cleaned !== msg[key]) {
              msg[key] = cleaned;
              modified = true;
            }
          }
        }
        if (modified) {
          msg.format_violation = true;
          msg.sanitized_at = new Date().toISOString();
          msg.sanitization_reason = 'Non-ASCII characters replaced with ASCII equivalents per English-only constraint';
          fs.writeFileSync(full, JSON.stringify(msg, null, 2) + '\n', 'utf8');
          sanitizedCount++;
        }
      } catch (_) {}
    }
  }
}

const LANES = [
  'S:/Archivist-Agent/lanes',
  'S:/kernel-lane/lanes',
  'S:/self-organizing-library/lanes',
  'S:/SwarmMind/lanes',
];

let sanitizedCount = 0;
for (const lane of LANES) {
  walk(lane);
}
console.log('Sanitized: ' + sanitizedCount + ' messages');
console.log('All non-ASCII replaced with ASCII equivalents');
console.log('format_violation: true added to modified messages');
