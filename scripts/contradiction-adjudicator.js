#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOMAIN_CLASSIFIERS = [
  { pattern: /\.(rs|js|ts|py|go|java|c|cpp|h|sh|bat|ps1)$/i, domain: 'code' },
  { pattern: /\.(pdf|tex|ipynb)$/i, domain: 'paper' },
  { pattern: /\.(json|yaml|yml|csv|tsv|xml|sql|db)$/i, domain: 'data' },
  { pattern: /\.(md|txt|rst|adoc)$/i, domain: 'paper' },
  { pattern: /\.(html|css|jsx|vue|svelte)$/i, domain: 'code' },
  { pattern: /test|spec|bench|feature/i, domain: 'code' },
  { pattern: /docs?|readme|guide|tutorial/i, domain: 'paper' },
  { pattern: /config|schema|migration|seed/i, domain: 'data' },
];

const CONTRADICTS_TYPES = ['contradicts', 'contradiction', 'conflicts_with', 'conflict'];

function normalizeEdgeType(value) {
  return String(value || '').trim().toLowerCase();
}

function isContradictsType(type) {
  return CONTRADICTS_TYPES.includes(normalizeEdgeType(type));
}

function classifyDomain(node) {
  const title = String((node && (node.title || node.label || node.name)) || '').toLowerCase();
  const sourcePath = String((node && (node.source_path || node.artifact_path || node.path)) || '').toLowerCase();
  for (const classifier of DOMAIN_CLASSIFIERS) {
    if (classifier.pattern.test(title) || classifier.pattern.test(sourcePath)) {
      return classifier.domain;
    }
  }
  return 'data';
}

function computeHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function hashFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return computeHash(content);
  } catch (_) {
    return null;
  }
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function extractNodes(doc) {
  if (Array.isArray(doc)) return { nodes: doc, edges: [] };
  return {
    nodes: (doc && doc.nodes) || [],
    edges: (doc && doc.edges) || (doc && doc.relationships) || []
  };
}

function buildNodeIndex(nodes) {
  const index = {};
  for (const node of nodes) {
    const id = String(node.id || node.node_id || '');
    if (id) index[id] = node;
  }
  return index;
}

function extractContradictsEdges(edges) {
  return edges.filter(e => {
    const type = normalizeEdgeType(e.type || e.relationship || e.kind || e.label || '');
    return isContradictsType(type);
  });
}

function gatherEvidence(node, repoRoot) {
  const evidence = { quote_or_hash: '', artifact_path: '' };
  const sourcePath = (node && (node.source_path || node.artifact_path || node.path)) || '';
  if (sourcePath) {
    const absPath = path.isAbsolute(sourcePath) ? sourcePath : path.join(repoRoot, sourcePath);
    evidence.artifact_path = sourcePath;
    const fileHash = hashFile(absPath);
    if (fileHash) evidence.quote_or_hash = fileHash;
  }
  if (node && (node.summary || node.description || node.body)) {
    const text = String(node.summary || node.description || node.body);
    evidence.quote_or_hash = evidence.quote_or_hash || computeHash(text);
  }
  if (!evidence.quote_or_hash) {
    evidence.quote_or_hash = computeHash(JSON.stringify(node));
  }
  return evidence;
}

