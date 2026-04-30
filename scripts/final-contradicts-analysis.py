import json
import os

# Load site-index.json
with open(
    "S:/self-organizing-library/data/site-index.json", "r", encoding="utf-8"
) as f:
    index = json.load(f)

entries = index["entries"]
cross_refs = index["cross_references"]
tag_index = index["tag_index"]

# Build map: entry_id -> entry dict for quick lookup
entry_map = {e["id"]: e for e in entries}

# Exact sets from truth-routing.ts
VERIFICATION_TAGS = {
    "Verification",
    "Attestation",
    "Identity Enforcement",
    "Convergence Gate",
}
SIGNING_TAGS = {"Attestation", "Identity Enforcement"}
EXECUTION_TAGS = {"Kernel", "Swarmmind", "Multi-Agent"}
DERIVATION_CATEGORIES = {"verification", "attestation", "governance", "spec", "paper"}
VERIFICATION_CATEGORIES = {"verification", "attestation", "audit"}
CODE_TYPES = {"code", "config"}


# Helper functions matching truth-routing.ts logic
def hasAnyTag(tags, tag_set):
    return any(t in tag_set for t in tags)


def get_entry_info(eid):
    e = entry_map.get(eid, {})
    return {
        "title": e.get("title", ""),
        "tags": e.get("tags", []),
        "repo": e.get("repo", ""),
        "category": e.get("category", ""),
        "content_type": e.get("content_type", ""),
    }


contradiction_tags = {"Failure Mode", "Drift"}
contra_entry_ids = set()
for tag in contradiction_tags:
    if tag in tag_index:
        contra_entry_ids.update(tag_index[tag])

print(f"Entries with contradiction tags: {len(contra_entry_ids)}")

# Apply truth-routing.ts filtering logic EXACTLY
actual_contradicts_edges = []
for cr in cross_refs:
    source_id = cr["source"]
    target_id = cr["target"]

    source_info = get_entry_info(source_id)

    # Check if source has contradiction tags
    if not hasAnyTag(source_info["tags"], contradiction_tags):
        continue

    # Check if it would be caught by earlier conditions - EXACT ORDER FROM LINES 236-248
    if (
        hasAnyTag(source_info["tags"], VERIFICATION_TAGS)
        and source_info["category"] in VERIFICATION_CATEGORIES
    ):
        # Would be VERIFIES edge
        continue
    if (
        hasAnyTag(source_info["tags"], SIGNING_TAGS)
        and source_info["category"] == "attestation"
    ):
        # Would be SIGNED_BY edge
        continue
    if (
        hasAnyTag(source_info["tags"], EXECUTION_TAGS)
        and source_info["content_type"] in CODE_TYPES
    ):
        # Would be EXECUTES edge
        continue
    if source_info["category"] in DERIVATION_CATEGORIES:
        # Would be DERIVES_FROM edge
        continue
    # If we get here, it becomes a CONTRADICTS edge (line 242-243)
    actual_contradicts_edges.append(cr)

print(
    f"Actual CONTRADICTS edges from cross-ref pathway: {len(actual_contradicts_edges)}"
)
print(f"Expected from Library: 183")
print(f"Match: {len(actual_contradicts_edges) == 183}")

# Now classify these 183 edges
conflict_keywords = {
    "wrong",
    "error",
    "bug",
    "flaw",
    "issue",
    "problem",
    "critic",
    "disagree",
    "conflict",
    "contra",
    "refute",
    "oppose",
    "challenge",
    "question",
    "concern",
    "risk",
    "danger",
    "flaw",
    "mistake",
    "false",
    "misleading",
}


def title_has_conflict_words(title):
    if not title:
        return False
    title_lower = title.lower()
    return any(kw in title_lower for kw in conflict_keywords)


results = {"genuine_conflict": [], "tag_artifact": [], "uncertain": []}

