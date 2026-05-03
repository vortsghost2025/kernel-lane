const fs = require("fs");
const path = require("path");

const SITE_INDEX_PATH = "S:/self-organizing-library/data/site-index.json";
const HISTORICAL_SNAPSHOT_DIR = "S:/kernel-lane/evidence/graph-snapshots";

const VERIFICATION_TAGS = new Set(["Verification", "Attestation", "Identity Enforcement", "Convergence Gate"]);
const SIGNING_TAGS = new Set(["Attestation", "Identity Enforcement"]);
const EXECUTION_TAGS = new Set(["Kernel", "Swarmmind", "Multi-Agent"]);
const GOVERNANCE_TAGS = new Set(["Governance", "Constitutional AI", "Covenant", "Constraint Lattice"]);
const CONTRADICTION_TAGS = new Set(["Failure Mode", "Drift"]);

const DERIVATION_CATEGORIES = new Set(["verification", "attestation", "governance", "spec", "paper"]);
const VERIFICATION_CATEGORIES = new Set(["verification", "attestation", "audit"]);
const QUARANTINE_CATEGORIES = new Set(["scratch", "pending", "sensitive"]);
const CODE_TYPES = new Set(["code", "config"]);

const CONSTITUTIONAL_CATEGORIES = new Set(["governance", "verification", "attestation", "spec"]);
const OPERATIONAL_CATEGORIES = new Set(["code", "scripts", "config"]);
const THEORETICAL_TAGS = new Set(["Rosetta Stone", "CAISC", "Constraint Lattice", "paper"]);
const EVIDENCE_CATEGORIES = new Set(["verification", "audit", "test-data"]);
const HISTORICAL_CATEGORIES = new Set(["scratch", "pending"]);
const GAME_CATEGORIES = new Set(["game", "uss-chaosbringer", "uss_chaosbringer"]);
const LANE_REPOS = new Set(["self-organizing-library", "Archivist-Agent", "SwarmMind", "SwarmMind-Self-Optimizing-Multi-Agent-AI-System", "kernel-lane"]);

const FREEAGENT_SUBCATEGORY_MAP = {
  medical: "application_adjacent", we4free: "application_adjacent", we: "application_adjacent",
  distributed: "operational", infrastructure: "operational", "shared-infra": "operational",
  "connection-bridge": "operational", ui: "application_adjacent", data: "evidence",
  docs: "theoretical", agent: "operational", coordination: "operational", project: "operational",
  game: "application_adjacent", "phase-6": "theoretical", scratch: "historical",
  config: "operational", public_html: "application_adjacent", log: "historical",
  script: "operational", orchestrator: "operational",
};

const REPO_AUTHORITY_DEPTH = {
  "Archivist-Agent": 95, "self-organizing-library": 90, SwarmMind: 80,
  "SwarmMind-Self-Optimizing-Multi-Agent-AI-System": 80, "kernel-lane": 75,
  federation: 50, FreeAgent: 40, "Deliberate-AI-Ensemble": 60, storytime: 30, papers: 70,
};

function hasAnyTag(tags, tagSet) {
  return tags.some((t) => tagSet.has(t));
}

function computeGovernanceLayer(entry) {
  if (LANE_REPOS.has(entry.repo) && CONSTITUTIONAL_CATEGORIES.has(entry.category)) return "constitutional";
  if (LANE_REPOS.has(entry.repo) && OPERATIONAL_CATEGORIES.has(entry.category)) return "operational";
  if (entry.category === "paper" || hasAnyTag(entry.tags, THEORETICAL_TAGS)) return "theoretical";
  if (EVIDENCE_CATEGORIES.has(entry.category)) return "evidence";
  if (HISTORICAL_CATEGORIES.has(entry.category)) return "historical";
  if (GAME_CATEGORIES.has(entry.category)) return "application_adjacent";
  if (entry.repo === "FreeAgent") return FREEAGENT_SUBCATEGORY_MAP[entry.category] || "application_adjacent";
  if (entry.repo === "federation") {
    if (OPERATIONAL_CATEGORIES.has(entry.category) || entry.category === "code" || entry.category === "script") return "operational";
    if (entry.category === "docs" || entry.category === "root-doc") return "theoretical";
    if (GAME_CATEGORIES.has(entry.category)) return "application_adjacent";
    return "operational";
  }
  if (entry.repo === "Deliberate-AI-Ensemble") {
    if (entry.category === "governance" || entry.category === "architecture") return "constitutional";
    if (entry.category === "paper" || entry.category === "drift" || entry.category === "resilience") return "theoretical";
    return "operational";
  }
  if (entry.repo === "storytime") return "application_adjacent";
  if (entry.repo === "papers") return "theoretical";
  return "unknown";
}