function adjudicateEdge(edge, sourceNode, targetNode, nodeIndex, repoRoot) {
  const sourceId = String(edge.source || edge.from || '');
  const targetId = String(edge.target || edge.to || '');

  const sNode = sourceNode || nodeIndex[sourceId] || {};
  const tNode = targetNode || nodeIndex[targetId] || {};

  const sourceDomain = classifyDomain(sNode);
  const targetDomain = classifyDomain(tNode);
  const domain = sourceDomain === targetDomain ? sourceDomain : 'data';

  const evidenceSource = gatherEvidence(sNode, repoRoot);
  const evidenceTarget = gatherEvidence(tNode, repoRoot);

  let adjudicationStatus = 'needs_lane_review';
  let notes = '';

  const sTitle = String(sNode.title || sNode.label || sNode.name || sourceId).toLowerCase();
  const tTitle = String(tNode.title || tNode.label || tNode.name || targetId).toLowerCase();

  const sVerification = String(sNode.verification_status || sNode.status || '').toLowerCase();
  const tVerification = String(tNode.verification_status || tNode.status || '').toLowerCase();

  const sContradictionCount = Number(sNode.contradictionCount || sNode.contradiction_count || 0);
  const tContradictionCount = Number(tNode.contradictionCount || tNode.contradiction_count || 0);

  const sDepth = Number(sNode.depth || sNode.authority || 0);
  const tDepth = Number(tNode.depth || tNode.authority || 0);

  if (sContradictionCount >= 39 && tContradictionCount === 0) {
    adjudicationStatus = 'proven_spurious';
    notes = 'Source is K(40)+ tag-group artifact (contradictionCount >= 39, target has 0). Pattern matches known artifact clustering false positive.';
  } else if (tContradictionCount >= 39 && sContradictionCount === 0) {
    adjudicationStatus = 'proven_spurious';
    notes = 'Target is K(40)+ tag-group artifact (contradictionCount >= 39, source has 0). Pattern matches known artifact clustering false positive.';
  } else if (sVerification === 'unverified' && tVerification === 'verified') {
    adjudicationStatus = 'proven_spurious';
    notes = 'Source UNVERIFIED vs target VERIFIED. Unverified node cannot sustain contradiction against verified.';
  } else if (tVerification === 'unverified' && sVerification === 'verified') {
    adjudicationStatus = 'proven_spurious';
    notes = 'Target UNVERIFIED vs source VERIFIED. Unverified node cannot sustain contradiction against verified.';
  } else if (sTitle === tTitle && sourceDomain === targetDomain) {
    adjudicationStatus = 'proven_spurious';
    notes = 'Identical titles in same domain — likely duplicate node, not real contradiction.';
  } else if (sDepth >= 80 && tDepth < 20) {
    adjudicationStatus = 'needs_lane_review';
    notes = 'High authority disparity (source >> target). Requires lane review to determine if low-authority node is stale artifact.';
  } else if (tDepth >= 80 && sDepth < 20) {
    adjudicationStatus = 'needs_lane_review';
    notes = 'High authority disparity (target >> source). Requires lane review to determine if low-authority node is stale artifact.';
  } else if (sContradictionCount > 0 && tContradictionCount > 0) {
    adjudicationStatus = 'needs_lane_review';
    notes = 'Both nodes have non-zero contradictionCount. Bilateral review required — cannot auto-resolve.';
  } else {
    adjudicationStatus = 'needs_lane_review';
    notes = 'No automated adjudication rule matched. Manual review required per CONTRADICTION_RESOLUTION_PLAYBOOK.';
  }

  return {
    edge_id_or_path: edge.id || `${sourceId}->${targetId}`,
    source_node_id: sourceId,
    target_node_id: targetId,
    domain: domain,
    evidence_source: evidenceSource,
    evidence_target: evidenceTarget,
    adjudication_status: adjudicationStatus,
    next_action_owner: adjudicationStatus === 'needs_lane_review' ? guessOwner(sNode, tNode) : 'archivist',
    notes: notes,
    metadata: {
      source_verification: sVerification,
      target_verification: tVerification,
      source_contradiction_count: sContradictionCount,
      target_contradiction_count: tContradictionCount,
      source_depth: sDepth,
      target_depth: tDepth
    }
  };
}

function guessOwner(sNode, tNode) {
  const sRepo = String((sNode && (sNode.repo || sNode.repository || sNode.lane)) || '').toLowerCase();
  const tRepo = String((tNode && (tNode.repo || tNode.repository || tNode.lane)) || '').toLowerCase();
  if (sRepo.includes('kernel') || tRepo.includes('kernel')) return 'kernel';
  if (sRepo.includes('library') || tRepo.includes('library')) return 'library';
  if (sRepo.includes('swarmmind') || tRepo.includes('swarmmind')) return 'swarmmind';
  return 'archivist';
}

class ContradictionAdjudicator {
  constructor(options) {
    const opts = (options || {});
    this.repoRoot = opts.repoRoot || path.resolve(__dirname, '..');
    this.dryRun = opts.dryRun !== undefined ? !!opts.dryRun : true;
    this.snapshotPaths = opts.snapshotPaths || [];
    this.outputPath = opts.outputPath || null;
    this.adjudications = [];
    this.stats = { total_edges: 0, proven_spurious: 0, proven_conflict: 0, needs_lane_review: 0, skipped: 0, errors: 0 };
  }

