Kernel Lane
Isolated GPU kernel engineering lane for CUDA build, benchmark, and optimization work.

Purpose
Compile and optimize kernels in isolation.
Capture benchmark + Nsight evidence for every release.
Promote only pinned, evidence-backed artifacts to other lanes.
Scope
In scope: CUDA kernels, compile flags, perf tuning, benchmark and profiling automation.
Out of scope: application orchestration, lane governance logic, cross-lane config edits.
Upstream Input
Reference workspace: S:\snac-v2\kimi-shared
Import code into this lane before tuning; do not tune directly in shared runtime lanes.
Quick Start
Set-Location S:\kernel-lane
.\scripts\env-check.ps1
.\scripts\build-kernels.ps1 -Configuration Release
# run your kernel benchmarks
.\scripts\run-benchmarks.ps1 -Name baseline
.\scripts\run-profiles.ps1 -ExecutablePath .\build\Release\your-binary.exe -Args "--size 1048576" -Name baseline
Promotion Rule
Only promoted releases may be consumed by other lanes.
Promotion requires:

Built artifact
Benchmark report JSON
Nsight Systems report
Nsight Compute report
Release manifest
Use:

.\scripts\promote-release.ps1 \
  -Version v0.1.0 \
  -ArtifactPath .\build\Release\kernels-v0.1.0.zip \
  -BenchmarkReportPath .\benchmarks\reports\baseline.json \
  -NsysReportPath .\profiles\nsys\baseline.nsys-rep \
  -NcuReportPath .\profiles\ncu\baseline.ncu-rep \
  -Notes "Initial optimized baseline"# kernel-lane
Kernel-Lane
