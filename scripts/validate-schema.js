#!/usr/bin/env node
/**
 * SCHEMA VALIDATOR FOR SYNC PACKETS
 *
 * Purpose: Validate all sync packets against JSON schemas
 *
 * Usage:
 *   node validate-schema.js --file=RUNTIME_STATE.json
 *   node validate-schema.js --all
 */

const fs = require('fs');
const path = require('path');

const LOG = { info: '[i]', success: '[+]', warning: '[!]', error: '[-]', test: '[T]' };
function log(message, level = 'info') {
  console.log(`${LOG[level] || ''} ${message}`);
}

const SCHEMAS_DIR = path.join('S:', 'Archivist-Agent', 'schemas');
const LANES = {
  'archivist-agent': 'S:\\Archivist-Agent',
  'swarmmind': 'S:\\SwarmMind',
  'library': 'S:\\self-organizing-library'
};

/**
 * Simple JSON schema validator (no external dependencies)
 */
function validateSchema(data, schema) {
  const errors = [];
  
  function validate(value, schemaNode, path) {
    // Handle null values
    if (value === null) {
      if (schemaNode.type) {
        const types = Array.isArray(schemaNode.type) ? schemaNode.type : [schemaNode.type];
        if (!types.includes('null')) {
          errors.push(`${path}: null value not allowed`);
        }
      }
      return; // null values don't have properties to validate
    }
    
    // Type check
    if (schemaNode.type) {
      const types = Array.isArray(schemaNode.type) ? schemaNode.type : [schemaNode.type];
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      const typeMatch = types.some(t => {
        if (t === 'integer') return Number.isInteger(value);
        if (t === 'array') return Array.isArray(value);
        return t === actualType;
      });
      if (!typeMatch) {
        errors.push(`${path}: expected ${types.join('|')}, got ${actualType}`);
        return;
      }
    }
    
    // Enum check
    if (schemaNode.enum && !schemaNode.enum.includes(value)) {
      errors.push(`${path}: value "${value}" not in enum [${schemaNode.enum.join(', ')}]`);
    }
    
    // Const check
    if (schemaNode.const !== undefined && value !== schemaNode.const) {
      errors.push(`${path}: expected "${schemaNode.const}", got "${value}"`);
    }
    
    // Pattern check
    if (schemaNode.pattern && typeof value === 'string') {
      const regex = new RegExp(schemaNode.pattern);
      if (!regex.test(value)) {
        errors.push(`${path}: string "${value}" doesn't match pattern ${schemaNode.pattern}`);
      }
    }
    
    // Required check (for objects)
    if (schemaNode.required && typeof value === 'object' && !Array.isArray(value)) {
      for (const req of schemaNode.required) {
        if (!(req in value)) {
          errors.push(`${path}: missing required field "${req}"`);
        }
      }
    }
    
    // Properties check (for objects)
    if (schemaNode.properties && typeof value === 'object' && !Array.isArray(value)) {
      for (const [prop, propSchema] of Object.entries(schemaNode.properties)) {
        if (prop in value) {
          validate(value[prop], propSchema, `${path}.${prop}`);
        }
      }
    }
    
    // Items check (for arrays)
    if (schemaNode.items && Array.isArray(value)) {
      value.forEach((item, index) => {
        validate(item, schemaNode.items, `${path}[${index}]`);
      });
    }
    
    // Minimum check
    if (schemaNode.minimum !== undefined && typeof value === 'number') {
      if (value < schemaNode.minimum) {
        errors.push(`${path}: value ${value} is less than minimum ${schemaNode.minimum}`);
      }
    }
    
    // Maximum check
    if (schemaNode.maximum !== undefined && typeof value === 'number') {
      if (value > schemaNode.maximum) {
        errors.push(`${path}: value ${value} is greater than maximum ${schemaNode.maximum}`);
      }
    }
  }
  
  validate(data, schema, 'root');
  return errors;
}

/**
 * Load a schema file
 */
