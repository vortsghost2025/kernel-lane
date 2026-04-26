#!/usr/bin/env python3
"""
Render quick benchmark visuals from kernel-lane benchmark JSON files.

Inputs:
  - benchmarks/reports/gen4_verification_benchmark.json (required)

Outputs:
  - benchmarks/reports/plots/gen4_latency_ms.png
  - benchmarks/reports/plots/gen4_tflops.png
  - benchmarks/reports/plots/gen4_summary.csv
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

import matplotlib.pyplot as plt


ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "benchmarks" / "reports" / "gen4_verification_benchmark.json"
OUT_DIR = ROOT / "benchmarks" / "reports" / "plots"


def main() -> int:
    if not REPORT.exists():
        raise SystemExit(f"Missing input report: {REPORT}")

    with REPORT.open("r", encoding="utf-8") as f:
        payload = json.load(f)

    rows = payload.get("results", [])
    if not rows:
        raise SystemExit("No benchmark rows found in gen4_verification_benchmark.json")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    labels = [f'{r.get("kernel", "unknown")}:{r.get("mode", "na")}' for r in rows]
    latency = [float(r.get("latency_ms", 0.0)) for r in rows]
    tflops = [float(r.get("tflops", 0.0)) for r in rows]

    # Latency chart
    plt.figure(figsize=(10, 5))
    plt.bar(labels, latency)
    plt.ylabel("Latency (ms)")
    plt.title("GEN4 Verification Latency by Kernel/Mode")
    plt.xticks(rotation=20, ha="right")
    plt.tight_layout()
    plt.savefig(OUT_DIR / "gen4_latency_ms.png", dpi=180)
    plt.close()

    # TFLOPS chart
    plt.figure(figsize=(10, 5))
    plt.bar(labels, tflops)
    plt.ylabel("TFLOPS")
    plt.title("GEN4 Verification TFLOPS by Kernel/Mode")
    plt.xticks(rotation=20, ha="right")
    plt.tight_layout()
    plt.savefig(OUT_DIR / "gen4_tflops.png", dpi=180)
    plt.close()

    # CSV summary
    with (OUT_DIR / "gen4_summary.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(
            ["kernel", "mode", "latency_ms", "tflops", "fp8_fallback_to_fp16"]
        )
        for r in rows:
            writer.writerow(
                [
                    r.get("kernel", ""),
                    r.get("mode", ""),
                    r.get("latency_ms", ""),
                    r.get("tflops", ""),
                    r.get("fp8_fallback_to_fp16", False),
                ]
            )

    print(f"[ok] Wrote plots and summary under: {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
