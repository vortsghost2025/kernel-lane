#!/usr/bin/env python3
"""Auto-tagger for untagged graph nodes.

Reads a full graph snapshot, identifies nodes with no tags,
proposes tags based on category/title/repo heuristics, and
writes a tag-assignment manifest.

Usage:
  python auto-tag-graph-nodes.py [--apply] [--snapshot PATH]

  --apply    Write tagged nodes back to the snapshot file
  --snapshot Path to full snapshot (default: evidence/graph-snapshots/graph-snapshot-2026-04-30T16-08-47-full.json)
"""

import json
import re
import sys
import os
from datetime import datetime
from collections import defaultdict

CATEGORY_TAG_MAP = {
    "root-doc": ["Kernel"],
    "config": ["Kernel", "Governance"],
    "baseline": ["Kernel", "Verification"],
    "benchmark": ["Kernel", "Verification"],
    "docs": ["Kernel"],
    "integration": ["Kernel", "Multi-Agent"],
    "kernel": ["Kernel"],
    "paper": ["CAISC 2026", "WE4FREE"],
    "plans": ["Kernel", "Governance"],
    "release": ["Kernel"],
    "reports": ["Kernel", "Verification"],
    "schema": ["Kernel", "Governance"],
    "script": ["Kernel"],
    "profile": ["Kernel", "Verification"],
    "code": ["Kernel", "Attestation"],
}

TITLE_PATTERNS = [
    (
        r"(?i)cuda|kernel|gpu|nsight|nsys|ncu|profiling|benchmark|fp8|stall|compile",
        ["Kernel", "Verification"],
    ),
    (
        r"(?i)sign|attestation|key|trust|identity|pem|rsa",
        ["Attestation", "Verification"],
    ),
    (
        r"(?i)governance|covenant|convergence|rosetta|drift",
        ["Governance", "Convergence Gate"],
    ),
    (r"(?i)swarm|swarmmind|multi.agent|ensemble", ["Swarmmind", "Multi-Agent"]),
    (r"(?i)archivist|schema.valid|quarantin", ["Archivist"]),
    (r"(?i)library|truth.routing|contradict", ["Library"]),
    (r"(?i)nfm", []),
    (r"(?i)we4free|publication|roadmap|phase", ["WE4FREE"]),
    (r"(?i)caisc|paper|draft", ["CAISC 2026"]),
    (r"(?i)ci|integration|deploy|release|manifest", ["Kernel"]),
    (
        r"(?i)inbox|outbox|lane|dispatch|relay|watcher|heartbeat",
        ["Kernel", "Multi-Agent"],
    ),
    (r"(?i)verify|audit|evidence|proof|regression|sanitizer", ["Verification"]),
    (r"(?i)covenant|values|beliefs|rules|follow", ["Covenant", "Governance"]),
]

REPO_TAG_MAP = {
    "kernel-lane": ["Kernel"],
    "Archivist-Agent": ["Archivist"],
    "self-organizing-library": ["Library"],
    "SwarmMind-Self-Optimizing-Multi-Agent-AI-System": ["Swarmmind"],
}

EXISTING_TAGS = {
    "Kernel",
    "Library",
    "Archivist",
    "Swarmmind",
    "Verification",
    "Governance",
    "Convergence Gate",
    "Drift",
    "Covenant",
    "Attestation",
    "Multi-Agent",
    "WE4FREE",
    "CAISC 2026",
    "Ensemble",
    "Federation",
    "Phenotype",
    "Identity Enforcement",
    "Rosetta Stone",
    "Constraint Lattice",
    "Phase 1",
    "Phase 2",
    "Phase 3",
    "Phase 4",
}

NFM_RE = re.compile(r"NFM-(\d+)", re.IGNORECASE)


def propose_tags(node):
    tags = set()
    cat = node.get("category", "")
    title = node.get("title", "")
    repo = node.get("repo", "")

    if cat in CATEGORY_TAG_MAP:
        tags.update(CATEGORY_TAG_MAP[cat])

    if repo in REPO_TAG_MAP:
        tags.update(REPO_TAG_MAP[repo])

    for pattern, pat_tags in TITLE_PATTERNS:
        if re.search(pattern, title):
            tags.update(pat_tags)

    nfm_matches = NFM_RE.findall(title)
    for nfm_num in nfm_matches:
        nfm_tag = f"NFM-{int(nfm_num):03d}"
        if nfm_tag in EXISTING_TAGS:
            tags.add(nfm_tag)

    if cat == "code" and any(
        kw in title.lower() for kw in ["signer", "key", "trust", "schema"]
    ):
        tags.add("Attestation")

    if cat == "script" and any(
        kw in title.lower()
        for kw in ["identity", "sign", "key", "trust", "attestation"]
    ):
        tags.add("Attestation")

    if cat == "script" and any(
        kw in title.lower()
        for kw in ["verify", "audit", "test", "validate", "check", "regression"]
    ):
        tags.add("Verification")

    if cat == "script" and any(
        kw in title.lower() for kw in ["governance", "convergence", "covenant", "drift"]
    ):
        tags.add("Governance")

    if cat == "docs" and any(
        kw in title.lower() for kw in ["cross-lane", "review", "audit", "signing"]
    ):
        tags.add("Verification")
        tags.add("Multi-Agent")

    if cat == "docs" and any(kw in title.lower() for kw in ["convergence", "protocol"]):
        tags.add("Convergence Gate")

    if cat == "docs" and any(kw in title.lower() for kw in ["evidence", "exchange"]):
        tags.add("Verification")

    if cat == "benchmark" and any(kw in title.lower() for kw in ["gen5", "fp8"]):
        tags.add("Kernel")

    if cat == "profile" and any(
        kw in title.lower() for kw in ["sanitizer", "verification", "meta"]
    ):
        tags.add("Verification")

    if cat == "release":
        tags.add("Kernel")
        if "convergence" in title.lower():
            tags.add("Convergence Gate")

    tags.discard("")
    return sorted(tags)


