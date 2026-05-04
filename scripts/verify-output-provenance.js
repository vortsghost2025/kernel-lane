"use strict";

const fs = require("fs");
const path = require("path");
const { verifyOutputProvenance } = require("./output-provenance");

function usage() {
  console.log("Usage: node scripts/verify-output-provenance.js <file>");
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    usage();
    process.exit(2);
  }

  const resolved = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(resolved)) {
    console.error(JSON.stringify({
      status: "FORMAT_VIOLATION",
      reason: "File not found",
      file: resolved
    }, null, 2));
    process.exit(2);
  }

  const content = fs.readFileSync(resolved, "utf8");
  const result = verifyOutputProvenance(content);
  const payload = {
    status: result.status,
    ok: result.ok,
    missing: result.missing,
    file: resolved
  };

  console.log(JSON.stringify(payload, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

