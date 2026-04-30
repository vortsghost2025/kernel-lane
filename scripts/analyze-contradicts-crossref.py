#!/usr/bin/env python3
import json
import os
from collections import defaultdict

# Load site-index.json
with open(
    "S:/self-organizing-library/data/site-index.json", "r", encoding="utf-8"
) as f:
    index = json.load(f)

entries = index["entries"]
cross_refs = index["cross_references"]
tag_index = index["tag_index"]

print(
    f"Loaded: {len(entries)} entries, {len(cross_refs)} cross_refs, {len(tag_index)} tags"
)

# Build map: entry_id -> entry dict for quick lookup
entry_map = {e["id"]: e for e in entries}

# Find entry IDs that have CONTRADICTION_TAGS
contradiction_tags = {"Failure Mode", "Drift"}
contra_entry_ids = set()
for tag in contradiction_tags:
    if tag in tag_index:
        contra_entry_ids.update(tag_index[tag])
print(f"Entries with {contradiction_tags}: {len(contra_entry_ids)}")

# For each cross_ref, check if source has contradiction tag
contra_cross_refs = []
normal_cross_refs = []
for cr in cross_refs:
    source_id = cr["source"]
    if source_id in contra_entry_ids:
        contra_cross_refs.append(cr)
    else:
        normal_cross_refs.append(cr)

print(f"Cross-refs with contradiction-tag source: {len(contra_cross_refs)}")
print(f"Cross-refs without contradiction-tag source: {len(normal_cross_refs)}")

# Verify this matches the expected 183
print(
    f"Expected: 183, Got: {len(contra_cross_refs)}, Match: {len(contra_cross_refs) == 183}"
)

# Now classify each contra_cross_ref as genuine conflict vs tag-artifact
# Heuristic: genuine conflict if the edge represents a real semantic disagreement
# Tag-artifact if it's just because one node carries a drift/failure-mode tag but the link is innocuous

# We'll look at:
# 1. Target node tags - does target also have contradiction tags? (more likely genuine)
# 2. Edge type - link, cross-paper-tag, etc.
# 3. Source/target titles for conflict keywords
# 4. Repo locations - cross-repo links more likely genuine?

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


def get_entry_info(eid):
    e = entry_map.get(eid, {})
    return {
        "title": e.get("title", ""),
        "tags": e.get("tags", []),
        "repo": e.get("repo", ""),
        "category": e.get("category", ""),
        "content_type": e.get("content_type", ""),
    }


results = {"genuine_conflict": [], "tag_artifact": [], "uncertain": []}

for cr in contra_cross_refs:
    source_id = cr["source"]
    target_id = cr["target"]
    edge_type = cr["type"]
    label = cr.get("label", "")

    source_info = get_entry_info(source_id)
    target_info = get_entry_info(target_id)

    # Check if target also has contradiction tags
    target_has_contra = bool(set(target_info["tags"]) & contradiction_tags)

    # Check for conflict keywords in title/label
    source_conflict_word = title_has_conflict_words(source_info["title"])
    target_conflict_word = title_has_conflict_words(target_info["title"])
    label_conflict_word = title_has_conflict_words(label)

    # Heuristic scoring
    genuine_score = 0
    artifact_score = 0

    # If target also has contradiction tags, more likely genuine
    if target_has_contra:
        genuine_score += 2
    else:
        artifact_score += 1  # target is just a normal doc tagged by association

    # Conflict keywords suggest genuine
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
    elif edge_type in ["cross-paper-dependency"]:  # dependency could be either
        pass

    # Cross-repo links more likely to be genuine cross-lane disagreements
    if source_info["repo"] != target_info["repo"]:
        genuine_score += 1
    else:
        artifact_score += 0  # same repo could be internal documentation

    # Classification threshold
    if genuine_score > artifact_score:
        results["genuine_conflict"].append(
            {
                **cr,
                "score_diff": genuine_score - artifact_score,
                "reasoning": {
                    "target_has_contra": target_has_contra,
                    "source_conflict_word": source_conflict_word,
                    "target_conflict_word": target_conflict_word,
                    "label_conflict_word": label_conflict_word,
                    "cross_repo": source_info["repo"] != target_info["repo"],
                    "edge_type": edge_type,
                },
            }
        )
    elif artifact_score > genuine_score:
        results["tag_artifact"].append(
            {
                **cr,
                "score_diff": artifact_score - genuine_score,
                "reasoning": {
                    "target_has_contra": target_has_contra,
                    "source_conflict_word": source_conflict_word,
                    "target_conflict_word": target_conflict_word,
                    "label_conflict_word": label_conflict_word,
                    "cross_repo": source_info["repo"] != target_info["repo"],
                    "edge_type": edge_type,
                },
            }
        )
    else:
        results["uncertain"].append(
            {
                **cr,
                "score_diff": 0,
                "reasoning": {
                    "target_has_contra": target_has_contra,
                    "source_conflict_word": source_conflict_word,
                    "target_conflict_word": target_conflict_word,
                    "label_conflict_word": label_conflict_word,
                    "cross_repo": source_info["repo"] != target_info["repo"],
                    "edge_type": edge_type,
                },
            }
        )

