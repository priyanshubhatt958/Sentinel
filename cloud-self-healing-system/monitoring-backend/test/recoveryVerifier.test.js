const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyRecovery } = require('../src/services/recoveryVerifier');

const before = {
  cpuUsage: 80,
  memoryUsage: 80,
  probeLatencyMs: 200,
  latencyMs: 200,
  probeFailures: 10,
  errorRate: 10,
  requestRate: 50
};

test('marks recovered when latency and error rate both improve by at least 30 percent', () => {
  const result = verifyRecovery(before, {
    cpuUsage: 50,
    memoryUsage: 60,
    probeLatencyMs: 100,
    latencyMs: 130,
    probeFailures: 2,
    errorRate: 6,
    requestRate: 50
  });
  assert.equal(result.status, 'recovered');
  assert.ok(result.effectivenessScore > 0);
});

test('marks partially recovered when latency or error rate improves but misses threshold', () => {
  const result = verifyRecovery(before, { ...before, latencyMs: 190, errorRate: 10 });
  assert.equal(result.status, 'partially_recovered');
});

test('marks not recovered when no metrics improve', () => {
  const result = verifyRecovery(before, { ...before, latencyMs: 220, errorRate: 12, cpuUsage: 90 });
  assert.equal(result.status, 'not_recovered');
});

test('marks pending when fresh metrics are unavailable', () => {
  assert.equal(verifyRecovery(before, null).status, 'pending');
});