function computeAuthorityEdges(entries, crossRefs, tagIndex) {
  const entryMap = new Map();
  for (const e of entries) entryMap.set(e.id, e);

  const edges = [];
  const seen = new Set();

  const addEdge = (source, target, authority) => {
    const key = `${source}:${target}:${authority}`;
    if (seen.has(key)) return;
    if (!entryMap.has(source) || !entryMap.has(target)) return;
    seen.add(key);
    edges.push({ source, target, authority });
  };

  for (const ref of crossRefs) {
    const src = entryMap.get(ref.source);
    if (!src) continue;
    if (hasAnyTag(src.tags, VERIFICATION_TAGS) && VERIFICATION_CATEGORIES.has(src.category)) {
      addEdge(ref.source, ref.target, "VERIFIES");
    } else if (hasAnyTag(src.tags, SIGNING_TAGS) && src.category === "attestation") {
      addEdge(ref.source, ref.target, "SIGNED_BY");
    } else if (hasAnyTag(src.tags, EXECUTION_TAGS) && CODE_TYPES.has(src.content_type)) {
      addEdge(ref.source, ref.target, "EXECUTES");
    } else if (hasAnyTag(src.tags, CONTRADICTION_TAGS)) {
      addEdge(ref.source, ref.target, "CONTRADICTS");
    } else if (DERIVATION_CATEGORIES.has(src.category)) {
      addEdge(ref.source, ref.target, "DERIVES_FROM");
    } else {
      addEdge(ref.source, ref.target, "DEPENDS_ON");
    }
  }

  const TAG_GROUP_CAP = 40;
  const TAG_GROUP_LARGE_SAMPLE = 15;

  const tagPairs = [];
  for (const [tag, ids] of Object.entries(tagIndex)) {
    let filteredIds = ids.filter((id) => entryMap.has(id));
    if (filteredIds.length < 2) continue;
    if (filteredIds.length > TAG_GROUP_CAP) {
      const stride = Math.max(1, Math.floor(filteredIds.length / TAG_GROUP_LARGE_SAMPLE));
      const sampled = [];
      for (let i = 0; i < filteredIds.length; i += stride) {
        sampled.push(filteredIds[i]);
        if (sampled.length >= TAG_GROUP_LARGE_SAMPLE) break;
      }
      filteredIds = sampled;
    }
    const idSet = new Set(filteredIds);
    if (idSet.size < 2) continue;
    tagPairs.push([tag, idSet]);
  }

  for (const [tag, idSet] of tagPairs) {
    const ids = [...idSet];
    const MAX_PAIR_EDGES = 20;
    let pairEdgeCount = 0;

    if (VERIFICATION_TAGS.has(tag)) {
      for (let i = 0; i < ids.length && pairEdgeCount < MAX_PAIR_EDGES; i++) {
        for (let j = i + 1; j < ids.length && pairEdgeCount < MAX_PAIR_EDGES; j++) {
          addEdge(ids[i], ids[j], "VERIFIES");
          addEdge(ids[j], ids[i], "VERIFIES");
          pairEdgeCount++;
        }
      }
    } else if (CONTRADICTION_TAGS.has(tag)) {
      for (let i = 0; i < ids.length && pairEdgeCount < MAX_PAIR_EDGES; i++) {
        for (let j = i + 1; j < ids.length && pairEdgeCount < MAX_PAIR_EDGES; j++) {
          addEdge(ids[i], ids[j], "CONTRADICTS");
          addEdge(ids[j], ids[i], "CONTRADICTS");
          pairEdgeCount++;
        }
      }
    } else if (SIGNING_TAGS.has(tag)) {
      for (let i = 0; i < ids.length && pairEdgeCount < MAX_PAIR_EDGES; i++) {
        for (let j = i + 1; j < ids.length && pairEdgeCount < MAX_PAIR_EDGES; j++) {
          addEdge(ids[i], ids[j], "SIGNED_BY");
          addEdge(ids[j], ids[i], "SIGNED_BY");
          pairEdgeCount++;
        }
      }
    } else if (EXECUTION_TAGS.has(tag)) {
      for (let i = 0; i < ids.length && pairEdgeCount < MAX_PAIR_EDGES; i++) {
        for (let j = i + 1; j < ids.length && pairEdgeCount < MAX_PAIR_EDGES; j++) {
          addEdge(ids[i], ids[j], "EXECUTES");
          addEdge(ids[j], ids[i], "EXECUTES");
          pairEdgeCount++;
        }
      }
    } else if (GOVERNANCE_TAGS.has(tag)) {
      for (let i = 0; i < ids.length && pairEdgeCount < MAX_PAIR_EDGES; i++) {
        for (let j = i + 1; j < ids.length && pairEdgeCount < MAX_PAIR_EDGES; j++) {
          addEdge(ids[i], ids[j], "DERIVES_FROM");
          addEdge(ids[j], ids[i], "DERIVES_FROM");
          pairEdgeCount++;
        }
      }
    }
  }

  return edges;
}

