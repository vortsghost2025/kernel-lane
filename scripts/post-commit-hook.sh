#!/bin/sh
# Post-commit hook: Auto-journal every commit to store-journal
# Installed by scripts/setup-hooks.js
# Non-blocking — journal failure does NOT block the commit

REPO_ROOT=$(git rev-parse --show-toplevel)
COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_MSG=$(git log -1 --format='%s')
LANE_NAME=$(basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]')

case "$LANE_NAME" in
  archivist-agent) LANE=archivist ;;
  kernel-lane) LANE=kernel ;;
  self-organizing-library) LANE=library ;;
  swarmmind*) LANE=swarmmind ;;
  *) LANE=unknown ;;
esac

if [ -f "$REPO_ROOT/scripts/store-journal.js" ]; then
  CHANGED_FILES=$(git diff-tree --no-commit-id --name-only -r HEAD | tr '\n' ',' | sed 's/,$//')
  node "$REPO_ROOT/scripts/store-journal.js" append \
    --lane "$LANE" \
    --event work_completed \
    --agent "git-post-commit" \
    --session-id "git-${COMMIT_SHA}" \
    --target "$COMMIT_MSG" \
    --intent "auto-journal from git post-commit hook" \
    --files "$CHANGED_FILES" \
    --data "{\"commit_sha\":\"$COMMIT_SHA\",\"auto\":true}" \
    2>/dev/null || true
fi
# test
