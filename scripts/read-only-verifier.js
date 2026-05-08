#!/usr/bin/env node
/**
 * READ-ONLY VERIFIER - Restricts agents to read-only journal operations
 * Prevents accidental mutations while allowing monitoring and verification
 */

const { execSync } = require('child_process');
const path = require('path');

// Read-only allowed commands with their exact flag structures
const ALLOWED_COMMANDS = [
  { cmd: 'store-journal status', args: ['--hours'] },
  { cmd: 'store-journal read', args: ['--lane', '--date', '--last'] },
  { cmd: 'store-journal active', args: ['--lane'] },
  { cmd: 'store-journal preflight', args: ['--lane', '--paths'] }
];

// Blocked mutating commands
const BLOCKED_COMMANDS = [
  'store-journal snapshot',
  'store-journal daily',
  'store-journal append',
  'sovereignty-enforcer.js'
];

function printHelp() {
  console.log(`READ-ONLY VERIFIER - Safe monitoring interface
Usage: node scripts/read-only-verifier.js <command> [allowed flags]

ALLOWED COMMANDS:
  store-journal status [--hours <N>]     - Cross-lane real-time view
  store-journal read --lane <lane> [--date <YYYY-MM-DD>] [--last <N>]  - Read lane journal
  store-journal active [--lane <lane>]   - Show active ownerships
  store-journal preflight --lane <lane> --paths <path1,path2,...>  - Check file safety

ALL MUTATING OPERATIONS BLOCKED:
  store-journal snapshot, daily, append
  sovereignty-enforcer.js (always writes reports)

This wrapper ensures agents can monitor and classify without risking mutations.
`);
  process.exit(0);
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
  }

  // Build the full command being attempted
  const attemptedCommand = args[0];
  const fullCommand = `store-journal ${attemptedCommand}`;
  
  // Check if it's a blocked command
  if (BLOCKED_COMMANDS.some(blocked => fullCommand.startsWith(blocked))) {
    console.error(`[READ-ONLY-VERIFIER] BLOCKED: Mutating command not allowed:`);
    console.error(`  ${fullCommand}`);
    console.error(`\nUse the wrapper without modification for safe monitoring.`);
    process.exit(1);
  }

  // Check if it's an allowed command with valid flags
  const allowedEntry = ALLOWED_COMMANDS.find(entry => 
    attemptedCommand === entry.cmd.split(' ')[1] // e.g., 'status' from 'store-journal status'
  );

  if (!allowedEntry) {
    console.error(`[READ-ONLY-VERIFIER] ERROR: Unknown or disallowed command:`);
    console.error(`  ${attemptedCommand}`);
    console.error(`\nRun with --help to see allowed commands.`);
    process.exit(1);
  }

  // Validate that only allowed flags are used
  const allowedFlags = new Set(allowedEntry.args.flat());
  const invalidFlags = args.filter(arg => 
    arg.startsWith('-') && !allowedFlags.has(arg)
  );

  if (invalidFlags.length > 0) {
    console.error(`[READ-ONLY-VERIFIER] ERROR: Invalid flags for ${attemptedCommand}:`);
    invalidFlags.forEach(flag => console.error(`  ${flag}`));
    console.error(`\nAllowed flags: ${allowedEntry.args.join(', ')}`);
    process.exit(1);
  }

  // Execute the allowed store-journal command
  try {
    const command = [`node`, `scripts/store-journal.js`, ...args];
    const result = execSync(command.join(' '), { stdio: 'inherit' });
    process.exit(0);
  } catch (error) {
    console.error(`[READ-ONLY-VERIFIER] Command failed:`);
    console.error(error.message);
    process.exit(1);
  }
}

main();
