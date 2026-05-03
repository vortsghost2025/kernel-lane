'use strict';

const assert = require('assert');
const { executionWeight } = require('./execution-weight');
const { buildStatusCounts, topPriorityWork } = require('./analyze-graph-json');

function run() {
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  assert.strictEqual(executionWeight({ status: 'conflicted' }), 10);
  assert.strictEqual(executionWeight({ status: 'blocked' }), 8);
  assert.strictEqual(executionWeight({ status: 'unverified' }), 6);
  assert.strictEqual(executionWeight({ status: 'verified' }), 4);
  assert.strictEqual(executionWeight({ status: 'resolved' }), 2);
  assert.strictEqual(executionWeight({ status: 'unknown' }), 1);

  assert.strictEqual(
    executionWeight({ status: 'conflicted', meta: { critical: true } }),
    15
  );
  assert.strictEqual(
    executionWeight({ status: 'blocked', properties: { invoke_count: '99' } }),
    13
  );
  assert.strictEqual(
    executionWeight({ status: 'blocked', probe: { lastInvoked: recent } }),
    11
  );
  assert.strictEqual(
    executionWeight({ status: 'blocked', runtime_probe: { last_invoked: stale } }),
    8
  );

  const { detailed } = buildStatusCounts([
    { id: 'plain', status: 'conflicted' },
    { id: 'critical', status: 'conflicted', properties: { critical: true } },
    { id: 'probe', status: 'blocked', probe: { invokeCount: 2, lastInvoked: recent } },
  ]);

  assert.ok(detailed.every((node) => typeof node.weight === 'number'));
  assert.deepStrictEqual(
    topPriorityWork(detailed).map((node) => node.id),
    ['critical', 'probe', 'plain']
  );

  console.log('PASS test-execution-weight');
}

run();