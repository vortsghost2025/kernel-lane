#!/bin/bash
# Agent Commit Script - Bash version for Linux/Ubuntu
# Usage: ./agent-commit.sh "agent-name" "commit message"

set -euo pipefail

AGENT_NAME="${1:-unknown}"
MESSAGE="${2:-No message provided}"
REPO_PATH="${3:-$(pwd)}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
COMMIT_MSG="[$AGENT_NAME] $MESSAGE

Agent: $AGENT_NAME
Date: $TIMESTAMP"

echo "=== Agent Commit: $AGENT_NAME ==="
echo "Repo: $REPO_PATH"
echo "Message: $MESSAGE"
echo "Timestamp: $TIMESTAMP"
echo ""

cd "$REPO_PATH"

# Check for uncommitted changes
if [[ -z $(git status --porcelain) ]]; then
    echo "No changes to commit"
    exit 0
fi

echo "Changes to commit:"
git diff --stat

# Run tests if available
if [[ -f "scripts/test.sh" ]]; then
    echo "Running tests..."
    ./scripts/test.sh || { echo "TESTS FAILED - Commit aborted"; exit 1; }
    echo "Tests passed"
fi

# Python projects - run pytest if available
if [[ -f "pyproject.toml" ]] || [[ -f "requirements.txt" ]] || [[ -d "tests" ]]; then
    if command -v pytest &> /dev/null; then
        echo "Running pytest..."
        python -m pytest tests/ -x -q || { echo "PYTEST FAILED - Commit aborted"; exit 1; }
        echo "Pytest passed"
    fi
fi

# Rust projects - run cargo check if available
if [[ -f "Cargo.toml" ]]; then
    if command -v cargo &> /dev/null; then
        echo "Running cargo check..."
        cargo check 2>/dev/null || { echo "CARGO CHECK FAILED - Commit aborted"; exit 1; }
        echo "Cargo check passed"
    fi
fi

# Stage all changes
echo "Staging changes..."
git add -A

# Commit
echo "Committing..."
git commit -m "$COMMIT_MSG"

# Push
echo "Pushing to origin..."
git push

echo "=== Commit complete ==="
git log -1 --oneline