#!/usr/bin/env node
/**
 * CROSS-LANE SYNC TEST
 * 
 * Purpose: Test multi-lane communication between Archivist, SwarmMind, and library
 * 
 * Usage:
 *   node cross-lane-sync.js --test=read-state
 *   node cross-lane-sync.js --test=sync-request
 *   node cross-lane-sync.js --test=full-restore
 */

const fs = require('fs');
const path = require('path');

// ASCII-safe prefixes
const LOG = {
    info: '[i]',
    success: '[+]',
    warning: '[!]',
    error: '[-]',
    test: '[T]'
};

function log(message, level = 'info') {
    console.log(`${LOG[level] || ''} ${message}`);
}

// Lane definitions
const LANES = {
    'archivist-agent': {
        id: 'archivist-agent',
        role: 'governance-root',
        position: 1,
        root: 'S:\\Archivist-Agent',
        runtimeState: 'RUNTIME_STATE.json',
        downstream: ['swarmmind']
    },
    'swarmmind': {
        id: 'swarmmind',
        role: 'trace-layer',
        position: 2,
        root: 'S:\\SwarmMind',
        runtimeState: 'RUNTIME_STATE.json',
        upstream: 'archivist-agent'
    },
    'self-organizing-library': {
        id: 'self-organizing-library',
        role: 'memory-layer',
        position: 3,
        root: 'S:\\self-organizing-library',
        runtimeState: 'RUNTIME_STATE.json',
        upstream: ['archivist-agent', 'swarmmind']
    }
};

/**
 * Test 1: Read runtime state from all lanes
 */
function testReadState() {
    log('Testing RUNTIME_STATE.json reads from all lanes...', 'test');
    log('='.repeat(50), 'info');
    
    const results = {};
    
    for (const [laneId, laneConfig] of Object.entries(LANES)) {
        const statePath = path.join(laneConfig.root, laneConfig.runtimeState);
        log(`\nLane: ${laneId} (Position ${laneConfig.position})`, 'info');
        
        if (!fs.existsSync(statePath)) {
            log(`  RUNTIME_STATE.json NOT FOUND: ${statePath}`, 'warning');
            results[laneId] = { status: 'not_found', path: statePath };
            continue;
        }
        
        try {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            log(`  Status: FOUND`, 'success');
            log(`  Timestamp: ${state.timestamp || 'N/A'}`, 'info');
            
            // Handle both old and new schema
            const mode = state.mode || state.runtime?.mode || 'N/A';
            const governanceActive = state.governance_active ?? state.runtime?.governance_active ?? 'N/A';
            const externalLane = state.external_lane_enabled ?? state.runtime?.external_lane_enabled ?? 'N/A';
            const claimLimit = state.claim_limit || state.runtime?.claim_limit || 'N/A';
            
            log(`  Mode: ${mode}`, 'info');
            log(`  Governance Active: ${governanceActive}`, 'info');
            log(`  External Lane: ${externalLane}`, 'info');
            log(`  Claim Limit: ${claimLimit}`, 'info');
            
            // Show capabilities if present
            if (state.capabilities) {
                log(`  Capabilities:`, 'info');
                log(`    can_govern: ${state.capabilities.can_govern ?? 'N/A'}`, 'info');
                log(`    can_restore_context: ${state.capabilities.can_restore_context ?? 'N/A'}`, 'info');
            }
            
            results[laneId] = { 
                status: 'success', 
                path: statePath,
                data: state 
            };
        } catch (error) {
            log(`  PARSE ERROR: ${error.message}`, 'error');
            results[laneId] = { status: 'parse_error', error: error.message };
        }
    }
    
    return results;
}

/**
 * Test 2: Generate sync request
 */
function testSyncRequest() {
    log('\nTesting SYNC_REQUEST generation...', 'test');
    log('='.repeat(50), 'info');
    
    const request = {
        "$schema": "https://archivist.dev/schemas/sync-request.json",
        "version": "1.0.0",
        "timestamp": new Date().toISOString(),
        
        "requester": {
            "lane_id": "swarmmind",
            "session_id": `${Date.now()}-${process.pid}`,
            "context_remaining": 52000,
            "context_lost": 128000
        },
        
        "request": {
            "type": "restore_context",
            "target_lane": "archivist-agent",
            "scope": [
                "governance_constraints",
                "active_checkpoints",
                "drift_baseline"
            ],
            "max_tokens": 5000
        }
    };
    
    log(`Request generated:`, 'success');
    log(`  Requester: ${request.requester.lane_id}`, 'info');
    log(`  Target: ${request.request.target_lane}`, 'info');
    log(`  Scope: ${request.request.scope.join(', ')}`, 'info');
    log(`  Context needed: ${request.requester.context_lost} tokens lost`, 'info');
    
    // Write to temp location
    const outputPath = path.join(LANES.swarmmind.root, 'SYNC_REQUEST_test.json');
    fs.writeFileSync(outputPath, JSON.stringify(request, null, 2));
    log(`\nWritten to: ${outputPath}`, 'success');
    
    return request;
}

