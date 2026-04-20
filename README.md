# Kernel-Lane (Lane 4)

Kernel-Lane is the fourth isolated lane in the lattice.
Its role is hardware-focused: compile, profile, benchmark, and optimize CUDA kernels for your RTX 5060 stack.

It exists so GPU/performance work can move fast without destabilizing governance, verification, or orchestration lanes.

## How Lane 4 Fits the Other 3

| Lane | Primary Role | Output |
|---|---|---|
| Archivist | Governance and cross-lane arbitration | Decisions, routing, escalation |
| Library | Verification and attestation | Proof, hardening, validation |
| SwarmMind | Multi-agent behavior and execution strategies | Behavioral traces, coordination patterns |
| Kernel-Lane (this repo) | CUDA kernel performance engineering | Pinned release artifacts + perf evidence |

### Integration Contract

Kernel-Lane does not replace the first three lanes. It feeds them:

1. Archivist gets release decisions and promotion metadata.
2. Library gets benchmark/profile evidence for verification.
3. SwarmMind gets stable, pinned kernel artifacts to consume in runtime experiments.

## Mission

- Isolate GPU optimization from core governance/runtime lanes.
- Produce measurable performance improvements with reproducible evidence.
- Promote only immutable, pinned releases that other lanes can safely consume.

## Hard Boundaries

In scope:
- CUDA kernel source and compile flags
- Nsight Systems/Compute profiling
- Benchmark automation and regression checks
- Release packaging and manifests

Out of scope:
- Editing global Kilo/OpenCode routing config
- Cross-lane governance policy edits
- Direct runtime orchestration logic in other repos

## Upstream Source and Intake

- Primary intake source: `S:\snac-v2\kimi-shared`
- Intake pattern: copy/snapshot into this lane, then optimize here
- Do not tune directly in shared runtime lanes

## Release-Only Consumption Rule

Other lanes must consume only promoted release artifacts listed in:
- `releases/index.json`
- `releases/<version>/manifest.json`

Never consume:
- `build/` outputs
- unversioned temporary artifacts

## Promotion Gate (Required)

A release is valid only if all five exist:
1. Built artifact
2. Benchmark report JSON
3. Nsight Systems report
4. Nsight Compute report
5. Release manifest

Promotion command:

```powershell
.\scripts\promote-release.ps1 `
  -Version v0.1.0 `
  -ArtifactPath .\build\Release\kernels-v0.1.0.zip `
  -BenchmarkReportPath .\benchmarks\reports\baseline.json `
  -NsysReportPath .\profiles\nsys\baseline.nsys-rep `
  -NcuReportPath .\profiles\ncu\baseline.ncu-rep `
  -Notes "Initial optimized baseline"
```

## Typical Workflow

```text
Intake snapshot -> Build -> Benchmark -> Profile -> Compare vs baseline -> Promote release -> Hand off manifest
```

Hand-off should include:
- version
- manifest path
- key speedup/regression metrics
- known tradeoffs

## Quick Start

```powershell
Set-Location S:\kernel-lane
.\scripts\env-check.ps1
.\scripts\build-kernels.ps1 -Configuration Release
.\scripts\run-benchmarks.ps1 -Name baseline
.\scripts\run-profiles.ps1 -ExecutablePath .\build\Release\your-binary.exe -Args "--size 1048576" -Name baseline
```

## Why This Matters

Kernel work is high-impact and high-risk.
By isolating it as Lane 4, you get:
- faster iteration on CUDA tuning
- safer integration into the main lattice
- deterministic convergence through evidence-backed releases
