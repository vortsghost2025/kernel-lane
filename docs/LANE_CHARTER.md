# Lane Charter

## Mission
Deliver fast, reproducible CUDA kernels with strict evidence before promotion.

## Hard Rules
1. No direct edits to non-kernel-lane repos from this lane.
2. No release promotion without benchmark + Nsight evidence.
3. Every promoted version must be immutable and pinned.
4. Prefer deterministic benchmark inputs and fixed seeds.
5. Regression against previous baseline blocks promotion.

## Success Criteria
- Build reproducibility
- Measured speedup or justified tradeoff
- No correctness regressions
- Complete release manifest
