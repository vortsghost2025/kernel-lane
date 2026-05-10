#!/bin/sh
# pre-commit hook: reject filenames illegal on Windows NTFS
# Prevents commits containing colons or other NTFS-forbidden characters
# in filenames, which cause checkout failures on Windows.
# Repo-tracked copy — installed to .git/hooks/pre-commit by scripts/setup-hooks.js

NTFS_ILLEGAL='[:<>\"|?*]'

bad_files=$(git diff --cached --name-only --diff-filter=ACMR | grep -e "$NTFS_ILLEGAL")

if [ -n "$bad_files" ]; then
  echo "ERROR: Commit rejected — filenames contain Windows-NTFS-illegal characters:" >&2
  echo "$bad_files" >&2
  echo "" >&2
  echo "NTFS forbids: : < > \" | ? *" >&2
  echo "Rename these files or remove them from the commit." >&2
  exit 1
fi

exit 0
