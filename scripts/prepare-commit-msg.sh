#!/usr/bin/env bash
# Prepare commit message hook to enforce [LANE-X] prefix and run secret scan

COMMIT_MSG_FILE=$1
COMMIT_SOURCE=$2
SHA1=$3

# Exit if this is a merge or squash commit (Git provides these as environment variables)
if [ -n "$GIT_MERGE_AUTOEDIT" ] || [ -n "$GIT_SQUASH" ]; then
    exit 0
fi

# Get the current branch name to derive lane? Actually, we require explicit [LANE-X] in the commit message.
# We'll check the commit message for the pattern [LANE-X] where X is a number.

# Read the commit message
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

# Check for [LANE-X] pattern
if [[ ! "$COMMIT_MSG" =~ \[LANE-[0-9]+\] ]]; then
    echo "Error: Commit message must contain a lane prefix in the format [LANE-X] where X is a number."
    echo "Current commit message:"
    echo "$COMMIT_MSG"
    exit 1
fi

# Run secret scan (if we have a secret scanning tool)
# For now, we'll just check for common patterns of secrets.
# We can extend this to use git-secret or truffleHog or similar.
# We'll do a simple regex check for common secret patterns.

SECRET_PATTERNS=(
    "password\s*=\s*['\"][^'\"]+['\"]"
    "api_key\s*=\s*['\"][^'\"]+['\"]"
    "secret\s*=\s*['\"][^'\"]+['\"]"
    "token\s*=\s*['\"][^'\"]+['\"]"
    "-----BEGIN [A-Z]+ PRIVATE KEY-----"
)

# Check each pattern
for pattern in "${SECRET_PATTERNS[@]}"; do
    if grep -iE "$pattern" "$COMMIT_MSG_FILE" > /dev/null 2>&1; then
        echo "Error: Possible secret detected in commit message. Aborting commit."
        echo "Pattern matched: $pattern"
        exit 1
    fi
done

# If we have a secret scanning script, we could run it here.
# For example, if we have a script at .git/hooks/secret-scan.sh, we could run it.
# But for now, we'll just do the above.

exit 0