def main():
    apply_mode = "--apply" in sys.argv
    snapshot_path = None
    for i, arg in enumerate(sys.argv):
        if arg == "--snapshot" and i + 1 < len(sys.argv):
            snapshot_path = sys.argv[i + 1]

    if not snapshot_path:
        default_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "evidence",
            "graph-snapshots",
            "graph-snapshot-2026-04-30T16-08-47-full.json",
        )
        snapshot_path = default_path

    with open(snapshot_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    nodes = data.get("nodes", [])
    untagged = [n for n in nodes if not n.get("tags") or len(n.get("tags", [])) == 0]
    single_tag = [n for n in nodes if len(n.get("tags", [])) == 1]

    print(f"Total nodes: {len(nodes)}")
    print(f"Untagged: {len(untagged)}")
    print(f"Single-tag: {len(single_tag)}")
    print()

    manifest = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "source_snapshot": os.path.basename(snapshot_path),
        "total_nodes": len(nodes),
        "untagged_count": len(untagged),
        "single_tag_count": len(single_tag),
        "assignments": [],
        "supplements": [],
    }

    tag_coverage = defaultdict(int)

    for node in untagged:
        proposed = propose_tags(node)
        assignment = {
            "node_id": node["id"],
            "title": node["title"],
            "category": node.get("category", "?"),
            "repo": node.get("repo", "?"),
            "current_tags": node.get("tags", []),
            "proposed_tags": proposed,
            "confidence": "high"
            if len(proposed) >= 2
            else "medium"
            if len(proposed) == 1
            else "low",
        }
        manifest["assignments"].append(assignment)
        for t in proposed:
            tag_coverage[t] += 1
        if apply_mode and proposed:
            node["tags"] = proposed
            for t in proposed:
                tag_cluster = f"tag:{t}"
                if tag_cluster not in node.get("clusterIds", []):
                    node.setdefault("clusterIds", []).append(tag_cluster)

    for node in single_tag:
        existing = node.get("tags", [])
        proposed = propose_tags(node)
        supplement = [t for t in proposed if t not in existing]
        if supplement:
            entry = {
                "node_id": node["id"],
                "title": node["title"],
                "category": node.get("category", "?"),
                "current_tags": existing,
                "supplement_tags": supplement,
            }
            manifest["supplements"].append(entry)
            if apply_mode:
                node["tags"] = existing + supplement
                for t in supplement:
                    tag_cluster = f"tag:{t}"
                    if tag_cluster not in node.get("clusterIds", []):
                        node.setdefault("clusterIds", []).append(tag_cluster)

    print(f"Tag assignments proposed: {len(manifest['assignments'])}")
    print(f"Tag supplements proposed: {len(manifest['supplements'])}")
    print()
    print("=== PROJECTED TAG COVERAGE ===")
    for tag, count in sorted(tag_coverage.items(), key=lambda x: -x[1]):
        print(f"  {tag}: +{count} nodes")

    confidence_counts = {"high": 0, "medium": 0, "low": 0}
    for a in manifest["assignments"]:
        confidence_counts[a["confidence"]] += 1
    print(
        f"\nConfidence: high={confidence_counts['high']}, medium={confidence_counts['medium']}, low={confidence_counts['low']}"
    )

    manifest_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "evidence",
        "graph-snapshots",
        "auto-tag-manifest-" + datetime.utcnow().strftime("%Y-%m-%d") + ".json",
    )
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"\nManifest written to: {manifest_path}")

    if apply_mode:
        with open(snapshot_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"APPLIED: Tags written back to {snapshot_path}")
        still_untagged = len(
            [
                n
                for n in data["nodes"]
                if not n.get("tags") or len(n.get("tags", [])) == 0
            ]
        )
        print(f"Remaining untagged: {still_untagged}")
    else:
        print("\nDry run only. Use --apply to write tags back to snapshot.")


if __name__ == "__main__":
    main()
