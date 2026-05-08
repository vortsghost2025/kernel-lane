const fs = require('fs');
const path = require('path');

const preCommitContent = `#!/bin/sh
# Pre-commit hook: sovereignty + schema + lint + typecheck + journal preflight + work_started
# Installed by scripts/setup-hooks.js

echo "[pre-commit] Running sovereignty scan..."
REPO_ROOT=$(git rev-parse --show-toplevel)
COMMIT_MSG=$(git log -1 --format='%s' 2>/dev/null || echo "pre-commit")
GIT_SESSION_ID="git-$(date +%s)"

if [ -f "$REPO_ROOT/scripts/sovereignty-enforcer.js" ]; then
node "$REPO_ROOT/scripts/sovereignty-enforcer.js" || exit 1
fi

if [ -f "$REPO_ROOT/scripts/schema-compliance-check.js" ]; then
node "$REPO_ROOT/scripts/schema-compliance-check.js" || exit 1
fi

if [ -f "$REPO_ROOT/package.json" ] && grep -q '"lint"' "$REPO_ROOT/package.json"; then
echo "[pre-commit] Running npm lint..."
cd "$REPO_ROOT" && npm run lint || exit 1
fi

if [ -f "$REPO_ROOT/package.json" ] && grep -q '"typecheck"' "$REPO_ROOT/package.json"; then
echo "[pre-commit] Running npm typecheck..."
cd "$REPO_ROOT" && npm run typecheck || exit 1
fi

STAGED_FILES=$(git diff --cached --name-only | tr '\\n' ',' | sed 's/,$//')
if [ -f "$REPO_ROOT/scripts/store-journal.js" ] && [ -n "$STAGED_FILES" ]; then
LANE_NAME=$(basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]')
case "$LANE_NAME" in
archivist-agent) LANE=archivist ;;
kernel-lane) LANE=kernel ;;
self-organizing-library) LANE=library ;;
swarmmind*) LANE=swarmmind ;;
*) LANE=unknown ;;
esac
node "$REPO_ROOT/scripts/store-journal.js" preflight --lane "$LANE" --paths "$STAGED_FILES" 2>/dev/null || {
echo "[pre-commit] WARNING: store-journal preflight found active ownership conflict"
echo "[pre-commit] Run: node scripts/store-journal.js active --lane $LANE"
echo "[pre-commit] Continuing anyway (preflight is advisory)"
}
node "$REPO_ROOT/scripts/store-journal.js" append \\
--lane "$LANE" \\
--event work_started \\
--agent "git-pre-commit" \\
--session-id "$GIT_SESSION_ID" \\
--target "$COMMIT_MSG" \\
--intent "auto-journal work_started from git pre-commit hook" \\
--files "$STAGED_FILES" \\
2>/dev/null || true
echo "$GIT_SESSION_ID" > "$REPO_ROOT/.git/JOURNAL_SESSION_ID"
fi

echo "[pre-commit] All checks passed"
`;

const postCommitContent = `#!/bin/sh
# Post-commit hook: auto-journal every commit to store-journal
# Non-blocking — journal failure does NOT block the commit
# Installed by scripts/setup-hooks.js

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
if [ -f "$REPO_ROOT/.git/JOURNAL_SESSION_ID" ]; then
GIT_SESSION_ID=$(cat "$REPO_ROOT/.git/JOURNAL_SESSION_ID")
rm -f "$REPO_ROOT/.git/JOURNAL_SESSION_ID"
else
GIT_SESSION_ID="git-$(date +%s)"
fi
CHANGED_FILES=$(git diff-tree --no-commit-id --name-only -r HEAD | tr '\\n' ',' | sed 's/,$//')
node "$REPO_ROOT/scripts/store-journal.js" append \\
--lane "$LANE" \\
--event work_completed \\
--agent "git-post-commit" \\
--session-id "$GIT_SESSION_ID" \\
--target "$COMMIT_MSG" \\
--intent "auto-journal from git post-commit hook" \\
--files "$CHANGED_FILES" \\
--data "{\\\"commit_sha\\\":\\\"$COMMIT_SHA\\\",\\\"auto\\\":true,\\\"handoff\\\":{\\\"status\\\":\\\"completed\\\",\\\"auto\\\":true}}" \\
2>/dev/null || true
fi
`;

const repoRoot = path.resolve(__dirname, '..');
const hookDir = path.join(repoRoot, '.git', 'hooks');

if (!fs.existsSync(hookDir)) {
  fs.mkdirSync(hookDir, { recursive: true });
}

const preCommitPath = path.join(hookDir, 'pre-commit');
fs.writeFileSync(preCommitPath, preCommitContent);
fs.chmodSync(preCommitPath, 0o755);
console.log('Pre-commit hook installed: .git/hooks/pre-commit (sovereignty + journal preflight)');

const postCommitPath = path.join(hookDir, 'post-commit');
fs.writeFileSync(postCommitPath, postCommitContent);
fs.chmodSync(postCommitPath, 0o755);
console.log('Post-commit hook installed: .git/hooks/post-commit (auto-journal on every commit)');
