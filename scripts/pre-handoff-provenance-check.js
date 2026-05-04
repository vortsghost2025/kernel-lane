"use strict";

const fs = require("fs");
const path = require("path");
const { verifyOutputProvenance } = require("./output-provenance");

function usage() {
  console.log("Usage: node scripts/pre-handoff-provenance-check.js <file1> [file2 ...]");
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    usage();
    process.exit(2);
  }

  const results = [];
  let hasFailure = false;

  for (const file of files) {
    const resolved = path.resolve(process.cwd(), file);
    if (!fs.existsSync(resolved)) {
      hasFailure = true;
      results.push({
        file: resolved,
        status: "FORMAT_VIOLATION",
        ok: false,
        reason: "File not found"
      });
      continue;
    }

    const content = fs.readFileSync(resolved, "utf8");
    const check = verifyOutputProvenance(content);
    if (!check.ok) hasFailure = true;
    results.push({
      file: resolved,
      status: check.status,
      ok: check.ok,
      missing: check.missing
    });
  }

  console.log(JSON.stringify({
    check: "pre-handoff-provenance",
    ok: !hasFailure,
    files_checked: results.length,
    results
  }, null, 2));

  process.exit(hasFailure ? 1 : 0);
}

if (require.main === module) {
  main();
}