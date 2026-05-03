#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

AGENT_ROOT="$HOME/agent"
REPOS_DIR="$AGENT_ROOT/repos"
ARTIFACTS_DIR="$AGENT_ROOT/artifacts"
LOG_DIR="$AGENT_ROOT/logs"
LOCK_FILE="$AGENT_ROOT/runner.lock"
LOG_FILE="$LOG_DIR/agent.log"

mkdir -p "$ARTIFACTS_DIR" "$LOG_DIR"

if ! mkdir "$LOCK_FILE" 2>/dev/null; then
    echo "$(date -Iseconds) [WARN] Runner already running, exiting" >> "$LOG_FILE"
    exit 0
fi
trap 'rmdir "$LOCK_FILE" 2>/dev/null' EXIT

log() { echo "$(date -Iseconds) $1" >> "$LOG_FILE"; }

REPOS=("kernel-lane" "Archivist-Agent" "self-organizing-library" "SwarmMind")
REPO_URLS=(
    "https://github.com/vortsghost2025/kernel-lane.git"
    "https://github.com/vortsghost2025/Archivist-Agent.git"
    "https://github.com/vortsghost2025/self-organizing-library.git"
    "https://github.com/vortsghost2025/SwarmMind-Self-Optimizing-Multi-Agent-AI-System.git"
)

clone_if_missing() {
    local name="$1" url="$2"
    if [ ! -d "$REPOS_DIR/$name" ]; then
        log "[INFO] Cloning $name..."
        git clone --depth 1 "$url" "$REPOS_DIR/$name" 2>> "$LOG_FILE" || log "[ERROR] Failed to clone $name"
    fi
}

pull_latest() {
    local name="$1"
    local dir="$REPOS_DIR/$name"
    if [ -d "$dir" ]; then
        log "[INFO] Pulling latest for $name..."
        # Stash any local changes to avoid conflicts, then pull
        if git -C "$dir" diff-index --quiet HEAD 2>/dev/null; then
            # No local changes
            git -C "$dir" pull 2>> "$LOG_FILE" || log "[ERROR] Pull failed for $name"
        else
            # Has local changes
            log "[WARN] $dir has local changes, stashing before pull"
            git -C "$dir" stash 2>> "$LOG_FILE" && \
            git -C "$dir" pull 2>> "$LOG_FILE" && \
            git -C "$dir" stash pop 2>> "$LOG_FILE" || \
            log "[ERROR] Pull or stash operations failed for $name"
        fi
    fi
}

task_sovereignty_scan() {
    log "[TASK] Sovereignty scan across all lanes..."
    local result_file="$ARTIFACTS_DIR/sovereignty-scan-$(date +%Y%m%d-%H%M%S).json"
    local total_violations=0
    local total_lanes=0
    local compliant_lanes=0
    local lane_results=""

    for repo in "${REPOS[@]}"; do
        local dir="$REPOS_DIR/$repo"
        if [ ! -d "$dir" ]; then
            log "[WARN] $repo not found, skipping"
            continue
        fi

        # Determine lane name from repo name
        local lane_name
        case "$repo" in
            kernel-lane) lane_name="Kernel" ;;
            Archivist-Agent) lane_name="Archivist" ;;
            self-organizing-library) lane_name="Library" ;;
            SwarmMind) lane_name="swarmmind" ;;
            *) lane_name="$repo" ;;
        esac

        total_lanes=$((total_lanes + 1))

        # Use the lane's fine-tuned sovereignty enforcer (supports --lane flag with case-insensitive matching)
        local enforcer="$dir/scripts/sovereignty-enforcer.js"
        if [ ! -f "$enforcer" ]; then
            log "[WARN] Sovereignty enforcer not found in $repo, skipping"
            continue
        fi

        log "[TASK] Running sovereignty scan for $lane_name ($repo)..."
        local report_file="$dir/lanes/$lane_name/state/sovereignty-report-latest.json"

        # Remove old report so we know if new one was generated
        rm -f "$report_file" 2>/dev/null

        if node "$enforcer" --lane "$lane_name" --strict >/dev/null 2>&1; then
            compliant_lanes=$((compliant_lanes + 1))
            local violations=0
            # Try to extract violation count from report
            if [ -f "$report_file" ]; then
                violations=$(node -e "try{const r=require('$report_file');console.log(r.violations||0)}catch(e){console.log(0)}" 2>/dev/null || echo 0)
            fi
            total_violations=$((total_violations + violations))
            log "[PASS] $lane_name: sovereignty-compliant"
            lane_results="$lane_results\n    \"$lane_name\": {\"status\":\"compliant\",\"violations\":$violations}"
        else
            # Count violations from report if available
            local violations=1
            if [ -f "$report_file" ]; then
                violations=$(node -e "try{const r=require('$report_file');console.log(r.violations||1)}catch(e){console.log(1)}" 2>/dev/null || echo 1)
            fi
            total_violations=$((total_violations + violations))
            log "[VIOLATION] $lane_name: $violations cross-lane import violation(s)"
            lane_results="$lane_results\n    \"$lane_name\": {\"status\":\"violations_found\",\"violations\":$violations}"
        fi
    done

    cat > "$result_file" <<JSONEOF
{
    "task": "sovereignty_scan",
    "timestamp": "$(date -Iseconds)",
    "total_violations": $total_violations,
    "total_lanes_scanned": $total_lanes,
    "compliant_lanes": $compliant_lanes,
    "lane_results": {$lane_results
    },
    "status": "$([ "$total_violations" -eq 0 ] && echo "compliant" || echo "violations_found")"
}
JSONEOF
    log "[TASK] Sovereignty scan complete: $total_violations violations across $total_lanes lanes -> $result_file"
}
JSONEOF
    log "[TASK] Sovereignty scan complete: $violations violations -> $result_file"
}

