const fs = require('fs');
const path = require('path');
const ts = Date.now();

const arDir = 'S:/kernel-lane/lanes/kernel/inbox/action-required';
fs.mkdirSync(arDir, { recursive: true });

const tasks = [
  {
    task_id: `task-${ts}-001`,
    from: 'archivist',
    to: 'kernel',
    type: 'task',
    task_kind: 'proposal',
    priority: 'P1',
    subject: 'Add Nsight Compute profiling script + CI build step',
    body: [
      'Create scripts/profile-kernels.ps1 that runs ncu --set full on both matrix_tensor_optimized and matrix_tensor_async executables for M=N=K=1024.',
      'Output CSV to profiles/.',
      '',
      'Also create scripts/build-kernels.ps1 that sets up cl.exe PATH and compiles both .cu files with -arch=sm_120 -lineinfo.',
      'Both scripts should work from Developer Command Prompt or detect cl.exe automatically.'
    ].join('\n'),
    requires_action: true,
    schema_version: '1.3',
    idempotency_key: `task-profile-build-${ts}`,
    timestamp: new Date().toISOString(),
    payload: { mode: 'inline', compression: 'none' },
    execution: { mode: 'session_task', engine: 'kilo', actor: 'lane' },
    lease: { owner: 'kernel', acquired_at: new Date().toISOString() },
    retry: { attempt: 1, max_attempts: 1 },
    evidence: { required: false, verified: false },
    evidence_exchange: { artifact_path: null, artifact_type: 'report', delivered_at: null },
    heartbeat: { status: 'pending', last_heartbeat_at: new Date().toISOString(), interval_seconds: 300, timeout_seconds: 900 }
  },
  {
    task_id: `task-${ts}-002`,
    from: 'archivist',
    to: 'kernel',
    type: 'task',
    task_kind: 'proposal',
    priority: 'P2',
    subject: 'Add kernel README + async directory restructure',
    body: [
      'Create kernels/src/README.md documenting:',
      '1) kernel categories (baseline, optimized, async)',
      '2) compile commands per kernel',
      '3) profiling steps',
      '4) benchmark expected results from RTX 5060',
      '',
      'Move matrix_tensor_async.cu to kernels/src/async/ subdirectory for discoverability.',
      'Update any include paths if needed.'
    ].join('\n'),
    requires_action: true,
    schema_version: '1.3',
    idempotency_key: `task-readme-restructure-${ts}`,
    timestamp: new Date().toISOString(),
    payload: { mode: 'inline', compression: 'none' },
    execution: { mode: 'session_task', engine: 'kilo', actor: 'lane' },
    lease: { owner: 'kernel', acquired_at: new Date().toISOString() },
    retry: { attempt: 1, max_attempts: 1 },
    evidence: { required: false, verified: false },
    evidence_exchange: { artifact_path: null, artifact_type: 'report', delivered_at: null },
    heartbeat: { status: 'pending', last_heartbeat_at: new Date().toISOString(), interval_seconds: 300, timeout_seconds: 900 }
  },
  {
    task_id: `task-${ts}-003`,
    from: 'archivist',
    to: 'kernel',
    type: 'task',
    task_kind: 'proposal',
    priority: 'P0',
    subject: 'Fix async kernel: shared memory sizing + grid dimensioning for 4-warp blocks',
    body: [
      'The current matrix_tensor_async.cu has two issues to fix:',
      '',
      '1. SHARED MEM: The double-buffer needs 2x shared memory but shmemBytes in run_async() only accounts for one buffer.',
      'The extern __shared__ layout needs: buf0_sA + buf0_sB + buf1_sA + buf1_sB.',
      'Current code declares T (*sA)[WMMA_K + PAD] and sB but the array dimension does not actually double for 2 buffers.',
      'Fix the shared memory layout so both buffers fit correctly.',
      '',
      '2. WARP STRIDE / GRID: With 4 warps per block (dim3 block(32,4,1)), each block computes 4 tiles (one per warp).',
      'But grid((N+15)/16, (M+15)/16) launches too many blocks — it assumes 1 tile per block.',
      'Fix: grid Y should be (M+63)/64 since each block covers 4*16=64 rows.',
      'Verify the same for grid X if warp stride affects column coverage.'
    ].join('\n'),
    requires_action: true,
    schema_version: '1.3',
    idempotency_key: `task-async-fixes-${ts}`,
    timestamp: new Date().toISOString(),
    payload: { mode: 'inline', compression: 'none' },
    execution: { mode: 'session_task', engine: 'kilo', actor: 'lane' },
    lease: { owner: 'kernel', acquired_at: new Date().toISOString() },
    retry: { attempt: 1, max_attempts: 1 },
    evidence: { required: false, verified: false },
    evidence_exchange: { artifact_path: null, artifact_type: 'benchmark', delivered_at: null },
    heartbeat: { status: 'pending', last_heartbeat_at: new Date().toISOString(), interval_seconds: 300, timeout_seconds: 900 }
  }
];

for (const t of tasks) {
  const fname = `${t.task_id}.json`;
  fs.writeFileSync(path.join(arDir, fname), JSON.stringify(t, null, 2), 'utf8');
  console.log(`Dispatched: ${fname} | P${t.priority} | ${t.subject.slice(0, 55)}`);
}

console.log(`\n${tasks.length} tasks dispatched to kernel action-required/`);
