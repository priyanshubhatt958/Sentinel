const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateCpuPercent, calculateMemory } = require('../src/jobs/metricsCollector');

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