import json
from collections import Counter


def analyze_graph_snapshot(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    nodes = data.get("nodes", [])
    edges = data.get("edges", [])

    print("=== KERNEL LANE SPECIFIC ANALYSIS ===")
    print(f"Total nodes: {len(nodes)}")
    print(f"Total edges: {len(edges)}")

    # Kernel lane focus areas: verification, benchmarks, optimization, execution
    # Let's look for nodes relevant to these areas

    # Verification-related nodes
    verification_nodes = [
        n
        for n in nodes
        if "Verification" in n.get("category", "")
        or "Verification" in n.get("tags", [])
        or "verification" in n.get("title", "").lower()
    ]

    # Benchmark/performance related nodes
    benchmark_nodes = [
        n
        for n in nodes
        if "benchmark" in n.get("title", "").lower()
        or "benchmark" in n.get("category", "").lower()
        or "performance" in n.get("title", "").lower()
        or "optimization" in n.get("title", "").lower()
    ]

    # Execution/Kernel related nodes
    execution_nodes = [
        n
        for n in nodes
        if "Kernel" in n.get("category", "")
        or "Kernel" in n.get("tags", [])
        or "execution" in n.get("title", "").lower()
        or "code" in n.get("category", "")
    ]

    # Configuration/tuning related nodes
    config_nodes = [
        n
        for n in nodes
        if "config" in n.get("category", "")
        or "config" in n.get("title", "").lower()
        or "setting" in n.get("title", "").lower()
    ]

    # Profiling related nodes
    profile_nodes = [
        n
        for n in nodes
        if "profile" in n.get("title", "").lower()
        or "profile" in n.get("category", "").lower()
    ]

    print(f"\nKERNEL LANE RELEVANCE:")
    print(f"  Verification nodes: {len(verification_nodes)}")
    print(f"  Benchmark/Performance nodes: {len(benchmark_nodes)}")
    print(f"  Execution/Code nodes: {len(execution_nodes)}")
    print(f"  Configuration nodes: {len(config_nodes)}")
    print(f"  Profile nodes: {len(profile_nodes)}")

    # Look for high-value nodes (high authority, high connection count)
    high_authority = [n for n in nodes if n.get("authorityDepth", 0) >= 80]
    high_connection = [n for n in nodes if n.get("connectionCount", 0) >= 500]

    print(f"\nHIGH-VALUE NODES:")
    print(f"  High authority (depth >= 80): {len(high_authority)}")
    print(f"  High connection (count >= 500): {len(high_connection)}")

    # Check status of kernel-relevant nodes
    def get_status_breakdown(node_list):
        status_counts = Counter()
        for n in node_list:
            status_counts[n.get("status", "unknown")] += 1
        return dict(status_counts)

    print(f"\nSTATUS BREAKDOWN BY CATEGORY:")
    categories = ["Verification", "Benchmark", "Execution", "Configuration", "Profile"]
    node_lists = [
        verification_nodes,
        benchmark_nodes,
        execution_nodes,
        config_nodes,
        profile_nodes,
    ]
    for name, node_list in zip(categories, node_lists):
        if node_list:
            status_breakdown = get_status_breakdown(node_list)
            print(f"  {name}: {status_breakdown}")

    # Look for conflicted or unverified kernel-relevant nodes that need attention
    def get_problematic_nodes(node_list, statuses):
        result = []
        for n in node_list:
            if n.get("status", "") in statuses:
                result.append(n)
        return result

    print(f"\nPROBLEMATIC KERNEL-RELEVANT NODES:")
    statuses = ["conflicted", "unverified"]
    for name, node_list in zip(categories, node_lists):
        problematic = get_problematic_nodes(node_list, statuses)
        if problematic:
            status_list = []
            for n in problematic:
                status_list.append(str(n.get("status")))
            print(f"  {name}: {len(problematic)} problematic ({status_list})")

    # Look for verification/benchmark nodes with high authority (trusted sources)
    def get_authoritative_nodes(node_list, min_authority):
        result = []
        for n in node_list:
            if n.get("authorityDepth", 0) >= min_authority:
                result.append(n)
        return result

    print(f"\nAUTHORITATIVE KERNEL-RELEVANT NODES (authority >= 70):")
    for name, node_list in zip(categories, node_lists):
        authoritative = get_authoritative_nodes(node_list, 70)
        if authoritative:
            print(f"  {name}: {len(authoritative)} authoritative nodes")

            # Show top examples
            def get_authority(node):
                return node.get("authorityDepth", 0)

            sorted_by_authority = sorted(authoritative, key=get_authority, reverse=True)
            for node in sorted_by_authority[:3]:
                title = str(node.get("title", ""))
                if len(title) > 50:
                    title = title[:50] + "..."
                print(
                    f"    {node.get('id')}: {title} (authority: {node.get('authorityDepth')})"
                )

    # Look for optimization opportunities
    print(f"\nOPTIMIZATION OPPORTUNITIES:")
    # Nodes with high contradiction count might indicate areas needing verification/resolution
    high_contradiction_nodes = [
        n for n in nodes if n.get("contradictionCount", 0) >= 20
    ]
    print(f"  High contradiction count (>=20): {len(high_contradiction_nodes)}")
    if high_contradiction_nodes:
        # Check which of these are kernel-relevant
        kernel_relevant_high_contra = []
        for n in high_contradiction_nodes:
            tags = n.get("tags", [])
            category = n.get("category", "")
            if any(
                tag in tags
                for tag in ["Verification", "Benchmark", "Kernel", "Execution"]
            ) or any(
                cat in category
                for cat in ["verification", "benchmark", "kernel", "execution"]
            ):
                kernel_relevant_high_contra.append(n)
        print(
            f"  Kernel-relevant high contradiction: {len(kernel_relevant_high_contra)}"
        )
        for node in kernel_relevant_high_contra[:5]:
            title = str(node.get("title", ""))
            if len(title) > 50:
                title = title[:50] + "..."
            print(
                f"    {node.get('id')}: {title} (contra: {node.get('contradictionCount')}, auth: {node.get('authorityDepth')})"
            )

    # Nodes with low verification count despite high authority might need more verification
    low_verif_high_auth = [
        n
        for n in nodes
        if n.get("authorityDepth", 0) >= 60 and n.get("verificationCount", 0) < 5
    ]
    print(
        f"\n  High authority but low verification (auth>=60, verif<5): {len(low_verif_high_auth)}"
    )
    kernel_low_verif = []
    for n in low_verif_high_auth:
        tags = n.get("tags", [])
        category = n.get("category", "")
        if any(
            tag in tags for tag in ["Verification", "Benchmark", "Kernel", "Execution"]
        ) or any(
            cat in category
            for cat in ["verification", "benchmark", "kernel", "execution"]
        ):
            kernel_low_verif.append(n)
    print(f"  Kernel-relevant low verification/high authority: {len(kernel_low_verif)}")
    for node in kernel_low_verif[:5]:
        title = str(node.get("title", ""))
        if len(title) > 50:
            title = title[:50] + "..."
        print(
            f"    {node.get('id')}: {title} (auth: {node.get('authorityDepth')}, verif: {node.get('verificationCount')})"
        )

    # Look for benchmark/report nodes that could be used as references
    print(f"\nREFERENCE/BENCHMARK NODES:")
    benchmark_reports = [
        n
        for n in nodes
        if (
            "report" in n.get("title", "").lower()
            or "benchmark" in n.get("title", "").lower()
        )
        and n.get("verificationCount", 0) >= 10
    ]
    print(f"  Verified benchmark/report nodes (verif>=10): {len(benchmark_reports)}")
    for node in benchmark_reports[:5]:
        title = str(node.get("title", ""))
        if len(title) > 60:
            title = title[:60] + "..."
        print(
            f"    {node.get('id')}: {title} (verif: {node.get('verificationCount')}, auth: {node.get('authorityDepth')})"
        )

    # Return key metrics for reporting
    verification_conflicted = 0
    for n in verification_nodes:
        if n.get("status") == "conflicted":
            verification_conflicted += 1

    benchmark_conflicted = 0
    for n in benchmark_nodes:
        if n.get("status") == "conflicted":
            benchmark_conflicted += 1

    execution_conflicted = 0
    for n in execution_nodes:
        if n.get("status") == "conflicted":
            execution_conflicted += 1

    return {
        "total_nodes": len(nodes),
        "total_edges": len(edges),
        "verification_nodes": len(verification_nodes),
        "benchmark_nodes": len(benchmark_nodes),
        "execution_nodes": len(execution_nodes),
        "high_authority_nodes": len(high_authority),
        "high_contradiction_nodes": len(high_contradiction_nodes),
        "kernel_relevant_high_contradiction": len(kernel_relevant_high_contra)
        if "kernel_relevant_high_contra" in locals()
        else 0,
        "verification_conflicted": verification_conflicted,
        "benchmark_conflicted": benchmark_conflicted,
        "execution_conflicted": execution_conflicted,
    }


if __name__ == "__main__":
    analyze_graph_snapshot(
        "S:/Archivist-Agent/context-buffer/graph-snapshot-2026-04-30-18-45-40-860.json"
    )
