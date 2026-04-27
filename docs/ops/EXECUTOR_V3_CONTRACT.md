# Executor v3 Command Contract

**Version:** 3.0.0
**Canonical source:** `scripts/generic-task-executor.js`
**Date:** 2026-04-27
**Status:** LOCKED — no verb additions without golden test coverage

## Verb Registry (11 verbs)

| # | Verb | Syntax | Input Schema | Output Shape | Bounds |
|---|------|--------|-------------|--------------|--------|
| 1 | status | `status` / NLP | none | `{ processed_count, quarantine_count, blocked_count, action_required_count, trust_store_key_id, system_state }` | read-only |
| 2 | read file | `read file <path>` | path string | `{ type: "file"|"directory", path, size?, content?, entries? }` | 50KB content limit, 100 dir entries |
| 3 | run script | `run script <name>` | script name | `{ script, exit_code, output?, error?, passed?, failed? }` | 30s timeout, daemons auto-skip |
| 4 | git | `git <status|log|diff|branch|remote>` | subcommand + args | `{ git: subcmd, output }` | read-only subcmds, 15s timeout, shell metachar blocked |
| 5 | grep | `grep "pattern" in <path>` | pattern + path | `{ grep: pattern, matches: count, output }` | 30KB output, 15s timeout |
| 6 | write file | `write file <path>\n<content>` | path + content | `{ written: path, bytes: number }` | 10KB max, own-lane only, governance files blocked |
| 7 | consistency check | `consistency check` / NLP | none | `{ check_type, output }` | 60s timeout, 100KB output |
| 8 | list dir | `list dir <path>` / `ls <path>` | path string | `{ path, entries: [{name, type, size, modified}], count }` | allowed-roots only |
| 9 | hash file | `hash file <path>` / `sha256 <path>` | path string | `{ path, size, sha256, modified }` | 50MB file limit, allowed-roots only |
| 10 | diff | `diff <f1> <f2>` / `compare <f1> with <f2>` | two paths | `{ file1, file2, identical, total_lines_1, total_lines_2, diff_count, diffs: [{line, left, right}], truncated }` | 10MB file limit, 200 diff max, 100 returned, 200-char line truncation |
| 11 | count | `count "pattern" in <path>` | pattern + file/dir path | `{ file|path, pattern, count, files_scanned? }` | dir: 500 files max, 5MB total scan |

## NLP Routing (12 pattern groups)

| Route | Patterns (regex) | Target Verb |
|-------|------------------|-------------|
| trust integrity | `/trust.?store/`, `/trust.?integrit/`, `/key.?valid/`, `/identit.?health/` | consistency check |
| consistency | `/check.*consist/`, `/system.?health/`, `/is.*consist/`, `/are.*lanes.*sync/`, `/cross.?lane.*check/` | consistency check |
| inbox count | `/how many.*process/`, `/inbox.*count/`, `/message.*count/`, `/what.*status/`, `/lane.*status/` | status |
| directory listing | `/what.*in.*dir/`, `/show.*folder/`, `/list.*file/`, `/what.*file.*exist/`, `/dir.*content/` | list dir |
| file change | `/is.*file.*same/`, `/file.*chang/`, `/has.*modif/`, `/file.*identical/`, `/doc.*chang/`, `/governance.*chang/` | diff |
| integrity check | `/verif.*integrit/`, `/file.*hash/`, `/checksum/`, `/sha.*of/` | hash file |
| occurrence count | `/how many.*(?:occurrence|instance|match)/`, `/count.*pattern/`, `/how often/` | count |
| file content | `/show.*content/`, `/cat.*file/`, `/what.*in.*file/`, `/read.*content/`, `/display.*file/` | read file |
| text search | `/find.*text/`, `/where.*mention/`, `/where.*defin/`, `/search.*for/` | grep |
| commit history | `/latest.*commit/`, `/recent.*change/`, `/commit.*hist/`, `/what.*chang/` | git log |
| working tree | `/uncommit/`, `/stag/`, `/dirty/`, `/modif.*file/` | git status |
| test execution | `/run.*test/`, `/execut.*test/`, `/run.*bench/` | run script |

