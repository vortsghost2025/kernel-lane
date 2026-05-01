# Kernel.json Snapshot Analysis

## Snapshot Metadata
- **Snapshot ID**: snapshot-2026-04-30-16-13-36
- **Created At**: 2026-04-30T20:13:36.281Z
- **Created By**: operator
- **Repo Filter**: kernel-lane
- **Meaning Layers**: structure, verification, conflicts, execution, governance
- **Density Mode**: focus
- **Visible Node Count**: 215
- **Visible Edge Count**: 44,097
- **Total Available Nodes**: 3,589
- **Total Available Edges**: 44,097

## Status Distribution
- **Verified**: 25 nodes (11.6%)
- **Unverified**: 186 nodes (86.5%)
- **Conflicted**: 4 nodes (1.9%)
- **Quarantined**: 0 nodes (0.0%)

## Key Observations

### 1. Conflicted Nodes (Tag-Group Artifacts)
The snapshot shows 4 conflicted nodes, all with contradictionCount=39:
- `6a9bd95ba806a410`: THE SINGLE ENTRY POINT
- `d9ccbb98728d5f78`: COVENANT.md — Values (What We Believe)
- `7372a72fe280b3a3`: CAISC 2026 Draft Paper Review Report
- `dd9b2967fd3393db`: WE4FREE Publication Roadmap

These are consistent with the tag-group artifact we previously analyzed (K(40) complete graph from TAG_GROUP_LARGE_SAMPLE=40). Each node connects to the other 39 nodes in the group, creating the observed contradictionCount=39.

### 2. Verification Status
- High unverified rate (86.5%) is expected for a dynamic knowledge graph
- Verified nodes (25) show reasonable verification counts (0-79)
- The 4 conflicted nodes have verificationCount=0 (except COVENANT.md which shows 39 - this appears to be an inconsistency)

### 3. Authority Depth
All nodes show authorityDepth=75, suggesting either:
- A default value is being applied
- Authority calculation needs refresh
- This is a baseline value before lane-specific authority propagation

### 4. Cross-Lane Tagging
Nodes show appropriate cross-lane tagging:
- Kernel, Archivist, Library, Swarmmind tags present on many nodes
- Proper categorization by lane and function

### 5. Node Types
Mix of document types:
- `doc`: Primary content nodes
- `data`: JSON files, reports, configs
- `code`: JavaScript/TypeScript files
- `schema`: JSON schema definitions

## Workflow Implications

### What's Working Correctly
1. **Cross-lane visibility**: Kernel lane can see the full Library index (3,589 total nodes)
2. **Tag propagation**: Cross-lane tags (Kernel, Archivist, Library, Swarmmind) are properly propagating
3. **Structure preservation**: The 44,097 edge count indicates full connectivity is maintained
4. **Basic status tracking**: Verified/unverified/conflicted states are being tracked

### Areas for Workflow Attention
1. **Conflict Resolution**: The 4 conflicted nodes with contradictionCount=39 are known tag-group artifacts. Consider:
   - Running the contradiction batch response workflow to mark these as proven_spurious
   - Updating the merge table in Archivist context-buffer
   - Ensuring the contradiction detection logic properly identifies these as artifacts

2. **Verification Pipeline**: With 186 unverified nodes:
   - Check if automatic verification triggers are functioning
   - Consider prioritizing verification for high-authority nodes
   - Review if verification-count increments are working properly

3. **Authority Calculation**: Uniform authorityDepth=75 suggests:
   - Authority propagation may need refresh
   - Lane-specific authority calculations should be reviewed
   - Consider running authority recalculation workflow

4. **Node Classification**: Ensure new nodes are getting:
   - Proper categorization (kernel, benchmark, verification, etc.)
   - Appropriate initial tagging
   - Correct repo attribution

## Recommended Actions
1. **Run contradiction resolution workflow** on the 4 known artifact nodes
2. **Verify verification pipeline** is processing unverified nodes appropriately
3. **Check authority calculation** mechanisms are functioning
4. **Validate node classification** for recent additions
5. **Consider running a graph consistency check** to ensure all workflows are synchronized

The snapshot shows a healthy, active knowledge graph with expected characteristics of a developing system. The high unverified rate reflects ongoing content addition, while the conflicted nodes represent known artifacts that have already been analyzed and resolved in previous workflows.