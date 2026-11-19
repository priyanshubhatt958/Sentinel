const test = require('node:test');
const assert = require('node:assert/strict');

const { validateStartOptions } = require('../src/config');
const { createMetricsStore } = require('../src/metrics');

test('validates bounded traffic runs', () => {
  assert.deepEqual(validateStartOptions({ targetService: 'payment-service', requestsPerSecond: 50, durationSeconds: 60, scenario: 'traffic-spike' }), {
    targetService: 'payment-service',
    requestsPerSecond: 50,
    durationSeconds: 60,
    scenario: 'traffic-spike'
  });
  assert.throws(() => validateStartOptions({ requestsPerSecond: 201 }), /between 1 and 200/);
  assert.throws(() => validateStartOptions({ durationSeconds: 301 }), /between 1 and 300/);
});

test('records successful and failed requests with measured latency statistics', () => {
  const store = createMetricsStore();
  store.start({ targetService: 'payment-service', requestsPerSecond: 50, durationSeconds: 60, scenario: 'normal' });
  store.record({ ok: true, latencyMs: 40 });
  store.record({ ok: false, latencyMs: 100 });
  const snapshot = store.snapshot();

  assert.equal(snapshot.totalRequests, 2);
  assert.equal(snapshot.successfulRequests, 1);
  assert.equal(snapshot.failedRequests, 1);
  assert.equal(snapshot.averageLatencyMs, 70);
  assert.equal(snapshot.minLatencyMs, 40);
  assert.equal(snapshot.maxLatencyMs, 100);
  assert.equal(snapshot.errorRate, 50);
});
