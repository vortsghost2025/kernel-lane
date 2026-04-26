const fs = require("fs");
const path = require("path");

const REPORT_PATH = path.resolve(__dirname, "..", "kernels", "benchmark_report.json");
const KERNEL_PATH = path.resolve(__dirname, "..", "kernels", "src", "matrix_tensor_optimized.cu");
const LOG_PATH = path.resolve(__dirname, "..", "debug-dca5de.log");
const runId = process.argv[2] || "run1";
const pendingLogs = [];

function logDebug(hypothesisId, location, message, data) {
  const payload = {
    sessionId: "dca5de",
    runId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  // #region agent log
  const req = fetch("http://127.0.0.1:7930/ingest/3d28abf0-3dd9-4b49-b4b7-c4f1e46cbb74", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "dca5de",
    },
    body: JSON.stringify(payload),
  }).catch(() => {});
  pendingLogs.push(req);
  try {
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(payload)}\n`, "utf8");
  } catch (_) {}
  // #endregion
}

function safeNumber(v) {
  if (typeof v !== "number") return Number(v);
  return v;
}

const report = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
const kernelSource = fs.existsSync(KERNEL_PATH) ? fs.readFileSync(KERNEL_PATH, "utf8") : "";

const baseline = report?.results?.["baseline-1warp"];
const padded = report?.results?.["padded-4warp"];
const async4 = report?.results?.["async-4warp"];

logDebug("H1", "scripts/debug-validate-benchmark-report.js:41", "Loaded benchmark report and evidence source", {
  reportPath: REPORT_PATH,
  kernelPathExists: fs.existsSync(KERNEL_PATH),
  reportKeys: Object.keys(report?.results || {}),
});

const baselineMs = safeNumber(baseline?.runtime_ms);
const paddedMs = safeNumber(padded?.runtime_ms);
const asyncMs = safeNumber(async4?.runtime_ms);
const paddedSpeedup = safeNumber(padded?.speedup);
const asyncSpeedup = safeNumber(async4?.speedup);
const paddedExpected = baselineMs / paddedMs;
const asyncExpected = baselineMs / asyncMs;

logDebug("H2", "scripts/debug-validate-benchmark-report.js:54", "Comparing reported speedups against runtime-derived speedups", {
  baselineMs,
  paddedMs,
  asyncMs,
  paddedReported: paddedSpeedup,
  asyncReported: asyncSpeedup,
  paddedExpected,
  asyncExpected,
  paddedDelta: Math.abs(paddedExpected - paddedSpeedup),
  asyncDelta: Math.abs(asyncExpected - asyncSpeedup),
});

const has4Warp = kernelSource.includes("WARPS_PER_BLOCK 4") || kernelSource.includes("WARPS_PER_BLOCK = 4");
const hasPadding = kernelSource.includes("HALF_PAD 1") && kernelSource.includes("WMMA_K + HALF_PAD");
const hasDoubleBuffer = kernelSource.includes("buf ^= 1");

logDebug("H3", "scripts/debug-validate-benchmark-report.js:70", "Checking kernel source for claimed optimizations", {
  has4Warp,
  hasPadding,
  hasDoubleBuffer,
  evidencePath: report?.evidence_path,
});

const hasMeasuredNcu =
  padded?.occupancy !== "Not measured" ||
  padded?.dram_bandwidth_gbs !== "Not measured" ||
  async4?.occupancy !== "Not measured" ||
  async4?.dram_bandwidth_gbs !== "Not measured";

logDebug("H4", "scripts/debug-validate-benchmark-report.js:82", "Checking if ncu metrics are present versus pending", {
  paddedOccupancy: padded?.occupancy,
  asyncOccupancy: async4?.occupancy,
  hasMeasuredNcu,
});

const referencedArtifacts = [
  path.resolve(__dirname, "..", "benchmarks", "reports", "gen4_benchmark_nfm.json"),
  path.resolve(__dirname, "..", "benchmarks", "reports", "gen4_nsight_nfm.json"),
];
const artifactExists = referencedArtifacts.map((p) => ({ path: p, exists: fs.existsSync(p) }));

logDebug("H5", "scripts/debug-validate-benchmark-report.js:96", "Checking for nearby benchmark/profiler artifact files", {
  artifactExists,
});

const verification = report?.verification || {};
const verificationStatusConsistent =
  verification.status === "partially_verified" &&
  verification.speedup_claim_verified === true &&
  verification.profiling_metrics_verified === false;

logDebug("H6", "scripts/debug-validate-benchmark-report.js:111", "Checking explicit verification-state semantics in report", {
  verification,
  verificationStatusConsistent,
});

Promise.allSettled(pendingLogs).finally(() => {
  console.log("Validation run complete.");
});
