// execution-weight.js – Compute execution weight for graph nodes

/**
 * Compute execution weight for a graph node.
 * The weight reflects how critical the node is for execution proof.
 * Factors:
 *   - status (conflicted > blocked > unverified > verified > resolved > unknown)
 *   - critical flag in metadata (adds extra weight)
 *   - presence of recent invocations (if ProbeRegistry provides data)
 *   - lastInvoked recency (more recent => higher weight)
 *
 * Returns a numeric weight (higher = higher priority).
 */
function executionWeight(node) {
  if (!node) return 0;
  const status = (node.status || 'unknown').toLowerCase();
  const meta = node.metadata || node.meta || node.properties || node.props || {};
  const probe = node.probe || node.runtime_probe || node.runtime || {};
  const statusWeights = {
    conflicted: 10,
    blocked: 8,
    unverified: 6,
    verified: 4,
    resolved: 2,
    unknown: 1,
  };
  let weight = statusWeights[status] || 1;

  // Critical metadata adds extra weight
  if (meta.critical) {
    weight += 5;
  }

  // Incorporate invocation count if present (cap contribution to avoid runaway weight)
  const invokeCount = firstNumber(
    node.invokeCount,
    node.invoke_count,
    meta.invokeCount,
    meta.invoke_count,
    probe.invokeCount,
    probe.invoke_count
  );
  if (invokeCount !== null) {
    weight += Math.min(invokeCount, 5);
  }

  // Factor recency of last invocation – recent calls are more important
  const lastInvoked = firstString(
    node.lastInvoked,
    node.last_invoked,
    meta.lastInvoked,
    meta.last_invoked,
    probe.lastInvoked,
    probe.last_invoked
  );
  if (lastInvoked) {
    const ts = Date.parse(lastInvoked);
    if (!Number.isNaN(ts)) {
      const ageHours = (Date.now() - ts) / (1000 * 60 * 60);
      if (ageHours < 24) weight += 3; // invoked within last day
      else if (ageHours < 168) weight += 1; // within a week
    }
  }

  return weight;
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

module.exports = { executionWeight };