function computeNodeStatuses(entries, authorityEdges) {
  const incomingVerifies = new Map();
  const incomingContradicts = new Map();

  for (const edge of authorityEdges) {
    if (edge.authority === "VERIFIES") {
      if (!incomingVerifies.has(edge.target)) incomingVerifies.set(edge.target, new Set());
      incomingVerifies.get(edge.target).add(edge.source);
    }
    if (edge.authority === "CONTRADICTS") {
      if (!incomingContradicts.has(edge.target)) incomingContradicts.set(edge.target, new Set());
      incomingContradicts.get(edge.target).add(edge.source);
      if (!incomingContradicts.has(edge.source)) incomingContradicts.set(edge.source, new Set());
      incomingContradicts.get(edge.source).add(edge.target);
    }
  }

  return entries.map((entry) => {
    const vCount = (incomingVerifies.get(entry.id) || new Set()).size;
    const cCount = (incomingContradicts.get(entry.id) || new Set()).size;

    let status = "UNVERIFIED";
    if (QUARANTINE_CATEGORIES.has(entry.category)) {
      status = "QUARANTINED";
    } else if (cCount > 0 && vCount >= 2) {
      status = "CONFLICTED";
    } else if (cCount > 0) {
      status = "CONFLICTED";
    } else if (vCount >= 2) {
      status = "VERIFIED";
    } else if (VERIFICATION_CATEGORIES.has(entry.category)) {
      status = "VERIFIED";
    } else if (hasAnyTag(entry.tags, VERIFICATION_TAGS)) {
      status = "VERIFIED";
    }

    return { id: entry.id, status, verificationCount: vCount, contradictionCount: cCount };
  });
}

