const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyRecovery } = require('../src/services/recoveryVerifier');

test('scores only meaningful threshold-qualified improvements and keeps CPU-only recovery partial', () => {
  const result = verifyRecovery(
    { cpuUsage: 40, memoryUsage: 1, latencyMs: 702, errorRate: 0, probeFailures: 0 },
    { cpuUsage: 7, memoryUsage: 1, latencyMs: 699, errorRate: 0, probeFailures: 0 },
    6,
    30000
  );
  assert.equal(result.status, 'partially_recovered');
  assert.equal(result.effectivenessScore, 24.75);
  assert.equal(result.effectivenessByMetric.cpuImprovement.thresholdMet, true);
  assert.equal(result.effectivenessByMetric.memoryImprovement.thresholdMet, false);
  assert.equal(result.effectivenessByMetric.latencyImprovement.thresholdMet, false);
  assert.equal(result.effectivenessByMetric.errorRateImprovement.thresholdMet, false);
});

test('tiny latency changes cannot create a recovery score', () => {
  const result = verifyRecovery(
    { latencyMs: 702, cpuUsage: 20, memoryUsage: 10, errorRate: 0, probeFailures: 0 },
    { latencyMs: 699, cpuUsage: 20, memoryUsage: 10, errorRate: 0, probeFailures: 0 }
  );
  assert.equal(result.status, 'not_recovered');
  assert.equal(result.effectivenessScore, 0);
  assert.equal(result.effectivenessByMetric.latencyImprovement.improvementPercent, null);
});

test('applies the stated absolute CPU and memory thresholds', () => {
  const result = verifyRecovery(
    { cpuUsage: 40, memoryUsage: 20, latencyMs: 100, errorRate: 10, probeFailures: 4 },
    { cpuUsage: 32, memoryUsage: 16, latencyMs: 80, errorRate: 8, probeFailures: 2 }
  );
  assert.equal(result.effectivenessByMetric.cpuImprovement.thresholdMet, false);
  assert.equal(result.effectivenessByMetric.memoryImprovement.thresholdMet, false);
  assert.equal(result.effectivenessByMetric.latencyImprovement.thresholdMet, true);
  assert.equal(result.effectivenessByMetric.errorRateImprovement.thresholdMet, true);
  assert.equal(result.effectivenessByMetric.probeHealthImprovement.thresholdMet, true);
});

test('marks recovery complete only when weighted meaningful improvements reach the threshold', () => {
  const result = verifyRecovery(
    { cpuUsage: 80, memoryUsage: 80, latencyMs: 200, errorRate: 10, probeFailures: 10 },
    { cpuUsage: 8, memoryUsage: 8, latencyMs: 20, errorRate: 1, probeFailures: 0 }
  );
  assert.equal(result.status, 'recovered');
  assert.equal(result.effectivenessScore, 91);
});

test('requires at least 50 percent fewer probe failures or zero remaining failures', () => {
  const partial = verifyRecovery(
    { probeFailures: 10 },
    { probeFailures: 6 }
  );
  const improved = verifyRecovery(
    { probeFailures: 10 },
    { probeFailures: 5 }
  );
  assert.equal(partial.effectivenessByMetric.probeHealthImprovement.thresholdMet, false);
  assert.equal(improved.effectivenessByMetric.probeHealthImprovement.thresholdMet, true);
});

test('keeps verification pending when metrics cannot be compared', () => {
  assert.equal(verifyRecovery({ cpuUsage: 1 }, { cpuUsage: null }).status, 'verification_pending');
  assert.equal(verifyRecovery({ cpuUsage: 20 }, null).status, 'verification_pending');
});
