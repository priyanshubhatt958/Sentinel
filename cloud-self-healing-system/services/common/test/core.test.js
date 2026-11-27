const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTelemetry, createSimulationController } = require('../telemetry');
const { createServiceDatabase } = require('../database');

test('records real request outcomes and latency through middleware', async () => {
  const telemetry = createTelemetry('test-service', ['/users']);
  const request = { path: '/users' };
  const response = new EventEmitter();
  response.statusCode = 201;
  response.locals = {};
  telemetry.middleware(request, response, () => {});
  assert.equal(telemetry.snapshot().activeRequests, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  response.emit('finish');

  const metrics = telemetry.snapshot();
  assert.equal(metrics.totalRequests, 1);
  assert.equal(metrics.successfulRequests, 1);
  assert.equal(metrics.failedRequests, 0);
  assert.equal(metrics.requestsLastMinute, 1);
  assert.equal(metrics.errorRate, 0);
  assert.ok(metrics.averageLatencyMs > 0);
  assert.ok(metrics.lastRequestAt);
});

test('reports recent error rate independently from the lifetime request count', async () => {
  const telemetry = createTelemetry('test-service', ['/users']);
  const failedResponse = new EventEmitter();
  failedResponse.statusCode = 503;
  failedResponse.locals = {};
  telemetry.middleware({ path: '/users' }, failedResponse, () => {});
  failedResponse.emit('finish');

  const metrics = telemetry.snapshot();
  assert.equal(metrics.totalRequests, 1);
  assert.equal(metrics.failedRequests, 1);
  assert.equal(metrics.errorRate, 100);
});

test('bounded simulations expire and release allocated resources', async () => {
  const originalDuration = process.env.SIMULATION_MAX_DURATION_MS;
  const originalMemory = process.env.MEMORY_LOAD_MB;
  process.env.SIMULATION_MAX_DURATION_MS = '1000';
  process.env.MEMORY_LOAD_MB = '1';
  try {
    const simulations = createSimulationController('test-service');
    const started = simulations.start('memory-leak', 25);
    assert.equal(started.active, true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const ended = simulations.getStatus().simulations.find((item) => item.type === 'memory-leak');
    assert.equal(ended.active, false);
    assert.ok(ended.endedAt);
    assert.equal(ended.cleanupStatus, 'completed');
  } finally {
    if (originalDuration === undefined) delete process.env.SIMULATION_MAX_DURATION_MS;
    else process.env.SIMULATION_MAX_DURATION_MS = originalDuration;
    if (originalMemory === undefined) delete process.env.MEMORY_LOAD_MB;
    else process.env.MEMORY_LOAD_MB = originalMemory;
  }
});

test('bounded CPU simulation terminates its worker and reports cleanup', async () => {
  const simulations = createSimulationController('test-service');
  simulations.start('cpu-overload', 25);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const ended = simulations.getStatus().simulations.find((item) => item.type === 'cpu-overload');
  assert.equal(ended.active, false);
  assert.equal(ended.cleanupStatus, 'completed');
});

test('counts database query successes, failures, latency, and pool state', async () => {
  class FakePool {
    totalCount = 3;
    idleCount = 1;
    waitingCount = 2;
    on() {}
    async query(sql) {
      if (sql === 'FAIL') throw new Error('forced query failure');
      return { rows: [{ ok: true }] };
    }
    async end() {}
  }

  const simulations = { getDatabaseDelayMs: () => 0, isActive: () => false };
  const database = createServiceDatabase(simulations, { PoolClass: FakePool });
  await database.query('SELECT 1');
  await assert.rejects(database.query('FAIL'), /forced query failure/);

  assert.deepEqual(database.snapshot(), {
    totalDatabaseQueries: 2,
    successfulDatabaseQueries: 1,
    failedDatabaseQueries: 1,
    activeDatabaseConnections: 2,
    idleDatabaseConnections: 1,
    waitingDatabaseRequests: 2,
    averageDatabaseQueryLatencyMs: database.snapshot().averageDatabaseQueryLatencyMs,
    maxDatabaseQueryLatencyMs: database.snapshot().maxDatabaseQueryLatencyMs,
    databaseErrorRate: 50
  });
  assert.ok(database.snapshot().averageDatabaseQueryLatencyMs >= 0);
});

test('service restart persistence integration is opt-in', { skip: process.env.RUN_SERVICE_RESTART_TESTS !== '1' }, async () => {
  const { runServiceRestartPersistenceTest } = require('./persistence.integration.test');
  await runServiceRestartPersistenceTest();
});
