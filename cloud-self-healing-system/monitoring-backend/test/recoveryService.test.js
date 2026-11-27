const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const {
  decideRecoveryAction,
  recommendRecovery,
  validateAction,
  getRecoveryConfig,
  updateRecoveryConfig,
  composeScaleArguments
} = require('../src/services/recoveryService');
const {
  aggregateSamples,
  calculateCooldownMs,
  shouldLimitAutomaticRecovery
} = require('../src/services/recoveryOrchestrator');

const recoveryConfig = { maxServiceReplicas: 5, minServiceReplicas: 2 };

test('automatic recovery defaults off when no enabling environment value is supplied', () => {
  const modulePath = path.resolve(__dirname, '../src/services/recoveryService.js');
  const result = execFileSync(process.execPath, ['-e', `process.env.AUTO_RECOVERY_ENABLED=''; console.log(require(${JSON.stringify(modulePath)}).getRecoveryConfig().autoRecoveryEnabled)`], { encoding: 'utf8' });
  assert.equal(result.replace(/\u001b\[[0-9;]*m/g, '').trim(), 'false');
});

test('scales payment by exactly one replica for traffic spikes and CPU overload', () => {
  for (const incidentType of ['traffic_spike', 'cpu_overload']) {
    const action = decideRecoveryAction({ incident_type: incidentType, root_cause: 'payment-service' }, 2, recoveryConfig);
    assert.equal(action.action, 'scale_service');
    assert.equal(action.target, 'payment-service');
    assert.equal(action.fromReplicas, 2);
    assert.equal(action.toReplicas, 3);
  }
});

test('restarts payment for a payment memory leak', () => {
  const action = decideRecoveryAction({ incident_type: 'memory_leak', root_cause: 'payment-service' }, 2, recoveryConfig);
  assert.equal(action.action, 'restart_service');
  assert.equal(action.target, 'payment-service');
});

test('database bottleneck requires database remediation rather than restarting an app', () => {
  const action = decideRecoveryAction({ incident_type: 'database_bottleneck', root_cause: 'database' }, 2, recoveryConfig);
  assert.equal(action.action, null);
  assert.equal(action.target, 'not_applicable');
  assert.equal(action.status, 'manual_intervention_required');
  assert.match(action.reason, /Application-only recovery cannot repair a database-level issue/i);
});

test('recommends safe actions and escalates after repeated recovery failures', () => {
  assert.equal(
    recommendRecovery({ incident_type: 'traffic_spike', root_cause: 'payment-service' }).recommendation,
    'scale_service'
  );
  assert.equal(
    recommendRecovery({ incident_type: 'database_bottleneck', root_cause: 'database' }).recommendation,
    'database_remediation_required'
  );
  assert.equal(
    recommendRecovery({ incident_type: 'memory_leak', root_cause: 'payment-service' }, 3).recommendation,
    'manual_intervention_required'
  );
  assert.equal(
    recommendRecovery({ incident_type: 'traffic_spike', root_cause: 'payment-service', recovery_status: 'recovered' }).recommendation,
    'no_action_required'
  );
});

test('network failure only restarts an allowlisted affected service', () => {
  const allowed = decideRecoveryAction({ incident_type: 'network_failure', service_name: 'unknown', affected_services: ['user-service'] });
  const rejected = decideRecoveryAction({ incident_type: 'network_failure', service_name: 'database', affected_services: ['database'] });
  assert.deepEqual({ action: allowed.action, target: allowed.target }, { action: 'restart_service', target: 'user-service' });
  assert.equal(rejected.status, 'skipped');
});

test('replica maximum returns a no-execution status', () => {
  const action = decideRecoveryAction({ incident_type: 'traffic_spike', root_cause: 'payment-service' }, 5, recoveryConfig);
  assert.equal(action.status, 'blocked');
  assert.equal(action.action, null);
});

test('generates a Docker Compose-compatible scale command for the requested replica count', () => {
  const args = composeScaleArguments({
    action: 'scale_service',
    target: 'payment-service',
    fromReplicas: 2,
    toReplicas: 3
  }, { minServiceReplicas: 1, maxServiceReplicas: 5 });
  assert.deepEqual(args, [
    'compose',
    '--project-directory', '/workspace',
    '--project-name', 'cloud-self-healing-system',
    '--file', '/workspace/docker-compose.yml',
    'up',
    '--detach',
    '--no-deps',
    '--no-build',
    '--no-recreate',
    '--scale', 'payment-service=3',
    'payment-service'
  ]);
});

test('rejects compose scaling outside the configured replica limit', () => {
  assert.throws(() => composeScaleArguments({
    action: 'scale_service',
    target: 'payment-service',
    fromReplicas: 5,
    toReplicas: 6
  }, { minServiceReplicas: 1, maxServiceReplicas: 5 }), /replica count/);
});

test('unknown actions and target services are rejected', () => {
  assert.throws(() => validateAction({ action: 'delete_container', target: 'payment-service' }), /not allowlisted/);
  assert.throws(() => validateAction({ action: 'restart_service', target: 'database' }), /not allowlisted/);
});

test('automatic recovery defaults off and safe config can be updated', () => {
  const previous = getRecoveryConfig();
  updateRecoveryConfig({ autoRecoveryEnabled: false });
  assert.equal(getRecoveryConfig().autoRecoveryEnabled, false);
  updateRecoveryConfig({ autoRecoveryEnabled: true });
  assert.equal(getRecoveryConfig().autoRecoveryEnabled, true);
  updateRecoveryConfig({ autoRecoveryEnabled: previous.autoRecoveryEnabled });
  assert.throws(() => updateRecoveryConfig({ verificationSamples: 2 }), /between 3 and 6/);
  assert.throws(() => updateRecoveryConfig({ verificationDelayMs: 10000 }), /between 30000 and 60000/);
  assert.throws(() => updateRecoveryConfig({ dockerCommand: 'docker rm -f x' }), /Unsupported/);
});

test('automatic recovery rate limit rejects action at the configured cap', () => {
  assert.equal(shouldLimitAutomaticRecovery(4, 5), false);
  assert.equal(shouldLimitAutomaticRecovery(5, 5), true);
});

test('recovery cooldown grows after repeated failures and remains capped', () => {
  assert.equal(calculateCooldownMs(120000, 0), 120000);
  assert.equal(calculateCooldownMs(120000, 1), 240000);
  assert.equal(calculateCooldownMs(120000, 3), 960000);
  assert.equal(calculateCooldownMs(120000, 4), 1800000);
  assert.equal(calculateCooldownMs(120000, 5), 1800000);
});

test('aggregates recovery metrics across replicas using comparable service-level units', () => {
  const metrics = aggregateSamples([
    {
      serviceName: 'payment-service',
      cpuPercent: 50,
      memoryPercent: 40,
      totalRequests: 100,
      successfulRequests: 90,
      failedRequests: 10,
      requestsLastMinute: 10,
      requestsPerSecond: 2,
      averageLatencyMs: 100,
      serviceErrorRate: 10,
      dbTotalQueries: 10,
      dbActiveConnections: 3,
      dbAverageQueryLatencyMs: 100,
      dbErrorRate: 1,
      lifecycleState: 'running',
      probe: { ok: true, latencyMs: 10 }
    },
    {
      serviceName: 'payment-service',
      cpuPercent: 40,
      memoryPercent: 30,
      totalRequests: 200,
      successfulRequests: 190,
      failedRequests: 10,
      requestsLastMinute: 30,
      requestsPerSecond: 4,
      averageLatencyMs: 200,
      serviceErrorRate: 0,
      dbTotalQueries: 30,
      dbActiveConnections: 4,
      dbAverageQueryLatencyMs: 200,
      dbErrorRate: 2,
      lifecycleState: 'running',
      probe: { ok: true, latencyMs: 20 }
    }
  ]);

  assert.equal(metrics.totalRequests, 300);
  assert.equal(metrics.requestsPerSecond, 6);
  assert.equal(metrics.averageLatencyMs, 175);
  assert.equal(metrics.latencyMs, 175);
  assert.equal(metrics.probeLatencyMs, 15);
  assert.equal(metrics.probeFailures, 0);
  assert.equal(metrics.errorRate, 2.5);
  assert.equal(metrics.dbActiveConnections, 7);
  assert.equal(metrics.dbAverageQueryLatencyMs, 150);
});

test('probe failures are counted per service probe, not per replica, and probe latency is not application latency', () => {
  const metrics = aggregateSamples([
    { serviceName: 'payment-service', probe: { ok: false, latencyMs: 200 }, averageLatencyMs: null },
    { serviceName: 'payment-service', probe: { ok: false, latencyMs: 200 }, averageLatencyMs: null }
  ]);
  assert.equal(metrics.probeFailures, 1);
  assert.equal(metrics.probeLatencyMs, 200);
  assert.equal(metrics.latencyMs, null);
});