## Routing Priority (first match wins)

1. Explicit `task_kind` match (`status`)
2. Explicit verb syntax in body (`list dir`, `hash file`, `diff`, `count`, `read file`, `run script`, `git`, `grep`, `write`, `consistency check`)
3. NLP pattern match (12 groups, checked in order)
4. Fallback: acknowledge with verb list

## Response Schema (canonical)

```json
{
  "task_kind": "status|report|ack",
  "results": { },
  "summary": "human-readable one-liner"
}
```

- `task_kind=report` for all successful verb executions
- `task_kind=ack` for unrecognized tasks (fallback)
- `results.error` present on any failure

### Ownership Enforcement Metadata

When lane processing runs with `--enforce-ownership`, downstream lane-worker metadata includes:

- `_lane_worker.enforce_ownership: true`
- `_lane_worker.ownership: object`
- `_lane_worker.ownership_notes: string[]`

Response validation rule:

- If `_lane_worker.enforce_ownership === true`, both `_lane_worker.ownership` and `_lane_worker.ownership_notes` are required.

## Truncation Policy

| Verb | Limit | On Exceed |
|------|-------|-----------|
| read file | 50KB content | Truncate + append `... TRUNCATED (50KB limit)` |
| read file (dir) | 100 entries | Return first 100 |
| run script | 50KB output | Truncate |
| git | 30KB output | Truncate |
| grep | 30KB output | Truncate |
| write file | 10KB content | Reject with error |
| diff | 10MB file size, 200 differences max, 100 returned, 200-char lines | Reject oversized + truncate diffs + `truncated: true` |
| hash file | 50MB file size | Reject with error |
| count (dir) | 500 files, 5MB total | Stop scanning at limits |
| consistency check | 100KB output | Truncate |

## Safety Constraints

- **Path allowlist:** `isPathAllowed()` — all file verbs require path within LANE_REGISTRY roots or os.tmpdir()
  - No escape hatches: the old `C:/` bypass is removed
  - Exported for direct testing: `require('./generic-task-executor').isPathAllowed(path)`
- **Write scope:** Own-lane-only (normalized path must start with lane root)
- **Write denylist:** `trust-store.json`, `active-blocker.json`, `system_state.json`, `contradictions.json`, `.identity/`, `.trust/`, `BOOTSTRAP.md`, `GOVERNANCE.md`, `COVENANT.md`, `AGENTS.md`
- **Git allowlist:** `status`, `log`, `diff`, `branch`, `remote` only
- **Shell metacharacters:** `[;&|$`]` blocked in git args
- **Daemon skip:** `heartbeat`, `inbox-watcher`, `relay-daemon` cannot be `run script` targets

## Golden Test Suite (56 tests)

| Category | Count | Coverage |
|----------|-------|----------|
| Verb: status | 2 | explicit + NLP |
| Verb: read file | 2 | content + directory |
| Verb: run script | 2 | missing + daemon skip |
| Verb: git | 3 | status + disallowed + shell metachar |
| Verb: grep | 2 | pattern search + no pattern error |
| Verb: write file | 3 | outside lane + governance blocked + 10KB limit |
| Verb: consistency | 2 | explicit + NLP |
| Verb: list dir | 3 | entries + shape + outside roots |
| Verb: hash file | 3 | sha256 + deterministic + alias |
| Verb: diff | 4 | identical + different + compare alias + missing path |
| Verb: count | 3 | occurrences + zero + directory mode |
| NLP routing | 8 | 7 phrases + 12 route groups check |
| Adversarial | 9 | empty + gibberish + conflict + traversal x2 + git x2 + trust-store + .identity |
| Safety rails | 8 | grep/count/diff outside roots + BOOTSTRAP/GOVERNANCE/contradictions write + isPathAllowed unit x2 |
| Determinism | 2 | status + hash |

## Compatibility Guarantee

- Adding new verbs: OK, does not break existing routing
- Adding NLP patterns: OK, must not shadow existing verb syntax matches
- Changing verb output shape: BREAKING — requires major version bump
- Changing routing priority: BREAKING — requires golden test update
- Changing truncation limits: NON-BREAKING if increased, BREAKING if decreased
