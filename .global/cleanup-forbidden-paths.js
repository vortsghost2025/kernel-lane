#!/usr/bin/env node
/**
 * Cleanup Forbidden Paths
 * Moves files from forbidden variant directories to canonical paths
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { LaneDiscovery } = require('./lane-discovery');

const discovery = new LaneDiscovery();
const registry = JSON.parse(fs.readFileSync(process.env.LANE_REGISTRY_PATH || path.join(process.env.LANE_REPOS_ROOT || path.join(os.homedir(), 'agent', 'repos'), 'Archivist-Agent', '.global', 'lane-registry.json'), 'utf8'));

console.log('=== CLEANUP FORBIDDEN PATHS ===\n');

let movedCount = 0;
let errorCount = 0;

for (const [laneId, lane] of Object.entries(registry.lanes)) {
  if (!lane.forbidden_variants) continue;
  
  console.log(`\nProcessing ${laneId}...`);
  console.log(`  Canonical: ${lane.local_path}`);
  
  for (const forbidden of lane.forbidden_variants) {
    if (fs.existsSync(forbidden)) {
      console.log(`  Found forbidden: ${forbidden}`);
      
      // Merge files to canonical
      try {
        const entries = fs.readdirSync(forbidden, { withFileTypes: true, recursive: true });
        
        for (const entry of entries) {
          const fullPath = path.join(forbidden, entry.name);
          const relativePath = path.relative(forbidden, fullPath);
          const canonicalDest = path.join(lane.local_path, relativePath);
          
          if (entry.isFile()) {
            // Ensure directory exists
            fs.mkdirSync(path.dirname(canonicalDest), { recursive: true });
            
            // Copy if not exists
            if (!fs.existsSync(canonicalDest)) {
              fs.copyFileSync(fullPath, canonicalDest);
              console.log(`    [MOVED] ${relativePath}`);
              movedCount++;
            } else {
              console.log(`    [SKIP] ${relativePath} (exists)`);
            }
          }
        }
        
        // Mark for deletion (log only, don't delete yet)
        console.log(`  [MARKED FOR DELETION] ${forbidden}`);
        
      } catch (e) {
        console.error(`  [ERROR] ${e.message}`);
        errorCount++;
      }
    }
  }
}

console.log('\n=== SUMMARY ===');
console.log(`Files moved: ${movedCount}`);
console.log(`Errors: ${errorCount}`);
console.log('\nTo complete cleanup:');
console.log('1. Verify all files are in canonical paths');
console.log('2. Run: node S:/.global/cleanup-forbidden-paths.js --delete');
console.log('3. Commit changes');