/**
 * Test 3: Full restore simulation
 */
function testFullRestore() {
    log('\nTesting full context restoration...', 'test');
    log('='.repeat(50), 'info');
    
    // Step 1: Check upstream state
    const archivistStatePath = path.join(LANES['archivist-agent'].root, 'RUNTIME_STATE.json');
    
    if (!fs.existsSync(archivistStatePath)) {
        // Generate if missing
        const generatedState = {
            "$schema": "https://archivist.dev/schemas/runtime-state.json",
            "version": "1.0.0",
            "timestamp": new Date().toISOString(),
            "lane": {
                "id": "archivist-agent",
                "role": "governance-root",
                "position": 1
            },
            "session": {
                "id": `${Date.now()}-${process.pid}`,
                "branch": "main"
            },
            "governance": {
                "active": true,
                "source": null,
                "bootstrap_verified": true
            },
            "modes": {
                "claim_limit": "full",
                "external_lane_enabled": true
            }
        };
        fs.writeFileSync(archivistStatePath, JSON.stringify(generatedState, null, 2));
        log(`Generated RUNTIME_STATE.json for archivist-agent`, 'success');
    }
    
    // Step 2: Read upstream state
    const upstreamState = JSON.parse(fs.readFileSync(archivistStatePath, 'utf8'));
    log(`Upstream state loaded from: ${archivistStatePath}`, 'success');
    
    // Step 3: Build restore payload
    const restorePayload = {
        "governance_constraints": {
            "single_entry_point": true,
            "structure_over_identity": true,
            "correction_mandatory": true,
            "agent_evaluates_WE": true,
            "agent_not_part_of_WE": true
        },
        "active_checkpoints": [
            {
                "id": "CP-001",
                "name": "pre_action_verification",
                "trigger": "before_file_write"
            }
        ],
        "drift_baseline": {
            "cps_score": 0,
            "uds_score": 0,
            "signals": []
        },
        "source_state": upstreamState
    };
    
    // Step 4: Write restore packet
    const restorePath = path.join(LANES.swarmmind.root, 'CONTEXT_RESTORE.json');
    fs.writeFileSync(restorePath, JSON.stringify(restorePayload, null, 2));
    log(`Restore packet written to: ${restorePath}`, 'success');
    
    // Step 5: Calculate token savings
    const fullGovernanceSize = fs.statSync(path.join(LANES['archivist-agent'].root, 'BOOTSTRAP.md')).size;
    const restorePacketSize = fs.statSync(restorePath).size;
    const savings = Math.round((1 - restorePacketSize / fullGovernanceSize) * 100);
    
    log(`\nToken efficiency:`, 'test');
    log(`  Full governance: ~${Math.round(fullGovernanceSize / 4)} tokens`, 'info');
    log(`  Restore packet: ~${Math.round(restorePacketSize / 4)} tokens`, 'info');
    log(`  Savings: ${savings}%`, 'success');
    
    return {
        upstream_state: upstreamState,
        restore_payload: restorePayload,
        efficiency: {
            full_governance_bytes: fullGovernanceSize,
            restore_packet_bytes: restorePacketSize,
            savings_percent: savings
        }
    };
}

/**
 * Run all tests
 */
function runTests() {
    log('\n' + '='.repeat(60), 'header');
    log('CROSS-LANE SYNC TEST SUITE', 'header');
    log('='.repeat(60), 'header');
    
    const testType = process.argv.find(arg => arg.startsWith('--test='))?.split('=')[1] || 'all';
    
    const results = {
        timestamp: new Date().toISOString(),
        tests: {}
    };
    
    if (testType === 'all' || testType === 'read-state') {
        results.tests.readState = testReadState();
    }
    
    if (testType === 'all' || testType === 'sync-request') {
        results.tests.syncRequest = testSyncRequest();
    }
    
    if (testType === 'all' || testType === 'full-restore') {
        results.tests.fullRestore = testFullRestore();
    }
    
    // Summary
    log('\n' + '='.repeat(60), 'header');
    log('TEST SUMMARY', 'header');
    log('='.repeat(60), 'header');
    
    const laneCount = Object.keys(results.tests.readState || {}).length;
    log(`Lanes checked: ${laneCount}`, 'info');
    log(`Tests run: ${Object.keys(results.tests).length}`, 'info');
    
    // Write results
    const resultsPath = path.join(LANES['archivist-agent'].root, 'CROSS_LANE_TEST_RESULTS.json');
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    log(`\nResults written to: ${resultsPath}`, 'success');
    
    return results;
}

// CLI execution
if (require.main === module) {
    runTests();
}

module.exports = { testReadState, testSyncRequest, testFullRestore, LANES };
