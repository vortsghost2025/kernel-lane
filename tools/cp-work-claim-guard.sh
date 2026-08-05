#!/usr/bin/env bash
# cp-work-claim-guard.sh — Pre-commit work claim conflict detector
# Called by .git/hooks/pre-commit in each lane repo.
# Exits 0 if no conflict, 1 if another agent has claimed the files.
# Override: SKIP_WORK_CLAIM_CHECK=1 git commit ...

set -euo pipefail

PYTHON=""
if command -v python3 &>/dev/null && python3 --version &>/dev/null; then
  PYTHON="python3"
elif command -v python &>/dev/null && python --version &>/dev/null; then
  PYTHON="python"
elif command -v py &>/dev/null && py --version &>/dev/null; then
  PYTHON="py"
else
  echo "[work-claim-guard] WARNING: No python found — skipping work claim check"
  exit 0
fi

if [ "${SKIP_WORK_CLAIM_CHECK:-0}" = "1" ]; then
  exit 0
fi

CURRENT_AGENT="${WORK_CLAIM_AGENT:-$(git config user.name 2>/dev/null || echo 'unknown')}"
PLATFORM="$(uname -s 2>/dev/null || echo 'unknown')"

if [[ "$PLATFORM" == MINGW* ]] || [[ "$PLATFORM" == MSYS* ]] || [[ "$PLATFORM" == CYGWIN* ]]; then
    REPO_BASES=("S:/")
    LANE_MAP=(
        "control-plane:S:/WE4FREE-Control-Plane/lanes/control-plane/state/work-claim.json"
        "archivist:S:/Archivist-Agent/lanes/archivist/state/work-claim.json"
        "swarmmind:S:/SwarmMind/lanes/swarmmind/state/work-claim.json"
        "kernel:S:/kernel-lane/lanes/kernel/state/work-claim.json"
        "library:S:/self-organizing-library/lanes/library/state/work-claim.json"
        "kucoin:S:/kucoin-lane/lanes/kucoin/state/work-claim.json"
        "lattice-deck:S:/WE4FREE-Lattice-Deck/.work-claim.json"
        "research-intake:S:/WE4FREE-Research-Intake/.work-claim.json"
    )
else
    REPO_BASE="/home/we4free/agent/repos"
    LANE_MAP=(
        "control-plane:${REPO_BASE}/WE4FREE-Control-Plane/lanes/control-plane/state/work-claim.json"
        "archivist:${REPO_BASE}/Archivist-Agent/lanes/archivist/state/work-claim.json"
        "swarmmind:${REPO_BASE}/SwarmMind/lanes/swarmmind/state/work-claim.json"
        "kernel:${REPO_BASE}/kernel-lane/lanes/kernel/state/work-claim.json"
        "library:${REPO_BASE}/self-organizing-library/lanes/library/state/work-claim.json"
        "kucoin:${REPO_BASE}/kucoin-lane/lanes/kucoin/state/work-claim.json"
        "lattice-deck:${REPO_BASE}/WE4FREE-Lattice-Deck/.work-claim.json"
        "research-intake:${REPO_BASE}/WE4FREE-Research-Intake/.work-claim.json"
    )
fi

STAGED_FILES=$(git diff --cached --name-only 2>/dev/null || true)
if [ -z "$STAGED_FILES" ]; then
    exit 0
fi

CONFLICTS=()

for entry in "${LANE_MAP[@]}"; do
    LANE="${entry%%:*}"
    CLAIM_PATH="${entry#*:}"

    [ -f "$CLAIM_PATH" ] || continue

    AGENT=$($PYTHON -c "
import json,sys,datetime
try:
    d=json.load(open('$CLAIM_PATH'))
    if d.get('status')!='in_progress': sys.exit(1)
    exp=d.get('claim_expires','')
    if exp:
        exp_clean=exp.rstrip('Z')
        dt=datetime.datetime.strptime(exp_clean,'%Y-%m-%dT%H:%M:%S')
        dt_utc=dt.replace(tzinfo=datetime.timezone.utc)
        if datetime.datetime.now(datetime.timezone.utc)>dt_utc+datetime.timedelta(minutes=5): sys.exit(1)
    print(d.get('agent','unknown'))
except: sys.exit(1)
" 2>/dev/null || continue)

    [ -n "$AGENT" ] || continue

    if [ "$AGENT" = "$CURRENT_AGENT" ]; then
        continue
    fi

    CLAIMED_FILES=$($PYTHON -c "
import json,sys
try:
    d=json.load(open('$CLAIM_PATH'))
    files=d.get('files',[])
    if not files:
        print('**LANE_WIDE**')
    else:
        print('\n'.join(files))
except: sys.exit(1)
" 2>/dev/null || continue)

    if [ -z "$CLAIMED_FILES" ]; then
        continue
    fi

    while IFS= read -r staged; do
        while IFS= read -r claimed; do
            if [ "$claimed" = "**LANE_WIDE**" ]; then
                CONFLICTS+=("  $staged  ←  LANE-WIDE claim by $AGENT on $LANE")
                break 2
            fi
            if [ "$staged" = "$claimed" ] || [[ "$staged" == */"$claimed" ]] || [[ "$claimed" == */"$staged" ]] || [[ "$staged" == "$claimed"* ]]; then
                CONFLICTS+=("  $staged  ←  claimed by $AGENT on $LANE ($claimed)")
                break 2
            fi
        done <<< "$CLAIMED_FILES"
    done <<< "$STAGED_FILES"
done

if [ ${#CONFLICTS[@]} -gt 0 ]; then
    echo ""
    echo "❌ WORK CLAIM CONFLICT — commit blocked"
    echo ""
    echo "Another agent has active work claims that overlap with your staged files:"
    echo ""
    for c in "${CONFLICTS[@]}"; do
        echo "$c"
    done
    echo ""
    echo "Options:"
    echo "  1. Wait for the other agent to release their claim"
    echo "  2. Coordinate with the other agent to avoid conflicts"
    echo "  3. Override (emergency only): SKIP_WORK_CLAIM_CHECK=1 git commit ..."
    echo ""
    exit 1
fi

exit 0

