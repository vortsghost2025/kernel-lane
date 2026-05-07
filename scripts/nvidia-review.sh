#!/usr/bin/env bash
set -euo pipefail
PROMPT="$*"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-node}"

exec "$NODE" "$SCRIPT_DIR/ai-review.js" strong "$PROMPT"
