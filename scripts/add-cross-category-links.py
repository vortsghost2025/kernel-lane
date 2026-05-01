#!/usr/bin/env python3
import json
import os
from collections import defaultdict


def load_site_index():
    """Load the Library's site-index.json"""
    with open(
        "S:/self-organizing-library/data/site-index.json", "r", encoding="utf-8"
    ) as f:
        return json.load(f)


def save_site_index(data):
    """Save the updated site-index.json"""
    with open(
        "S:/self-organizing-library/data/site-index.json", "w", encoding="utf-8"
    ) as f:
        json.dump(data, f, indent=2)


def get_entries_by_category(entries):
    """Group entry IDs by category"""
    by_category = defaultdict(list)
    for e in entries:
        cat = e.get("category", "uncategorized")
        by_category[cat].append(e["id"])
    return by_category


def find_existing_crossref(site_index, source_id, target_id, edge_type):
    """Check if a cross-reference already exists"""
    for cr in site_index.get("cross_references", []):
        if (
            cr.get("source") == source_id
            and cr.get("target") == target_id
            and cr.get("type") == edge_type
        ):
            return True
    return False


def generate_proposed_edges(site_index, proposal_data):
    """Generate the actual cross-ref entries from the proposal"""
    entries = site_index["entries"]
    entry_map = {e["id"]: e for e in entries}
    by_category = get_entries_by_category(entries)

    new_edges = []
    skipped_duplicates = 0
    skipped_missing = 0

    # Process each proposed edge group
    for edge_group in proposal_data["proposed_edges"]:
        from_cat = edge_group["from_category"]
        to_cat = edge_group["to_category"]
        reason = edge_group["reason"]
        target_count = edge_group["count"]

        from_entries = by_category.get(from_cat, [])
        to_entries = by_category.get(to_cat, [])

        if not from_entries or not to_entries:
            print(f"Warning: No entries found for {from_cat} -> {to_cat}")
            skipped_missing += (
                len(from_entries) * len(to_entries)
                if from_entries and to_entries
                else 0
            )
            continue

        # Create connections - for now, connect first N entries from each category
        # In a real implementation, we'd want to be more sophisticated about which specific nodes to link
        connections_made = 0
        for i, source_id in enumerate(from_entries):
            if connections_made >= target_count:
                break
            # Connect to corresponding entries in target category (round-robin)
            target_id = to_entries[i % len(to_entries)]

            # Check if this edge already exists
            if not find_existing_crossref(site_index, source_id, target_id, "link"):
                new_edges.append(
                    {
                        "source": source_id,
                        "target": target_id,
                        "type": "link",
                        "label": f"{from_cat.upper()} -> {to_cat.upper()}: {reason}",
                    }
                )
                connections_made += 1
            else:
                skipped_duplicates += 1

    print(f"Generated {len(new_edges)} new cross-reference edges")
    print(f"Skipped {skipped_duplicates} duplicates")
    print(f"Skipped {skipped_missing} missing category pairs")

    return new_edges


def main():
    print("Loading site-index.json...")
    site_index = load_site_index()

    print(f"Current entries: {len(site_index.get('entries', []))}")
    print(f"Current cross_references: {len(site_index.get('cross_references', []))}")

    # Load the proposal
    with open(
        "S:/kernel-lane/evidence/graph-snapshots/cross-category-link-proposal-2026-04-30.json",
        "r",
        encoding="utf-8",
    ) as f:
        proposal = json.load(f)

    print(f"\\nProposal: {proposal['proposal']}")
    print(f"Total proposed edges: {proposal['total_proposed_edges']}")

    # Generate new edges
    new_edges = generate_proposed_edges(site_index, proposal)

    if new_edges:
        # Add to cross_references
        site_index["cross_references"].extend(new_edges)

        # Update generated_at timestamp
        from datetime import datetime

        site_index["generated_at"] = datetime.utcnow().isoformat() + "Z"

        print(f"\\nUpdating site-index.json...")
        print(f"New cross_references count: {len(site_index['cross_references'])}")

        # Create backup
        backup_path = "S:/self-organizing-library/data/site-index.json.backup"
        with open(backup_path, "w", encoding="utf-8") as f:
            json.dump(site_index, f, indent=2)
        print(f"Backup created at {backup_path}")

        # Save updated file
        save_site_index(site_index)
        print("site-index.json updated successfully!")

        # Show summary
        print(f"\\nSummary:")
        print(f"- Added {len(new_edges)} new cross-category link edges")
        print(f"- Total cross_references: {len(site_index['cross_references'])}")
    else:
        print("No new edges to add.")


if __name__ == "__main__":
    main()