  loadSnapshots() {
    const allNodes = [];
    const allEdges = [];

    const defaultDir = path.join(this.repoRoot, 'docs', 'graph', 'snapshots');
    const libDir = path.join(this.repoRoot, '..', 'self-organizing-library', 'docs', 'graph', 'snapshots');
    const dirs = [defaultDir, libDir];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir).filter(e => e.endsWith('.json'));
      for (const ent of entries) {
        const fp = path.join(dir, ent);
        const read = readJsonSafe(fp);
        if (!read.ok) {
          this.stats.errors++;
          continue;
        }
        const doc = read.value;
        const extracted = extractNodes(doc);
        allNodes.push.apply(allNodes, extracted.nodes);
        allEdges.push.apply(allEdges, extracted.edges);
      }
    }

    for (const sp of this.snapshotPaths) {
      const read = readJsonSafe(sp);
      if (!read.ok) {
        this.stats.errors++;
        continue;
      }
      const doc = read.value;
      const extracted = extractNodes(doc);
      allNodes.push.apply(allNodes, extracted.nodes);
      allEdges.push.apply(allEdges, extracted.edges);
    }

    return { nodes: allNodes, edges: allEdges };
  }

  run() {
    const data = this.loadSnapshots();
    const contradictsEdges = extractContradictsEdges(data.edges);
    this.stats.total_edges = contradictsEdges.length;

    if (contradictsEdges.length === 0) {
      return this._emitReport();
    }

    const nodeIndex = buildNodeIndex(data.nodes);

    for (const edge of contradictsEdges) {
      try {
        const record = adjudicateEdge(edge, null, null, nodeIndex, this.repoRoot);
        this.adjudications.push(record);

        if (record.adjudication_status === 'proven_spurious') {
          this.stats.proven_spurious++;
        } else if (record.adjudication_status === 'proven_conflict') {
          this.stats.proven_conflict++;
        } else if (record.adjudication_status === 'needs_lane_review') {
          this.stats.needs_lane_review++;
        } else {
          this.stats.skipped++;
        }
      } catch (err) {
        this.stats.errors++;
      }
    }

    return this._emitReport();
  }

  _emitReport() {
    const report = {
      timestamp: new Date().toISOString(),
      dry_run: this.dryRun,
      stats: Object.assign({}, this.stats),
      adjudications: this.adjudications
    };

    if (this.outputPath) {
      const dir = path.dirname(this.outputPath);
      if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      }
      fs.writeFileSync(this.outputPath, JSON.stringify(report, null, 2), 'utf8');
    }

    return report;
  }
}

function parseArgs(argv) {
  const out = { dryRun: true, outputPath: null, snapshots: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') { out.dryRun = false; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--output' && argv[i + 1]) { out.outputPath = String(argv[++i]); continue; }
    if (a === '--snapshot' && argv[i + 1]) { out.snapshots.push(String(argv[++i])); continue; }
    if (a === '--repo-root' && argv[i + 1]) { out.repoRoot = String(argv[++i]); continue; }
  }
  return out;
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const adjudicator = new ContradictionAdjudicator({
    repoRoot: args.repoRoot || path.resolve(__dirname, '..'),
    dryRun: args.dryRun,
    snapshotPaths: args.snapshots,
    outputPath: args.outputPath
  });

  const report = adjudicator.run();

  console.log(`[contradiction-adjudicator] edges=${report.stats.total_edges} proven_spurious=${report.stats.proven_spurious} proven_conflict=${report.stats.proven_conflict} needs_review=${report.stats.needs_lane_review} errors=${report.stats.errors}`);
  console.log(`[contradiction-adjudicator] dry_run=${report.dry_run}`);

  if (args.outputPath) {
    console.log(`[contradiction-adjudicator] report written to ${args.outputPath}`);
  }

  if (report.adjudications.length > 0 && report.adjudications.length <= 20) {
    for (const adj of report.adjudications) {
      const mark = adj.adjudication_status === 'proven_spurious' ? 'SPURIOUS' : adj.adjudication_status === 'proven_conflict' ? 'CONFLICT' : 'REVIEW';
      console.log(`  [${mark}] ${adj.source_node_id} -> ${adj.target_node_id} (${adj.domain}) owner=${adj.next_action_owner}`);
      if (adj.notes) console.log(`    ${adj.notes}`);
    }
  }
}

if (require.main === module) {
  runCli().catch(err => { console.error(`[contradiction-adjudicator] FATAL: ${err.message}`); process.exit(1); });
}

module.exports = { ContradictionAdjudicator, adjudicateEdge, classifyDomain, isContradictsType };
