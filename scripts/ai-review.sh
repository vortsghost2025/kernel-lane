#!/usr/bin/env bash
set -euo pipefail
TIER="${1:-auto}"
shift 2>/dev/null || true
PROMPT="$*"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-node}"

exec "$NODE" "$SCRIPT_DIR/ai-review.js" "$TIER" "$PROMPT"
