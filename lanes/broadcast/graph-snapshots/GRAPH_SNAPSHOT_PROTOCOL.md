# Graph Snapshot Protocol v1

## Purpose
Live graph snapshots exported from the NexusGraph UI are the shared coordination surface for all lanes. Each lane analyzes the graph from its domain perspective, flags issues, and Library acts on resolved findings faster.

## Directory Structure
```
<lane>/evidence/graph-snapshots/    — Lane-local copies for analysis
lanes/broadcast/graph-snapshots/    — Shared visible to all lanes (in any repo)
```

## File Naming Convention
```
graph-snapshot-YYYY-MM-DDTHH-MM-SS-{variant}.json

Variants:
  full      — Raw export from UI (6+ MB, 44K edges)
  reduced   — Filtered: semantic + shared-tag≥3 only (~1 MB)
  analysis  — Analytical summary only (~12 KB, no edge arrays)
```

## Export Workflow
1. User exports snapshot from NexusGraph UI → Downloads folder
2. Kernel lane (or active session) copies to `evidence/graph-snapshots/` with proper naming
3. Kernel creates `reduced` and `analysis` variants using distillation script
4. All 3 variants distributed to:
   - `kernel-lane/evidence/graph-snapshots/`
   - `Archivist-Agent/evidence/graph-snapshots/`
   - `self-organizing-library/evidence/graph-snapshots/`
   - `SwarmMind/evidence/graph-snapshots/`
   - `lanes/broadcast/graph-snapshots/` (cross-lane visible)

## Lane Analysis Responsibilities
| Lane | Focus | What to Flag |
|------|-------|-------------|
| Kernel | Performance edges, contradiction artifacts, hub density | Nodes with cdc>0, authority/shared-tag bloat, disconnected clusters |
| Archivist | Schema compliance, governance coverage, verification gaps | Untagged nodes, missing status, orphan nodes |
| Library | Edge semantics, tag quality, graph structure | Bad link edges, tag normalization, missing cross-repo edges |
| SwarmMind | Agent coordination paths, broadcast reach | Isolated lanes, single-point-of-failure hubs, missing monitoring edges |

## Distillation Rules (full → reduced)
- **Keep all**: `link`, `paper-section-of`, `cross-paper-tag`, `cross-paper-dependency`
- **Keep**: `shared-tag` edges where nodes share ≥3 common tags
- **Keep**: `authority` edges only if cross-repo
- **Discard**: remaining `authority` and `shared-tag` (auto-generated co-occurrence noise)

## Known Issue: contradictionCount=39
Nodes with `contradictionCount=39` are a tag-group artifact from `truth-routing.ts`. When a CONTRADICTION_TAG has >80 members, stride-sampling reduces to 40, then K(40) complete graph gives each node 39 CONTRADICTS edges. These are **proven_spurious** — see `contradiction-batch-unified-merge-table-20260430.md`.

## Convergence Gate
After each snapshot analysis cycle, lanes send findings via inbox messages. When all lanes have reviewed, Kernel produces a unified snapshot health report with convergence gate status.
