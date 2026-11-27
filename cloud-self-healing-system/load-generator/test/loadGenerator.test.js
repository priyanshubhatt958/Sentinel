const test = require('node:test');
const assert = require('node:assert/strict');

const { validateStartOptions } = require('../src/config');
const { createMetricsStore } = require('../src/metrics');
const { createLoadRunner } = require('../src/loadRunner');

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

test('reports requests per second from the most recent one-second window', () => {
  let now = 1000;
  const store = createMetricsStore({ now: () => now });
  store.start({ targetService: 'payment-service', requestsPerSecond: 2, durationSeconds: 10, scenario: 'normal' });
  store.record({ ok: true, latencyMs: 20 }, 500);
  store.record({ ok: true, latencyMs: 20 }, 900);
  assert.equal(store.snapshot().currentRequestsPerSecond, 2);
  now = 1501;
  assert.equal(store.snapshot().currentRequestsPerSecond, 1);
});

test('low configured rates do not exceed the target schedule and stop cancels future sends', async () => {
  let sends = 0;
  const runner = createLoadRunner({
    requestSender: async (_service, _url, _scenario, { signal }) => {
      sends += 1;
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: true, latencyMs: 1 }), 1000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve({ ok: false, latencyMs: 1 });
        }, { once: true });
      });
    }
  });

  runner.start({ targetService: 'payment-service', requestsPerSecond: 1, durationSeconds: 10, scenario: 'normal' });
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const beforeStop = sends;
  runner.stop();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.ok(beforeStop >= 2 && beforeStop <= 3, `expected about 2 requests, got ${beforeStop}`);
  assert.equal(sends, beforeStop);
});