task_graph_analysis() {
    log "[TASK] Graph analysis..."
    local snapshot_dir="$REPOS_DIR/kernel-lane/evidence/graph-snapshots"
    if [ ! -d "$snapshot_dir" ]; then
        log "[WARN] No graph snapshots found"
        return
    fi
    local latest
    latest=$(ls -t "$snapshot_dir"/*.json 2>/dev/null | head -1)
    if [ -z "$latest" ]; then
        log "[WARN] No snapshot JSON files found"
        return
    fi
    local result_file="$ARTIFACTS_DIR/graph-analysis-$(date +%Y%m%d-%H%M%S).json"
    local total verified unverified conflicted quarantined
    total=$(node -e "const d=require('$latest');const e=d.entries||[];console.log(e.length)" 2>> "$LOG_FILE" || echo 0)
    verified=$(node -e "const d=require('$latest');const e=d.entries||[];console.log(e.filter(x=>x.bridgeState==='verified').length)" 2>> "$LOG_FILE" || echo 0)
    unverified=$(node -e "const d=require('$latest');const e=d.entries||[];console.log(e.filter(x=>x.bridgeState==='unknown'||!x.bridgeState).length)" 2>> "$LOG_FILE" || echo 0)
    conflicted=$(node -e "const d=require('$latest');const e=d.entries||[];console.log(e.filter(x=>x.bridgeState==='contradicted').length)" 2>> "$LOG_FILE" || echo 0)

    cat > "$result_file" <<JSONEOF
{
    "task": "graph_analysis",
    "timestamp": "$(date -Iseconds)",
    "snapshot": "$(basename "$latest")",
    "total": $total,
    "verified": $verified,
    "unverified": $unverified,
    "conflicted": $conflicted
}
JSONEOF
    log "[TASK] Graph analysis: $total total, $verified verified, $unverified unverified, $conflicted conflicted -> $result_file"
}

task_health_report() {
    log "[TASK] Health report..."
    local result_file="$LOG_DIR/node-health.json"
    local uptime_s disk_free mem_free node_ver
    uptime_s=$(cat /proc/uptime | awk '{print int($1)}')
    disk_free=$(df -h /home/we4free | awk 'NR==2{print $4}')
    mem_free=$(free -m | awk '/Mem:/{print $4}')
    node_ver=$(node --version 2>> "$LOG_FILE" || echo "unknown")

    cat > "$result_file" <<JSONEOF
{
    "task": "health_report",
    "timestamp": "$(date -Iseconds)",
    "uptime_seconds": $uptime_s,
    "disk_free": "$disk_free",
    "mem_free_mb": $mem_free,
    "node_version": "$node_ver",
    "repos_cloned": ${#REPOS[@]},
    "runner_version": "2.0"
}
JSONEOF
    log "[TASK] Health report -> $result_file"
}

task_inbox_watch() {
    log "[TASK] Inbox watch across all lanes..."
    for repo in "${REPOS[@]}"; do
        local inbox_dir="$REPOS_DIR/$repo/lanes"
        if [ ! -d "$inbox_dir" ]; then
            continue
        fi
        local lane_name
        case "$repo" in
            kernel-lane) lane_name="kernel" ;;
            Archivist-Agent) lane_name="archivist" ;;
            self-organizing-library) lane_name="library" ;;
            SwarmMind) lane_name="swarmmind" ;;
        esac
        local inbox="$REPOS_DIR/$repo/lanes/$lane_name/inbox"
        if [ -d "$inbox" ]; then
            local msg_count
            msg_count=$(find "$inbox" -maxdepth 1 -name "*.json" ! -name "heartbeat-*.json" 2>/dev/null | wc -l || echo 0)
            if [ "$msg_count" -gt 0 ]; then
                log "[INFO] $lane_name inbox: $msg_count pending messages"
            fi
        fi
    done
}

log "========== Runner v2.0 starting =========="

for i in "${!REPOS[@]}"; do
    clone_if_missing "${REPOS[$i]}" "${REPO_URLS[$i]}"
done

for repo in "${REPOS[@]}"; do
    pull_latest "$repo"
done

task_sovereignty_scan
task_graph_analysis
task_health_report
task_inbox_watch

log "========== Runner v2.0 complete =========="
