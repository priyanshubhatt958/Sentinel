const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateCpuPercent,
  calculateMemory,
  persistedServiceMetricValues
} = require('../src/jobs/metricsCollector');

test('calculates CPU percentage from successive Docker counters and CPU count', () => {
  const value = calculateCpuPercent({
    cpu_stats: {
      cpu_usage: { total_usage: 150 },
      system_cpu_usage: 1200,
      online_cpus: 2
    },
    precpu_stats: {
      cpu_usage: { total_usage: 100 },
      system_cpu_usage: 1000
    }
  });

  assert.equal(value, 50);
});

test('subtracts Docker cache and reports unknown memory percentage without a limit', () => {
  assert.deepEqual(calculateMemory({ memory_stats: { usage: 1000, limit: 2000, stats: { cache: 200 } } }), {
    used: 800,
    limit: 2000,
    percent: 40
  });
  assert.deepEqual(calculateMemory({ memory_stats: { usage: 1000, limit: 0, stats: {} } }), {
    used: 1000,
    limit: 0,
    percent: null
  });
});

test('preserves collected service and database metrics for PostgreSQL persistence', () => {
  const fields = persistedServiceMetricValues({
    totalRequests: 42,
    requestsPerSecond: 7,
    dbTotalQueries: 100,
    dbActiveConnections: 3,
    dbAverageQueryLatencyMs: 25
  });

  assert.equal(fields.totalRequests, 42);
  assert.equal(fields.requestsPerSecond, 7);
  assert.equal(fields.dbTotalQueries, 100);
  assert.equal(fields.dbActiveConnections, 3);
  assert.equal(fields.dbAverageQueryLatencyMs, 25);
  assert.equal(fields.dbErrorRate, null);
});