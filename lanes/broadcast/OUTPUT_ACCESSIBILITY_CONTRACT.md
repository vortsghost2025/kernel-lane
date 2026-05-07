# OUTPUT_ACCESSIBILITY_CONTRACT.md — Mandatory Output Format for All Agents

**Version:** 1.0
**Status:** ACTIVE — Operator Ratified
**Effective:** 2026-05-05
**Applies to:** ALL agents, ALL lanes, ALL roles (archivist, library, swarmmind, kernel, ubuntu-bridge-operator, exterior)

---

## 1. Purpose

The operator is low-vision and uses multiple AI agents simultaneously. Output format is an accessibility requirement, not a style preference. Non-compliant output creates operational risk.

---

## 2. OUTPUT_PROVENANCE — Mandatory on Every Response

Every response from every agent MUST end with this block, exactly this shape:

```text
OUTPUT_PROVENANCE:
agent: <agent/model/name>
lane: <lane or role>
target: <specific action/context>
```

Rules:
1. Do not omit it.
2. Do not leave fields blank.
3. Do not paraphrase the label — it must say `OUTPUT_PROVENANCE:`.
4. Do not put it only in audit logs — it goes in the visible response.
5. Do not treat it as optional.
6. If you do not know the exact lane, write the best known role (e.g., `ubuntu-bridge-operator`, `archivist`, `swarmmind`, `library`, `kernel`, `exterior-unknown`).
7. Any response missing `OUTPUT_PROVENANCE` is non-compliant.
8. **One field per line. Never compress to a single line.** One-line provenance is formatting-invalid.

Minimum valid example:

```text
OUTPUT_PROVENANCE:
agent: Ubuntu Bridge Operator
lane: ubuntu-bridge-operator
target: headless Ubuntu runtime supervision
```

---

## 3. Command Accessibility — Mandatory When Providing Commands

When giving the operator commands to run, format for low-vision copy/paste use.

Required command format:

1. Put a **blank line** before and after every command block.
2. Put commands **only inside fenced code blocks** (```bash ... ```).
3. Do **not** bury commands inside paragraphs.
4. Do **not** mix explanation and commands in the same code block.
5. Label every command block by risk level:
- `SAFE READ-ONLY`
- `LOW-RISK WRITE`
- `DANGEROUS / DESTRUCTIVE`
6. Prefer **one clear command block per action**.
7. For dangerous commands, add a **plain warning line** immediately above the block.
8. Keep explanations **short and separate** from commands.
9. **If it is meant to be copied into a terminal, it must be in its own fenced block with blank space above and below.**

### Example — SAFE READ-ONLY

SAFE READ-ONLY — check live lane workers

```bash
ps -eo pid,lstart,%cpu,%mem,cmd | grep -E "lane-worker.js|heartbeat.js" | grep -v grep
```

### Example — LOW-RISK WRITE

LOW-RISK WRITE — append UBO audit entry

```bash
printf '%s\n' '{"timestamp":"2026-05-05T00:00:00Z","action":"example","target":"example"}' >> /home/we4free/agent/logs/ubo-audit.jsonl
```

### Example — DANGEROUS / DESTRUCTIVE

⚠️ WARNING: This kills a process. Verify the PID before running.

DANGEROUS / DESTRUCTIVE — stop a specific stale process

```bash
kill <PID>
```

---

## 4. Enforcement

- Non-compliant responses (missing provenance, inline commands, compressed provenance) must be treated as output-contract failures.
- Lanes verifying cross-lane messages should check for `OUTPUT_PROVENANCE` in message bodies.
- The UBO logs compliance status in `ubo-audit.jsonl`.

---

## 5. Version History

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-05-05 | Initial creation — operator-ratified accessibility contract |

---

**See Also:**
- RECIPROCAL_ACCOUNTABILITY.md — Mutual protection
- UBUNTU_BRIDGE_OPERATOR.md — UBO governance declaration
- GOVERNANCE.md — Rules (what we follow)