function loadSchema(schemaName) {
  const schemaPath = path.join(SCHEMAS_DIR, schemaName);
  if (!fs.existsSync(schemaPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

/**
 * Validate a single file
 */
function validateFile(filePath, schemaName) {
  log(`\nValidating: ${filePath}`, 'info');
  
  // Load the file
  if (!fs.existsSync(filePath)) {
    log(`  File not found: ${filePath}`, 'error');
    return { valid: false, errors: ['File not found'] };
  }
  
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    log(`  Parse error: ${e.message}`, 'error');
    return { valid: false, errors: ['Invalid JSON'] };
  }
  
  // Load schema
  const schema = loadSchema(schemaName);
  if (!schema) {
    log(`  Schema not found: ${schemaName}`, 'error');
    return { valid: false, errors: ['Schema not found'] };
  }
  
  // Validate
  const errors = validateSchema(data, schema);
  
  if (errors.length === 0) {
    log(`  [+] VALID`, 'success');
    return { valid: true, errors: [] };
  } else {
    log(`  [-] INVALID`, 'error');
    errors.forEach(err => log(`    ${err}`, 'error'));
    return { valid: false, errors };
  }
}

/**
 * Validate all sync packets
 */
function validateAll() {
  log('\n' + '='.repeat(60), 'test');
  log('SCHEMA VALIDATION - ALL SYNC PACKETS', 'test');
  log('='.repeat(60), 'test');
  
  const results = {
    timestamp: new Date().toISOString(),
    validations: [],
    summary: {
      total: 0,
      valid: 0,
      invalid: 0
    }
  };
  
  // Validate RUNTIME_STATE.json for all lanes
  for (const [laneId, lanePath] of Object.entries(LANES)) {
    const statePath = path.join(lanePath, 'RUNTIME_STATE.json');
    const result = validateFile(statePath, 'runtime-state.json');
    results.validations.push({
      lane: laneId,
      file: 'RUNTIME_STATE.json',
      ...result
    });
    results.summary.total++;
    if (result.valid) results.summary.valid++;
    else results.summary.invalid++;
  }
  
  // Validate GOVERNANCE_RESOLUTION.json for SwarmMind
  const resolutionPath = path.join(LANES['swarmmind'], 'GOVERNANCE_RESOLUTION.json');
  if (fs.existsSync(resolutionPath)) {
    // Note: No schema for this yet, skip
    log(`\nSkipping: GOVERNANCE_RESOLUTION.json (no schema)`, 'warning');
  }
  
  // Validate CONTEXT_RESTORE.json for SwarmMind
  const restorePath = path.join(LANES['swarmmind'], 'CONTEXT_RESTORE.json');
  if (fs.existsSync(restorePath)) {
    const result = validateFile(restorePath, 'context-restore.json');
    results.validations.push({
      lane: 'swarmmind',
      file: 'CONTEXT_RESTORE.json',
      ...result
    });
    results.summary.total++;
    if (result.valid) results.summary.valid++;
    else results.summary.invalid++;
  }
  
  // Validate COMPACT_RESTORE_PACKET.json if exists
  const compactPath = path.join(LANES['swarmmind'], 'COMPACT_RESTORE_PACKET.json');
  if (fs.existsSync(compactPath)) {
    const result = validateFile(compactPath, 'context-restore.json');
    results.validations.push({
      lane: 'swarmmind',
      file: 'COMPACT_RESTORE_PACKET.json',
      ...result
    });
    results.summary.total++;
    if (result.valid) results.summary.valid++;
    else results.summary.invalid++;
  }
  
  // Summary
  log('\n' + '='.repeat(60), 'test');
  log('VALIDATION SUMMARY', 'test');
  log('='.repeat(60), 'test');
  log(`Total validated: ${results.summary.total}`, 'info');
  log(`Valid: ${results.summary.valid}`, 'success');
  log(`Invalid: ${results.summary.invalid}`, results.summary.invalid > 0 ? 'error' : 'info');
  
  // Write results
  const resultsPath = path.join(LANES['archivist-agent'], 'SCHEMA_VALIDATION_RESULTS.json');
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  log(`\nResults written to: ${resultsPath}`, 'success');
  
  return results;
}

// CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--all')) {
    validateAll();
  } else {
    const fileArg = args.find(a => a.startsWith('--file='));
    if (fileArg) {
      const fileName = fileArg.split('=')[1];
      // Determine schema from filename
      const schemaMap = {
        'RUNTIME_STATE.json': 'runtime-state.json',
        'SYNC_REQUEST.json': 'sync-request.json',
        'SYNC_RESPONSE.json': 'sync-response.json',
        'CONTEXT_RESTORE.json': 'context-restore.json',
        'COMPACT_RESTORE_PACKET.json': 'context-restore.json'
      };
      const schemaName = schemaMap[fileName];
      if (!schemaName) {
        log(`Unknown file type: ${fileName}`, 'error');
        process.exit(1);
      }
      validateFile(path.join(LANES['archivist-agent'], fileName), schemaName);
    } else {
      validateAll();
    }
  }
}

module.exports = { validateSchema, validateFile, validateAll };
