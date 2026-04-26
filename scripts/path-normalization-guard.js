#!/usr/bin/env node
/**
 * Path Normalization Guard
 * Prevents agents from creating duplicate directories with different naming conventions
 */

const fs = require('fs');
const path = require('path');

const CANONICAL_PATHS = {
  'swarmmind': 'S:/SwarmMind',
  'kernel': 'S:/kernel-lane',
  'authority': 'S:/Archivist-Agent',  // Authority runs in Archivist context
  'library': 'S:/self-organizing-library',
  'archivist': 'S:/Archivist-Agent'
};

const FORBIDDEN_VARIANTS = [
  'SwarmMind Self-Optimizing Multi-Agent AI System',
  'SwarmMind-Self-Optimizing-Multi-Agent-AI-System',
  'SwarmMindSelfOptimizingMultiAgentAISystem'
];

class PathNormalizationGuard {
  constructor() {
    this.violations = [];
  }

  /**
   * Normalize a path to canonical form
   */
  normalize(lane) {
    const normalized = lane.toLowerCase().replace(/[^a-z0-9]/g, '');
    return CANONICAL_PATHS[normalized] || null;
  }

  /**
   * Check if a path is a forbidden variant
   */
  isForbiddenVariant(testPath) {
    const normalized = path.basename(testPath);
    return FORBIDDEN_VARIANTS.some(variant => 
      normalized.toLowerCase().includes(variant.toLowerCase()) ||
      normalized.toLowerCase().replace(/[^a-z0-9]/g, '') === 
      variant.toLowerCase().replace(/[^a-z0-9]/g, '')
    );
  }

  /**
   * Find all duplicate directories for a lane
   */
  findDuplicates(baseDir, laneName) {
    const duplicates = [];
    const normalizedLane = laneName.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const normalizedEntry = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (normalizedEntry.includes(normalizedLane) && 
              entry.name !== path.basename(CANONICAL_PATHS[laneName.toLowerCase()] || '')) {
            duplicates.push(path.join(baseDir, entry.name));
          }
        }
      }
    } catch (e) {
      // Directory doesn't exist
    }
    
    return duplicates;
  }

  /**
   * Ensure canonical path exists
   */
  ensureCanonical(lane) {
    const canonical = this.normalize(lane);
    if (!canonical) {
      throw new Error(`Unknown lane: ${lane}`);
    }
    
    if (!fs.existsSync(canonical)) {
      fs.mkdirSync(canonical, { recursive: true });
      console.log(`[GUARD] Created canonical path: ${canonical}`);
    }
    
    return canonical;
  }

  /**
   * Merge duplicates into canonical path
   */
  mergeDuplicates(lane) {
    const canonical = this.normalize(lane);
    const duplicates = this.findDuplicates('S:/', lane);
    
    console.log(`[GUARD] Found ${duplicates.length} duplicate(s) for ${lane}`);
    
    for (const dup of duplicates) {
      console.log(`[GUARD] Merging: ${dup} → ${canonical}`);
      
      // Merge files
      this.mergeDirectory(dup, canonical);
      
      // Mark for deletion (don't delete immediately - verify first)
      this.violations.push({
        duplicate: dup,
        canonical: canonical,
        merged: true
      });
    }
    
    return this.violations;
  }

  /**
   * Merge source directory into target
   */
  mergeDirectory(source, target) {
    if (!fs.existsSync(source)) return;
    
    const entries = fs.readdirSync(source, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = path.join(source, entry.name);
      const destPath = path.join(target, entry.name);
      
      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(destPath, { recursive: true });
        }
        this.mergeDirectory(srcPath, destPath);
      } else {
        if (!fs.existsSync(destPath)) {
          fs.copyFileSync(srcPath, destPath);
          console.log(`  [MERGE] ${entry.name}`);
        } else {
          console.log(`  [SKIP] ${entry.name} (already exists)`);
        }
      }
    }
  }

  /**
   * Generate report of all violations
   */
  generateReport() {
    return {
      timestamp: new Date().toISOString(),
      violations: this.violations,
      canonical_paths: CANONICAL_PATHS,
      recommendation: 'Delete duplicate directories after verification'
    };
  }
}

// Run if called directly
if (require.main === module) {
  const guard = new PathNormalizationGuard();
  
  console.log('=== PATH NORMALIZATION GUARD ===\n');
  
  // Fix SwarmMind duplicates
  console.log('Fixing SwarmMind...');
  guard.mergeDuplicates('swarmmind');
  guard.ensureCanonical('swarmmind');
  
  // Generate report
  const report = guard.generateReport();
  const reportPath = 'S:/Archivist-Agent/.compact-audit/path-normalization-report.json';
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  
  console.log(`\n[GUARD] Report saved: ${reportPath}`);
  console.log(`[GUARD] Violations found: ${report.violations.length}`);
  
  if (report.violations.length > 0) {
    console.log('\n⚠️  DUPLICATES FOUND:');
    report.violations.forEach(v => {
      console.log(`  - ${v.duplicate} → ${v.canonical}`);
    });
    console.log('\nRun: node scripts/cleanup-duplicates.js --verify');
  }
}

module.exports = { PathNormalizationGuard };
