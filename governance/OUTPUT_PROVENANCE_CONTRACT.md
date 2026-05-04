# OUTPUT_PROVENANCE Contract

## Requirement

Every agent response, handoff, report, audit note, generated instruction, or exterior-lane synthesis must begin with an `OUTPUT_PROVENANCE` block.

## Required Format

```text
OUTPUT_PROVENANCE:
agent: <agent/model/tool identity>
lane: <lane name>
target: <current task/request/artifact>
```

## Preferred Extended Format

```text
OUTPUT_PROVENANCE:
agent: <agent/model/tool identity>
lane: <lane name>
generated_at: <ISO-8601 timestamp if available>
session_id: <session id if available>
target: <current task/request/artifact>
```

## Required Fields

- `agent`: producing agent/model/tool identity
- `lane`: lane or role producing the output
- `target`: current task, artifact, user request, or destination

## Lane Defaults

- ChatGPT exterior review: `exterior-synthesis`
- Archivist: `governance-root`
- SwarmMind: `optimization-runtime`
- Library: `memory-verification`
- Kernel-Lane: `compiler-performance`

## Enforcement Rule

If an output does not begin with `OUTPUT_PROVENANCE`, it is structurally incomplete and must be treated as a format violation.

## Accessibility Reason

This block is required for Sean's accessibility, low-vision workflow, and multi-agent governance traceability. It is not decorative.

