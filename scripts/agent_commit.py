#!/usr/bin/env python3
"""Agent commit helper - call from Python agents to auto-commit work."""

import subprocess
import sys
import os
from datetime import datetime, timezone

def agent_commit(agent_name: str, message: str, repo_path: str = None) -> bool:
    """
    Commit changes with standardized format.
    
    Args:
        agent_name: Name of the agent (e.g., "kucoin-lane", "archivist")
        message: Human-readable description of changes
        repo_path: Path to repo (default: current dir)
    
    Returns:
        True if commit succeeded, False otherwise
    """
    if repo_path is None:
        repo_path = os.getcwd()
    
    timestamp = datetime.now(timezone.utc).isoformat()
    commit_msg = f"[{agent_name}] {message}\n\nAgent: {agent_name}\nDate: {timestamp}"
    
    print(f"=== Agent Commit: {agent_name} ===")
    print(f"Repo: {repo_path}")
    print(f"Message: {message}")
    print(f"Timestamp: {timestamp}")
    print()
    
    # Check for changes
    result = subprocess.run(
        ["git", "status", "--porcelain"], 
        cwd=repo_path, capture_output=True, text=True
    )
    if not result.stdout.strip():
        print("No changes to commit")
        return True
    
    # Show changes
    print("Changes to commit:")
    subprocess.run(["git", "diff", "--stat"], cwd=repo_path)
    
    # Run tests if available
    test_scripts = [
        os.path.join(repo_path, "scripts", "test.sh"),
        os.path.join(repo_path, "scripts", "test.ps1"),
    ]
    for test_script in test_scripts:
        if os.path.exists(test_script):
            print("Running tests...")
            result = subprocess.run([test_script], cwd=repo_path, shell=True)
            if result.returncode != 0:
                print("TESTS FAILED - Commit aborted")
                return False
            print("Tests passed")
            break
    
    # Python projects - run pytest
    if (os.path.exists(os.path.join(repo_path, "pyproject.toml")) or 
        os.path.exists(os.path.join(repo_path, "requirements.txt")) or
        os.path.exists(os.path.join(repo_path, "tests"))):
        print("Running pytest...")
        result = subprocess.run(["python", "-m", "pytest", "tests/", "-x", "-q"], cwd=repo_path)
        if result.returncode != 0:
            print("PYTEST FAILED - Commit aborted")
            return False
        print("Pytest passed")
    
    # Rust projects - cargo check
    if os.path.exists(os.path.join(repo_path, "Cargo.toml")):
        print("Running cargo check...")
        result = subprocess.run(["cargo", "check"], cwd=repo_path)
        if result.returncode != 0:
            print("CARGO CHECK FAILED - Commit aborted")
            return False
        print("Cargo check passed")
    
    # Stage all changes
    print("Staging changes...")
    subprocess.run(["git", "add", "-A"], cwd=repo_path, check=True)
    
    # Commit
    print("Committing...")
    subprocess.run(["git", "commit", "-m", commit_msg], cwd=repo_path, check=True)
    
    # Push
    print("Pushing to origin...")
    subprocess.run(["git", "push"], cwd=repo_path, check=True)
    
    # Show commit
    result = subprocess.run(["git", "log", "-1", "--oneline"], cwd=repo_path, capture_output=True, text=True)
    print(f"=== Commit complete ===")
    print(f"Commit: {result.stdout.strip()}")
    
    return True

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python agent_commit.py <agent-name> <message> [repo-path]")
        sys.exit(1)
    
    agent_name = sys.argv[1]
    message = sys.argv[2]
    repo_path = sys.argv[3] if len(sys.argv) > 3 else None
    
    success = agent_commit(agent_name, message, repo_path)
    sys.exit(0 if success else 1)