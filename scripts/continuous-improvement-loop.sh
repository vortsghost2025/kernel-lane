#!/usr/bin/env bash
set -eo pipefail
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

NODE="/home/we4free/.nvm/versions/node/v20.20.2/bin/node"
REPOS_DIR="$HOME/agent/repos"
LOG_DIR="$HOME/agent/logs"
CYCLE_LOG="$LOG_DIR/continuous-improvement.log"
STATE_FILE="$LOG_DIR/ci-cycle-state.json"
CYCLE_INTERVAL_SEC="${CI_CYCLE_INTERVAL:-120}"

mkdir -p "$LOG_DIR"

log() { echo "$(date -Iseconds) $1" >> "$CYCLE_LOG"; }

lane_to_repo() {
  case "$1" in
    kernel) echo "kernel-lane" ;;
    swarmmind) echo "SwarmMind" ;;
    library) echo "self-organizing-library" ;;
    archivist) echo "Archivist-Agent" ;;
  esac
}

IMPROVEMENT_TASKS="stale-file-cleanup hygiene-scan inbox-process journal-backfill git-housekeeping sovereignty-verify heartbeat-refresh broadcast-sync"

task_stale_file_cleanup() {
  local lane="$1" repo="$2" dir="$REPOS_DIR/$repo"
  log "[CI:$lane] Stale file cleanup..."
  local count=0
  for d in "$dir/lanes/$lane/inbox/stale" "$dir/lanes/$lane/inbox/expired"; do
    if [ -d "$d" ]; then
      local n
      n=$(find "$d" -name "*.json" -mtime +7 2>/dev/null | wc -l || echo 0)
      if [ "$n" -gt 0 ]; then
        find "$d" -name "*.json" -mtime +7 -delete 2>/dev/null || true
        count=$((count + n))
      fi
    fi
  done
  log "[CI:$lane] Stale cleanup: removed $count files older than 7d"
}

task_hygiene_scan() {
  local lane="$1" repo="$2" dir="$REPOS_DIR/$repo"
  log "[CI:$lane] Hygiene scan..."
  if [ -f "$dir/scripts/hygiene-scanner.js" ]; then
    $NODE "$dir/scripts/hygiene-scanner.js" --lane "$lane" --apply 2>&1 | tail -1 >> "$CYCLE_LOG" || true
  else
    log "[CI:$lane] No hygiene-scanner.js, skip"
  fi
}

task_inbox_process() {
  local lane="$1" repo="$2" dir="$REPOS_DIR/$repo"
  log "[CI:$lane] Inbox processing..."
  timeout 60 $NODE "$dir/scripts/autonomous-executor.js" "$lane" --apply --once 2>&1 | tail -3 >> "$CYCLE_LOG" || true
}

task_journal_backfill() {
  local lane="$1" repo="$2" dir="$REPOS_DIR/$repo"
  log "[CI:$lane] Journal backfill..."
  if [ -f "$dir/scripts/store-journal.js" ]; then
    timeout 30 $NODE "$dir/scripts/store-journal.js" daily 2>&1 | tail -1 >> "$CYCLE_LOG" || true
  fi
}

task_git_housekeeping() {
  local lane="$1" repo="$2" dir="$REPOS_DIR/$repo"
  log "[CI:$lane] Git housekeeping..."
  if ! git -C "$dir" diff-index --quiet HEAD 2>/dev/null; then
    log "[CI:$lane] Uncommitted changes found, staging and committing..."
    git -C "$dir" add -A 2>/dev/null || true
    git -C "$dir" commit -m "[CI:$lane] Auto-commit: housekeeping cycle $(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  fi
  local branch
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
    git -C "$dir" pull --rebase origin "$branch" 2>/dev/null || log "[CI:$lane] Pull rebase failed (may need manual fix)"
  git -C "$dir" push origin "$branch" 2>/dev/null || log "[CI:$lane] Push failed (may need manual fix)"
}

task_sovereignty_verify() {
  local lane="$1" repo="$2" dir="$REPOS_DIR/$repo"
  log "[CI:$lane] Sovereignty verify..."
  if [ -f "$dir/scripts/cicd-sovereignty-gates.js" ]; then
    timeout 30 $NODE "$dir/scripts/cicd-sovereignty-gates.js" --lane "$lane" 2>&1 | tail -1 >> "$CYCLE_LOG" || true
  fi
}

task_heartbeat_refresh() {
  local lane="$1" repo="$2" dir="$REPOS_DIR/$repo"
  log "[CI:$lane] Heartbeat refresh..."
  if [ -f "$dir/scripts/heartbeat.js" ]; then
    LANE_NAME="$lane" timeout 30 $NODE "$dir/scripts/heartbeat.js" --once 2>&1 | tail -1 >> "$CYCLE_LOG" || true
  fi
}

task_broadcast_sync() {
  log "[CI:broadcast] Sync broadcast artifacts..."
  if [ -f "$REPOS_DIR/Archivist-Agent/scripts/sync-all-lanes.js" ]; then
    $NODE "$REPOS_DIR/Archivist-Agent/scripts/sync-all-lanes.js" --dry-run 2>&1 | tail -5 >> "$CYCLE_LOG" || true
  fi
}

run_task() {
  local task="$1" lane="$2" repo="$3"
  case "$task" in
    stale-file-cleanup) task_stale_file_cleanup "$lane" "$repo" ;;
    hygiene-scan) task_hygiene_scan "$lane" "$repo" ;;
    inbox-process) task_inbox_process "$lane" "$repo" ;;
    journal-backfill) task_journal_backfill "$lane" "$repo" ;;
    git-housekeeping) task_git_housekeeping "$lane" "$repo" ;;
    sovereignty-verify) task_sovereignty_verify "$lane" "$repo" ;;
    heartbeat-refresh) task_heartbeat_refresh "$lane" "$repo" ;;
    broadcast-sync) task_broadcast_sync ;;
  esac
}

write_state() {
  local cycle="$1" task="$2" lane="$3"
  printf '{"cycle":%s,"current_task":"%s","current_lane":"%s","timestamp":"%s","pid":%s}\n' \
    "$cycle" "$task" "$lane" "$(date -Iseconds)" "$$" > "$STATE_FILE"
}

cycle=0
log "========== Continuous Improvement Loop starting (interval=${CYCLE_INTERVAL_SEC}s) =========="

while true; do
  cycle=$((cycle + 1))
  log "---------- Cycle $cycle ----------"

  for lane in kernel swarmmind library archivist; do
    local_repo=$(lane_to_repo "$lane")

    for task in $IMPROVEMENT_TASKS; do
      write_state "$cycle" "$task" "$lane"
      run_task "$task" "$lane" "$local_repo" 2>/dev/null || log "[CI:$lane] Task $task FAILED (non-fatal, continuing)"
    done

    log "[CI:$lane] Cycle $cycle complete for $lane"
  done

  log "---------- Cycle $cycle complete, sleeping ${CYCLE_INTERVAL_SEC}s ----------"
  sleep "$CYCLE_INTERVAL_SEC"
done
