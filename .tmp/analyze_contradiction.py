import json, collections

with open(
    "S:/kernel-lane/.tmp/contradiction-hub-report-2026-05-01-12-57-51-853.json"
) as f:
    data = json.load(f)
contradictions = data.get("contradictions", [])
if not contradictions:
    if isinstance(data, list):
        contradictions = data
target_counts = [75, 53, 44, 43, 42, 41, 40]
groups = {c: [] for c in target_counts}
groups["<40"] = []
for node in contradictions:
    cc = node.get("contradictionCount", 0)
    if cc in target_counts:
        groups[cc].append(node)
    else:
        groups["<40"].append(node)
print("Contradiction Count Group Analysis")
print("=" * 60)
for cc in target_counts + ["<40"]:
    nodes = groups[cc]
    if not nodes:
        continue
    print(f"\nContradictionCount = {cc}: {len(nodes)} nodes")
    repos = [n.get("repo", "unknown") for n in nodes]
    repo_counts = collections.Counter(repos)
    print("  Repos affected:", dict(repo_counts))
    all_tags = []
    for n in nodes:
        tags = n.get("tags", [])
        all_tags.extend(tags)
    tag_counts = collections.Counter(all_tags)
    common_tags = [tag for tag, cnt in tag_counts.most_common(5)]
    print("  Common tags (top 5):", common_tags)
    sample_titles = [n.get("title", "")[:60] for n in nodes[:3]]
    print("  Sample titles:", sample_titles)
    verified_nodes = [n for n in nodes if n.get("verificationCount", 0) > 0]
    if len(verified_nodes) > 0:
        cause = "Mixed verification status suggests possible semantic contradiction"
        classification = "potential true semantic contradiction (needs review)"
    elif cc >= 40 and len(nodes) > 10:
        cause = "High count, many nodes -> likely tag-group artifact (K(40) complete graph from CONTRADICTION_TAGS)"
        classification = "tag/rule-generated false positive (stale historical artifact)"
    elif cc == 1 and len(nodes) > 20:
        cause = (
            "Low count (1) with many nodes -> likely isolated cross-ref false positives"
        )
        classification = "duplicated/structure-index artifact (cross-ref with CONTRADICTION_TAGS source)"
    else:
        cause = "Mixed pattern; requires manual review"
        classification = "needs lane review"
    print("  Likely cause:", cause)
    print("  Classification:", classification)
EOF