for cr in actual_contradicts_edges:
    source_id = cr["source"]
    target_id = cr["target"]
    edge_type = cr["type"]
    label = cr.get("label", "")

    source_info = get_entry_info(source_id)
    target_info = get_entry_info(target_id)

    target_has_contra = bool(set(target_info["tags"]) & contradiction_tags)
    source_conflict_word = title_has_conflict_words(source_info["title"])
    target_conflict_word = title_has_conflict_words(target_info["title"])
    label_conflict_word = title_has_conflict_words(label)

    genuine_score = 0
    artifact_score = 0

    # Heuristic: genuine conflict if represents real semantic disagreement
    # Tag-artifact if just because source has drift/failure-mode tag but link is innocuous

    # If target also has contradiction tags, more likely genuine (both flagged)
    if target_has_contra:
        genuine_score += 2
    else:
        artifact_score += 1  # target is just a normal doc tagged by association

    # Conflict keywords in title/label suggest genuine disagreement
    if source_conflict_word or target_conflict_word or label_conflict_word:
        genuine_score += 2

    # Certain edge types more likely to be genuine disagreements
    if edge_type in ["link"]:  # direct links might be critiques/refutations
        genuine_score += 1
    elif edge_type in [
        "cross-paper-tag",
        "paper-section-of",
    ]:  # structural/organizational
        artifact_score += 1
    # cross-paper-dependency could be either - no score

    # Cross-repo links more likely to be genuine cross-lane disagreements
    if source_info["repo"] != target_info["repo"]:
        genuine_score += 1
    # same repo could be internal documentation - no score

    # Classification threshold
    if genuine_score > artifact_score:
        results["genuine_conflict"].append(
            {**cr, "score": genuine_score - artifact_score}
        )
    elif artifact_score > genuine_score:
        results["tag_artifact"].append({**cr, "score": artifact_score - genuine_score})
    else:
        results["uncertain"].append({**cr, "score": 0})

print(f"\nClassification of the 183 cross-ref CONTRADICTS edges:")
print(f"  Genuine conflict: {len(results['genuine_conflict'])}")
print(f"  Tag artifact: {len(results['tag_artifact'])}")
print(f"  Uncertain: {len(results['uncertain'])}")

# Show examples
print(f"\n=== TOP GENUINE CONFLICTS (by score) ===")
sorted_genuine = sorted(
    results["genuine_conflict"], key=lambda x: x["score"], reverse=True
)
for i, ex in enumerate(sorted_genuine[:10]):
    src = entry_map.get(ex["source"], {}).get("title", "unknown")[:60]
    tgt = entry_map.get(ex["target"], {}).get("title", "unknown")[:60]
    print(f"  {i + 1:2}. [{ex['type']:18}] {src:40} -> {tgt:40} (score: {ex['score']})")

print(f"\n=== TOP TAG ARTIFACTS (by score) ===")
sorted_artifact = sorted(
    results["tag_artifact"], key=lambda x: x["score"], reverse=True
)
for i, ex in enumerate(sorted_artifact[:10]):
    src = entry_map.get(ex["source"], {}).get("title", "unknown")[:60]
    tgt = entry_map.get(ex["target"], {}).get("title", "unknown")[:60]
    print(f"  {i + 1:2}. [{ex['type']:18}] {src:40} -> {tgt:40} (score: {ex['score']})")

# Save results for report
output_dir = "S:/kernel-lane/evidence/graph-snapshots/"
os.makedirs(output_dir, exist_ok=True)

summary = {
    "analysis": "CONTRADICTS cross-ref semantic review",
    "total_cross_refs": len(cross_refs),
    "contradiction_tag_sources": len(contra_entry_ids),
    "actual_contradicts_edges": len(actual_contradicts_edges),
    "expected_183_match": len(actual_contradicts_edges) == 183,
    "classification": {
        "genuine_conflict": len(results["genuine_conflict"]),
        "tag_artifact": len(results["tag_artifact"]),
        "uncertain": len(results["uncertain"]),
    },
    "contradiction_tags": list(contradiction_tags),
    "verification_tags": list(VERIFICATION_TAGS),
    "signing_tags": list(SIGNING_TAGS),
    "execution_tags": list(EXECUTION_TAGS),
    "derivation_categories": list(DERIVATION_CATEGORIES),
    "verification_categories": list(VERIFICATION_CATEGORIES),
    "code_types": list(CODE_TYPES),
}
with open(
    os.path.join(output_dir, "contradicts-crossref-semantic-review.json"), "w"
) as f:
    json.dump(summary, f, indent=2)

# Also save just the classifications for easy consumption
classified = {
    "genuine_conflict": [
        {
            "source": cr["source"],
            "target": cr["target"],
            "type": cr["type"],
            "label": cr.get("label", ""),
            "score": cr["score"],
        }
        for cr in results["genuine_conflict"]
    ],
    "tag_artifact": [
        {
            "source": cr["source"],
            "target": cr["target"],
            "type": cr["type"],
            "label": cr.get("label", ""),
            "score": cr["score"],
        }
        for cr in results["tag_artifact"]
    ],
    "uncertain": [
        {
            "source": cr["source"],
            "target": cr["target"],
            "type": cr["type"],
            "label": cr.get("label", ""),
            "score": cr["score"],
        }
        for cr in results["uncertain"]
    ],
}
with open(os.path.join(output_dir, "contradicts-crossref-classified.json"), "w") as f:
    json.dump(classified, f, indent=2)

print(f"\nResults saved to {output_dir}")
