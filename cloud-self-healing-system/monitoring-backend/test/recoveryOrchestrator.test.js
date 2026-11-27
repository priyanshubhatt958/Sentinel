const test = require('node:test');
const assert = require('node:assert/strict');

const { client } = require('../src/config/db');
const {
  collectVerificationWindow,
  captureBeforeMetrics,
  recordRecoveryAction,
  reconcileRecoveryActions
} = require('../src/services/recoveryOrchestrator');

test('decision-only audit rows store no before, after, or effectiveness metrics', async () => {
  const originalQuery = client.query;
  let insertedValues;
  client.query = async (sql, values) => {
    assert.match(sql, /INSERT INTO recovery_actions/);
    insertedValues = values;
    return { rows: [{ id: 21, status: 'skipped' }] };
  };
  try {
    await recordRecoveryAction({
      incident: { id: 7 },
      action: { target: 'payment-service', status: 'skipped' },
      triggeredBy: 'manual',
      status: 'skipped',
      recoveryStatus: 'skipped',
      message: 'No safe recovery action available.'
    });
  } finally {
    client.query = originalQuery;
  }
  assert.equal(insertedValues[7], null);
  assert.equal(insertedValues[26], null);
  assert.equal(insertedValues[27], null);
  assert.equal(insertedValues[28], null);
});

test('before-action capture uses a fresh monitoring collection and preserves measured values', async () => {
  let called = false;
  const beforeMetrics = await captureBeforeMetrics('payment-service', async (serviceName) => {
    called = true;
    assert.equal(serviceName, 'payment-service');
    return [{
      serviceName,
      cpuPercent: 42,
      memoryPercent: 31,
      averageLatencyMs: 120,
      serviceErrorRate: 2,
      probe: { ok: true, latencyMs: 8 }
    }];
  });
  assert.equal(called, true);
  assert.equal(beforeMetrics.cpuUsage, 42);
  assert.equal(beforeMetrics.memoryUsage, 31);
  assert.equal(beforeMetrics.latencyMs, 120);
});

test('verification window collects six fresh samples and averages the measured after metrics', async () => {
  let collected = 0;
  const result = await collectVerificationWindow({
    targetService: 'payment-service',
    beforeMetrics: { cpuUsage: 40, memoryUsage: 20, latencyMs: 200, errorRate: 10, probeFailures: 4 },
    verificationWindowMs: 30000,
    sampleCount: 6,
    wait: async () => {},
    collectMetrics: async () => {
      collected += 1;
      return [{
        serviceName: 'payment-service',
        cpuPercent: 20,
        memoryPercent: 10,
        averageLatencyMs: 100,
        serviceErrorRate: 2,
        probe: { ok: true, latencyMs: 5 }
      }];
    }
  });
  assert.equal(collected, 6);
  assert.equal(result.verificationSamples.length, 6);
  assert.equal(result.verification.samplesUsed, 6);
  assert.equal(result.afterMetrics.cpuUsage, 20);
  assert.equal(result.afterMetrics.latencyMs, 100);
});

test('verification stays pending until at least three fresh samples are available', async () => {
  let calls = 0;
  const result = await collectVerificationWindow({
    targetService: 'payment-service',
    beforeMetrics: { cpuUsage: 40 },
    verificationWindowMs: 30000,
    sampleCount: 6,
    wait: async () => {},
    collectMetrics: async () => {
      calls += 1;
      if (calls > 2) throw new Error('sample unavailable');
      return [{ serviceName: 'payment-service', cpuPercent: 20, probe: { ok: true } }];
    }
  });
  assert.equal(result.verification.status, 'verification_pending');
  assert.equal(result.verification.samplesUsed, 2);
  assert.equal(result.sampleErrors.length, 4);
});

test('reconciliation expires stale planned and verification-pending actions after ten minutes', async () => {
  const queries = [];
  const db = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('UPDATE recovery_actions') && sql.includes('RETURNING id, incident_id, created_at')) {
        return { rows: [{ id: 1, incident_id: 7, created_at: new Date(0) }] };
      }
      return { rows: [] };
    }
  };
  const result = await reconcileRecoveryActions({ db });
  assert.equal(result.expiredCount, 1);
  assert.match(queries[0], /status IN \('planned', 'verification_pending'\)/);
  assert.match(queries[0], /INTERVAL '10 minutes'/);
});

test('reconciliation fails executing actions whose target container no longer exists', async () => {
  const queries = [];
  const db = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("WHERE status = 'executing'")) {
        return { rows: [{ id: 4, incident_id: 7, target_service: 'payment-service', created_at: new Date(0) }] };
      }
      if (sql.includes("WHERE id = $2 AND status = 'executing'")) return { rows: [{ id: 4 }] };
      return { rows: [] };
    }
  };
  const result = await reconcileRecoveryActions({
    db,
    listContainers: async () => []
  });
  assert.equal(result.failedCount, 1);
  assert.ok(queries.some((sql) => sql.includes("SET status = 'failed', recovery_status = 'failed'")));
});
