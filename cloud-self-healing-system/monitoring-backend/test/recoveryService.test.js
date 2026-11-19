const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const {
  decideRecoveryAction,
  validateAction,
  getRecoveryConfig,
  updateRecoveryConfig
} = require('../src/services/recoveryService');
const { shouldLimitAutomaticRecovery } = require('../src/services/recoveryOrchestrator');

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

test('database bottleneck selects bounded payment restart, not scaling', () => {
  const action = decideRecoveryAction({ incident_type: 'database_bottleneck', root_cause: 'database' }, 2, recoveryConfig);
  assert.equal(action.action, 'restart_service');
  assert.equal(action.target, 'payment-service');
  assert.match(action.reason, /database-level remediation/i);
});

test('network failure only restarts an allowlisted affected service', () => {
  const allowed = decideRecoveryAction({ incident_type: 'network_failure', service_name: 'unknown', affected_services: ['user-service'] });
  const rejected = decideRecoveryAction({ incident_type: 'network_failure', service_name: 'database', affected_services: ['database'] });
  assert.deepEqual({ action: allowed.action, target: allowed.target }, { action: 'restart_service', target: 'user-service' });
  assert.equal(rejected.status, 'no_safe_action');
});

test('replica maximum returns a no-execution status', () => {
  const action = decideRecoveryAction({ incident_type: 'traffic_spike', root_cause: 'payment-service' }, 5, recoveryConfig);
  assert.equal(action.status, 'max_replicas_reached');
  assert.equal(action.action, null);
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
  assert.throws(() => updateRecoveryConfig({ dockerCommand: 'docker rm -f x' }), /Unsupported/);
});

test('automatic recovery rate limit rejects action at the configured cap', () => {
  assert.equal(shouldLimitAutomaticRecovery(4, 5), false);
  assert.equal(shouldLimitAutomaticRecovery(5, 5), true);
});