function main() {
  console.log("=== KERNEL INDEPENDENT CONTRADICTION VERIFIER ===\n");
  console.log(`Data source: ${SITE_INDEX_PATH}`);
  console.log(`Timestamp: ${new Date().toISOString()}\n`);

  const rawIndex = JSON.parse(fs.readFileSync(SITE_INDEX_PATH, "utf-8"));
  const entries = rawIndex.entries;
  const crossRefs = rawIndex.cross_references;
  const tagIndex = rawIndex.tag_index;

  console.log(`Entries: ${entries.length}`);
  console.log(`Cross-references: ${crossRefs.length}`);
  console.log(`Tags in index: ${Object.keys(tagIndex).length}`);

  const repoStats = {};
  for (const e of entries) {
    repoStats[e.repo] = (repoStats[e.repo] || 0) + 1;
  }
  console.log("\nEntries by repo:");
  for (const [repo, count] of Object.entries(repoStats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${repo}: ${count}`);
  }

  const authorityEdges = computeAuthorityEdges(entries, crossRefs, tagIndex);
  console.log(`\nAuthority edges computed: ${authorityEdges.length}`);

  const edgeTypeCounts = {};
  for (const e of authorityEdges) {
    edgeTypeCounts[e.authority] = (edgeTypeCounts[e.authority] || 0) + 1;
  }
  console.log("Authority edge types:");
  for (const [type, count] of Object.entries(edgeTypeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  const nodeStatuses = computeNodeStatuses(entries, authorityEdges);

  const statusCounts = { VERIFIED: 0, UNVERIFIED: 0, CONFLICTED: 0, QUARANTINED: 0 };
  for (const ns of nodeStatuses) {
    statusCounts[ns.status]++;
  }
  console.log("\n=== INDEPENDENT RECOMPUTATION RESULTS ===");
  console.log(`Total nodes: ${nodeStatuses.length}`);
  console.log(`VERIFIED: ${statusCounts.VERIFIED}`);
  console.log(`UNVERIFIED: ${statusCounts.UNVERIFIED}`);
  console.log(`CONFLICTED: ${statusCounts.CONFLICTED}`);
  console.log(`QUARANTINED: ${statusCounts.QUARANTINED}`);

  const conflictedNodes = nodeStatuses
    .filter((n) => n.status === "CONFLICTED")
    .sort((a, b) => b.contradictionCount - a.contradictionCount);

  console.log(`\nTop-30 CONFLICTED nodes by contradictionCount:`);
  const entryMap = new Map();
  for (const e of entries) entryMap.set(e.id, e);

  const top30 = conflictedNodes.slice(0, 30).map((n) => {
    const entry = entryMap.get(n.id);
    return {
      rank: 0,
      title: entry?.title || "(unknown)",
      id: n.id,
      repo: entry?.repo || "?",
      governanceLayer: entry ? computeGovernanceLayer(entry) : "unknown",
      contradictionCount: n.contradictionCount,
      verificationCount: n.verificationCount,
    };
  });
  top30.forEach((n, i) => (n.rank = i + 1));
  for (const n of top30) {
    console.log(`  #${n.rank} [${n.repo}/${n.governanceLayer}] cc=${n.contradictionCount} vc=${n.verificationCount} ${n.title.slice(0, 60)}`);
  }

  const govLayerCounts = {};
  for (const ns of nodeStatuses) {
    const entry = entryMap.get(ns.id);
    const layer = entry ? computeGovernanceLayer(entry) : "unknown";
    if (!govLayerCounts[layer]) govLayerCounts[layer] = { VERIFIED: 0, UNVERIFIED: 0, CONFLICTED: 0, QUARANTINED: 0 };
    govLayerCounts[layer][ns.status]++;
  }
  console.log("\nStatus by governance layer:");
  for (const [layer, counts] of Object.entries(govLayerCounts).sort((a, b) => (b[1].CONFLICTED) - (a[1].CONFLICTED))) {
    console.log(`  ${layer}: CONFLICTED=${counts.CONFLICTED} VERIFIED=${counts.VERIFIED} UNVERIFIED=${counts.UNVERIFIED} QUARANTINED=${counts.QUARANTINED}`);
  }

  const repoConflictCounts = {};
  for (const ns of conflictedNodes) {
    const entry = entryMap.get(ns.id);
    const repo = entry?.repo || "?";
    repoConflictCounts[repo] = (repoConflictCounts[repo] || 0) + 1;
  }
  console.log("\nCONFLICTED nodes by repo:");
  for (const [repo, count] of Object.entries(repoConflictCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${repo}: ${count}`);
  }

  const contradictionEdgeCount = authorityEdges.filter((e) => e.authority === "CONTRADICTS").length;
  console.log(`\nTotal CONTRADICTS edges: ${contradictionEdgeCount}`);

  console.log("\n=== CROSS-CHECK AGAINST REPORTED COUNTS ===");
  const reportedCounts = { CONFLICTED: 199, QUARANTINED: 23 };
  const ourCounts = { CONFLICTED: statusCounts.CONFLICTED, QUARANTINED: statusCounts.QUARANTINED };
  const match = ourCounts.CONFLICTED === reportedCounts.CONFLICTED && ourCounts.QUARANTINED === reportedCounts.QUARANTINED;

  console.log(`Reported CONFLICTED: ${reportedCounts.CONFLICTED}, Independently computed: ${ourCounts.CONFLICTED}, Match: ${ourCounts.CONFLICTED === reportedCounts.CONFLICTED}`);
  console.log(`Reported QUARANTINED: ${reportedCounts.QUARANTINED}, Independently computed: ${ourCounts.QUARANTINED}, Match: ${ourCounts.QUARANTINED === reportedCounts.QUARANTINED}`);
  console.log(`\nOverall verification status: ${match ? "PROVEN - exact equality" : "UNPROVEN - mismatch detected"}`);

  const output = {
    verifier: "kernel-independent-contradiction-verifier",
    timestamp: new Date().toISOString(),
    data_source: SITE_INDEX_PATH,
    data_generated_at: rawIndex.generated_at,
    total_entries: entries.length,
    total_cross_refs: crossRefs.length,
    total_authority_edges: authorityEdges.length,
    authority_edge_type_counts: edgeTypeCounts,
    contradicts_edge_count: contradictionEdgeCount,
    independent_status_counts: statusCounts,
    reported_counts: reportedCounts,
    match_exact_equality: match,
    verification_status: match ? "proven" : "unproven",
    top_30_conflicted: top30,
    governance_layer_status_counts: govLayerCounts,
    repo_conflict_counts: repoConflictCounts,
    algorithm_notes: [
      "Exact replica of truth-routing.ts computeAuthorityEdges + computeNodeStatuses",
      "CONTRADICTS edges are bidirectional (both source and target get increment)",
      "Tag-group sampling: TAG_GROUP_CAP=40, TAG_GROUP_LARGE_SAMPLE=15, MAX_PAIR_EDGES=20",
      "QUARANTINED status by category only (scratch, pending, sensitive)",
      "CONFLICTED if contradictionCount > 0 regardless of verificationCount",
    ],
  };

  const outPath = `reports/kernel-independent-contradiction-verification-${Date.now()}.json`;
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nOutput written: ${outPath}`);

  const topNode = top30[0];
  if (topNode) {
    console.log(`\nTop contradiction node: "${topNode.title}" cc=${topNode.contradictionCount}`);
  }
}

main();
