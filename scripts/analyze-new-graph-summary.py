import json


def analyze_graph_snapshot(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    nodes = data.get("nodes", [])
    edges = data.get("edges", [])

    print("=== KERNEL LANE SPECIFIC ANALYSIS SUMMARY ===")
    print(f"Total nodes: {len(nodes)}")
    print(f"Total edges: {len(edges)}")

    # Kernel lane focus areas
    verification_nodes = [
        n
        for n in nodes
        if "Verification" in n.get("category", "")
        or "Verification" in n.get("tags", [])
        or "verification" in n.get("title", "").lower()
    ]

    benchmark_nodes = [
        n
        for n in nodes
        if "benchmark" in n.get("title", "").lower()
        or "benchmark" in n.get("category", "").lower()
    ]

    execution_nodes = [
        n
        for n in nodes
        if "Kernel" in n.get("category", "") or "Kernel" in n.get("tags", [])
    ]

    high_authority = [n for n in nodes if n.get("authorityDepth", 0) >= 80]
    high_contradiction = [n for n in nodes if n.get("contradictionCount", 0) >= 20]

    print(f"\nKERNEL LANE RELEVANCE COUNTS:")
    print(f"  Verification nodes: {len(verification_nodes)}")
    print(f"  Benchmark nodes: {len(benchmark_nodes)}")
    print(f"  Execution/Kernel nodes: {len(execution_nodes)}")
    print(f"  High authority nodes (>=80): {len(high_authority)}")
    print(f"  High contradiction nodes (>=20): {len(high_contradiction)}")

    # Status breakdown for key areas
    def count_status(node_list, status):
        return len([n for n in node_list if n.get("status") == status])

    print(f"\nSTATUS BREAKDOWN:")
    print(
        f"  Verification - Verified: {count_status(verification_nodes, 'VERIFIED')}, Conflicted: {count_status(verification_nodes, 'CONFLICTED')}, Unverified: {count_status(verification_nodes, 'UNVERIFIED')}"
    )
    print(
        f"  Benchmark - Verified: {count_status(benchmark_nodes, 'VERIFIED')}, Unverified: {count_status(benchmark_nodes, 'UNVERIFIED')}"
    )
    print(
        f"  Execution - Verified: {count_status(execution_nodes, 'VERIFIED')}, Conflicted: {count_status(execution_nodes, 'CONFLICTED')}, Unverified: {count_status(execution_nodes, 'UNVERIFIED')}"
    )

    # Kernel-relevant high contradiction nodes
    kernel_relevant_high_contra = [
        n
        for n in high_contradiction
        if (
            "Verification" in n.get("category", "")
            or "Verification" in n.get("tags", [])
            or "Benchmark" in n.get("category", "")
            or "benchmark" in n.get("title", "").lower()
            or "Kernel" in n.get("category", "")
            or "Kernel" in n.get("tags", [])
        )
    ]
    print(f"\nKERNEL-RELEVANT HIGH CONTRADICTION: {len(kernel_relevant_high_contra)}")

    # Authority/verification imbalance
    low_verif_high_auth = [
        n
        for n in nodes
        if n.get("authorityDepth", 0) >= 60 and n.get("verificationCount", 0) < 5
    ]
    kernel_low_verif = [
        n
        for n in low_verif_high_auth
        if (
            "Verification" in n.get("category", "")
            or "Verification" in n.get("tags", [])
            or "Benchmark" in n.get("category", "")
            or "benchmark" in n.get("title", "").lower()
            or "Kernel" in n.get("category", "")
            or "Kernel" in n.get("tags", [])
        )
    ]
    print(f"KERNEL LOW VERIFICATION/HIGH AUTHORITY: {len(kernel_low_verif)}")

    # Verified benchmark/report references
    verified_benchmarks = [
        n
        for n in nodes
        if (
            "report" in n.get("title", "").lower()
            or "benchmark" in n.get("title", "").lower()
        )
        and n.get("verificationCount", 0) >= 10
    ]
    print(f"VERIFIED BENCHMARK/REPORT REFERENCES: {len(verified_benchmarks)}")

    # Overall system health
    status_counts = {}
    for n in nodes:
        s = n.get("status", "unknown")
        status_counts[s] = status_counts.get(s, 0) + 1
    print(f"\nOVERALL SYSTEM STATUS:")
    for status, count in sorted(status_counts.items()):
        print(f"  {status}: {count}")

    print(f"\nANALYSIS COMPLETE - Ready for Kernel lane findings distribution")


if __name__ == "__main__":
    analyze_graph_snapshot(
        "S:/Archivist-Agent/context-buffer/graph-snapshot-2026-04-30-18-45-40-860.json"
    )