print(f"\nClassification results:")
print(f"  Genuine conflict: {len(results['genuine_conflict'])}")
print(f"  Tag artifact: {len(results['tag_artifact'])}")
print(f"  Uncertain: {len(results['uncertain'])}")

# Show some examples of each
print(f"\n=== Genuine Conflict Examples (top 5 by score) ===")
sorted_genuine = sorted(
    results["genuine_conflict"], key=lambda x: x["score_diff"], reverse=True
)
for i, ex in enumerate(sorted_genuine[:5]):
    src = entry_map.get(ex["source"], {}).get("title", "unknown")[:50]
    tgt = entry_map.get(ex["target"], {}).get("title", "unknown")[:50]
    print(f"  {i + 1}. [{ex['type']}] {src} -> {tgt} (score: {ex['score_diff']})")

print(f"\n=== Tag Artifact Examples (top 5 by score) ===")
sorted_artifact = sorted(
    results["tag_artifact"], key=lambda x: x["score_diff"], reverse=True
)
for i, ex in enumerate(sorted_artifact[:5]):
    src = entry_map.get(ex["source"], {}).get("title", "unknown")[:50]
    tgt = entry_map.get(ex["target"], {}).get("title", "unknown")[:50]
    print(f"  {i + 1}. [{ex['type']}] {src} -> {tgt} (score: {ex['score_diff']})")

# Save results to files for report
output_dir = "S:/kernel-lane/evidence/graph-snapshots/"
os.makedirs(output_dir, exist_ok=True)

# Save summary
summary = {
    "total_cross_refs": len(cross_refs),
    "contradiction_tag_sources": len(contra_cross_refs),
    "genuine_conflict": len(results["genuine_conflict"]),
    "tag_artifact": len(results["tag_artifact"]),
    "uncertain": len(results["uncertain"]),
    "contradiction_tags": list(contradiction_tags),
    "entries_with_contradiction_tags": len(contra_entry_ids),
}
with open(
    os.path.join(output_dir, "contradicts-crossref-analysis-summary.json"), "w"
) as f:
    json.dump(summary, f, indent=2)

# Save detailed results (may be large, so save just the classifications)
detailed = {
    "genuine_conflict": [
        {
            "source": cr["source"],
            "target": cr["target"],
            "type": cr["type"],
            "label": cr.get("label", ""),
            "score": cr["score_diff"],
        }
        for cr in results["genuine_conflict"]
    ],
    "tag_artifact": [
        {
            "source": cr["source"],
            "target": cr["target"],
            "type": cr["type"],
            "label": cr.get("label", ""),
            "score": cr["score_diff"],
        }
        for cr in results["tag_artifact"]
    ],
    "uncertain": [
        {
            "source": cr["source"],
            "target": cr["target"],
            "type": cr["type"],
            "label": cr.get("label", ""),
            "score": cr["score_diff"],
        }
        for cr in results["uncertain"]
    ],
}
with open(
    os.path.join(output_dir, "contradicts-crossref-analysis-detailed.json"), "w"
) as f:
    json.dump(detailed, f, indent=2)

print(f"\nResults saved to {output_dir}")
