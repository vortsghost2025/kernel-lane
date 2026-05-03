# Execution Weight Helper

## Purpose

`execution-weight.js` provides a deterministic weight for graph nodes to prioritize execution‑critical items. It is used by analysis scripts (e.g., `analyze-graph-json.js`) to sort conflicted/blocked nodes.

## Weight Factors

- **Base status weight** (higher for more urgent statuses)
  - conflicted: 10
  - blocked: 8
  - unverified: 6
  - verified: 4
  - resolved: 2
  - unknown: 1
- **Additional signals**
  - `critical: true` in any metadata‑like container adds **+5**
  - Invocation count (any numeric field) adds **+0 – +5** (capped at 5)
  - Recent invocation timestamps add **+3** (within 24 h) or **+1** (within a week)

## Supported Node Shapes

Metadata may appear in `metadata`, `meta`, `properties`, or `props`. Invocation data may be top‑level, nested under those objects, or under `probe`, `runtime_probe`, or `runtime`.

## Integration Steps for Other Lanes

1. Add `const { executionWeight } = require('../shared-scripts/execution-weight');` (adjust relative path as needed).
2. Apply `executionWeight(node)` when building detailed node lists.
3. Use the returned weight for sorting or prioritisation.

## Testing

Run the provided test suite:
```
node path/to/test-execution-weight.js
```
All tests should pass.
