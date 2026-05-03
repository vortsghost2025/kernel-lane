'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { executionWeight } = require('./execution-weight');

const ROOT = 'S:/kernel-lane';
const OUT_DIR = path.join(ROOT, 'context-buffer');

function usage() {
  console.log('Usage: node scripts/analyze-graph-json.js <graph-json-path>');
}

function normalizeStatus(value) {
  if (!value) return 'unknown';
  const raw = String(value).trim().toLowerCase();
  if (raw.includes('conflict')) return 'conflicted';
  if (raw.includes('quarant')) return 'quarantined';
  if (raw.includes('unver') || raw.includes('unprov')) return 'unverified';
  if (raw.includes('verif') || raw.includes('prov')) return 'verified';
  if (raw.includes('block')) return 'blocked';
  if (raw.includes('resolv')) return 'resolved';
  return raw;
}

function safeReadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickNodes(doc) {
  if (Array.isArray(doc)) return doc;
  const candidates = [
    doc.nodes,
    doc.graph && doc.graph.nodes,
    doc.data && doc.data.nodes,
    doc.snapshot && doc.snapshot.nodes,
    doc.elements && doc.elements.nodes
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function pickEdges(doc) {
  if (Array.isArray(doc)) return [];
  const candidates = [
    doc.edges,
    doc.graph && doc.graph.edges,
    doc.data && doc.data.edges,
    doc.snapshot && doc.snapshot.edges,
    doc.elements && doc.elements.edges
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function pickFindings(doc) {
  if (Array.isArray(doc)) return [];
  return toArray(doc.findings);
}

function extractNodeStatus(node) {
  const direct = node.status || node.state || node.verdict || node.phase;
  if (direct) return normalizeStatus(direct);

  const nested = node.meta || node.metadata || node.props || node.properties || {};
  const nestedRaw = nested.status || nested.state || nested.verdict || nested.phase;
  return normalizeStatus(nestedRaw);
}

function extractNodeId(node, idx) {
  return String(
    node.id ||
      node.node_id ||
      node.uuid ||
      node.key ||
      `node_${idx + 1}`
  );
}

function extractNodeLabel(node, idx) {
  return String(
    node.label ||
      node.title ||
      node.name ||
      node.claim ||
      node.text ||
      `Node ${idx + 1}`
  );
}

function buildStatusCounts(nodes) {
  const counts = {
    conflicted: 0,
    quarantined: 0,
    unverified: 0,
    verified: 0,
    blocked: 0,
    resolved: 0,
    unknown: 0
  };

  const detailed = nodes.map((node, idx) => {
    const status = extractNodeStatus(node);
    if (!Object.prototype.hasOwnProperty.call(counts, status)) {
      counts.unknown += 1;
    } else {
      counts[status] += 1;
    }
    const weight = executionWeight({ ...node, status });
    const meta = node.metadata || node.meta || node.props || node.properties || {};
    const probe = node.probe || node.runtime_probe || node.runtime || {};
    const inputs = { status, meta, probe };
    const reasonParts = [];
    if (meta && meta.critical) reasonParts.push('critical');
    if (probe && probe.lastInvoked) reasonParts.push('recent_invocation');
    if (probe && probe.invokeCount) reasonParts.push('invoke_count');
    const reason = reasonParts.length ? reasonParts.join(', ') : 'base_status';
    return {
      id: extractNodeId(node, idx),
      label: extractNodeLabel(node, idx),
      status,
      weight,
      execution_weight: weight,
      execution_weight_reason: reason,
      execution_weight_inputs: inputs,
      execution_weight_generated_at: new Date().toISOString()
    };
  });

  return { counts, detailed };
}

function countContradictionEdges(edges) {
  const contradictionTypes = new Set([
    'contradicts',
    'contradiction',
    'conflicts_with',
    'conflict'
  ]);

  return edges.filter((edge) => {
    const rel = String(
      edge.type ||
        edge.relationship ||
        edge.label ||
        edge.kind ||
        ''
    )
      .trim()
      .toLowerCase();
    return contradictionTypes.has(rel);
  }).length;
}

function topPriorityWork(detailed) {
  return detailed
    .filter((n) => n.status === 'conflicted' || n.status === 'blocked')
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 10);
}

function summarizeFindings(findings) {
  const priorities = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const statusCounts = {
    conflicted: 0,
    blocked: 0,
    unverified: 0,
    verified: 0,
    resolved: 0,
    unknown: 0
  };

  const normalized = findings.map((f, idx) => {
    const priority = String(f.priority || 'P3').toUpperCase();
    if (Object.prototype.hasOwnProperty.call(priorities, priority)) {
      priorities[priority] += 1;
    } else {
      priorities.P3 += 1;
    }
    const status = normalizeStatus(f.status);
    if (Object.prototype.hasOwnProperty.call(statusCounts, status)) {
      statusCounts[status] += 1;
    } else {
      statusCounts.unknown += 1;
    }
    return {
      id: String(f.finding_id || `finding_${idx + 1}`),
      label: String(f.observation || f.recommended_next_action || 'finding'),
      status,
      priority
    };
  });

  return { priorities, statusCounts, normalized };
}

function generateActionPlan(counts) {
  const actions = [];
  if (counts.conflicted > 0) {
    actions.push('Resolve one conflicted node before any new feature work.');
  }
  if (counts.blocked > 0) {
    actions.push('Keep one active blocker only; pause all non-blocker work.');
  }
  if (counts.unverified > 0) {
    actions.push('Convert top unverified claims into test cards with evidence paths.');
  }
  if (counts.conflicted === 0 && counts.blocked === 0) {
    actions.push('Run a maintenance pass: verify high-impact unverified nodes.');
  }
  return actions;
}

function writeOutputs(inputPath, payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `graph-auto-analysis-${stamp}`;
  const outJson = path.join(OUT_DIR, `${base}.json`);
  const outMd = path.join(OUT_DIR, `${base}.md`);

  fs.writeFileSync(outJson, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  const md = [
    '# Graph Auto Analysis',
    '',
    `Source: ${inputPath}`,
    `Generated: ${payload.output_provenance.generated_at}`,
    '',
    '## Counts',
    `- conflicted: ${payload.summary.conflicted}`,
    `- blocked: ${payload.summary.blocked}`,
    `- quarantined: ${payload.summary.quarantined}`,
    `- unverified: ${payload.summary.unverified}`,
    `- verified: ${payload.summary.verified}`,
    `- resolved: ${payload.summary.resolved}`,
    `- unknown: ${payload.summary.unknown}`,
    `- contradiction_edges: ${payload.summary.contradiction_edges}`,
    '',
    '## Next Actions',
    ...payload.next_actions.map((a) => `- ${a}`),
    '',
    '## Top Conflict/Blocker Nodes',
    ...(payload.focus_nodes.length > 0
      ? payload.focus_nodes.map((n) => `- ${n.id} | ${n.status} | ${n.label} | weight:${n.weight || 0}`)
      : ['- none']),
    '',
    '## Discipline Gate',
    '- No new feature work until one conflicted node is closed with evidence.'
  ].join('\n');

  fs.writeFileSync(outMd, md + '\n', 'utf8');
  return { outJson, outMd };
}

function main() {
  const input = process.argv[2];
  if (!input) {
    usage();
    process.exit(1);
  }

  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const rawContent = fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, '');
  const fileHash = crypto.createHash('sha256').update(rawContent).digest('hex');
  const doc = JSON.parse(rawContent);
  const nodes = pickNodes(doc);
  const edges = pickEdges(doc);
  const findings = pickFindings(doc);
  const { counts, detailed } = buildStatusCounts(nodes);
  const contradictionEdgeCount = countContradictionEdges(edges);
  const findingsSummary = summarizeFindings(findings);
  const focusNodes = nodes.length > 0
    ? topPriorityWork(detailed)
    : findingsSummary.normalized
        .filter((f) => f.priority === 'P0' || f.priority === 'P1')
        .slice(0, 10);
  const nextActions = generateActionPlan(counts);

  const payload = {
    output_provenance: {
      agent: 'codex-5.3',
      lane: 'kernel',
      generated_at: new Date().toISOString(),
      session_id: 'unknown'
    },
    source: {
      graph_json_path: inputPath,
      node_count: nodes.length,
      edge_count: edges.length,
      finding_count: findings.length,
      hash: fileHash
    },
    summary: {
      conflicted: counts.conflicted,
      blocked: counts.blocked,
      quarantined: counts.quarantined,
      unverified: counts.unverified,
      verified: counts.verified,
      resolved: counts.resolved,
      unknown: counts.unknown,
      contradiction_edges: contradictionEdgeCount
    },
    findings_summary: findings.length > 0 ? findingsSummary : null,
    focus_nodes: focusNodes,
    next_actions: nextActions
  };

  const outputs = writeOutputs(inputPath, payload);
  console.log(JSON.stringify(outputs, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  buildStatusCounts,
  executionWeight,
  topPriorityWork,
};