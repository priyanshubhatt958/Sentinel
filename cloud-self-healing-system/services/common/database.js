function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
const logger = require('./logger');

function createServiceDatabase(simulations, { PoolClass } = {}) {
  const DatabasePool = PoolClass || require('pg').Pool;
  const pool = new DatabasePool({
    host: process.env.DATABASE_HOST || 'database',
    port: Number(process.env.DATABASE_PORT || 5432),
    database: process.env.DATABASE_NAME || 'cloud_self_healing',
    user: process.env.DATABASE_USER || 'cloud_user',
    password: process.env.DATABASE_PASSWORD || 'cloud_password',
    max: Number(process.env.DB_POOL_MAX || 20),
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS || 30000),
    statement_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS || 5000),
    query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS || 5000)
  });

  const metrics = {
    totalDatabaseQueries: 0,
    successfulDatabaseQueries: 0,
    failedDatabaseQueries: 0,
    totalDatabaseQueryLatencyMs: 0,
    averageDatabaseQueryLatencyMs: 0,
    maxDatabaseQueryLatencyMs: 0
  };
  const recentQueryOutcomes = [];
  const recentQueryLatencies = [];
  let stressRunning = false;

  function pruneRecentMetrics(now = Date.now()) {
    while (recentQueryOutcomes.length && recentQueryOutcomes[0].at < now - 60000) recentQueryOutcomes.shift();
    while (recentQueryLatencies.length && recentQueryLatencies[0].at < now - 60000) recentQueryLatencies.shift();
  }

  pool.on('error', (error) => {
    logger.error('postgres_pool_error', { message: error.message });
  });

  async function execute(text, values = [], addSimulationDelay = true) {
    const simulationDelay = addSimulationDelay ? simulations.getDatabaseDelayMs() : 0;
    if (simulationDelay) await delay(simulationDelay);
    const started = process.hrtime.bigint();
    metrics.totalDatabaseQueries += 1;
    try {
      const result = await pool.query(text, values);
      metrics.successfulDatabaseQueries += 1;
      recentQueryOutcomes.push({ at: Date.now(), success: true });
      return result;
    } catch (error) {
      metrics.failedDatabaseQueries += 1;
      recentQueryOutcomes.push({ at: Date.now(), success: false });
      throw error;
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6 + simulationDelay;
      metrics.totalDatabaseQueryLatencyMs += elapsedMs;
      metrics.averageDatabaseQueryLatencyMs = Number((metrics.totalDatabaseQueryLatencyMs / metrics.totalDatabaseQueries).toFixed(2));
      metrics.maxDatabaseQueryLatencyMs = Number(Math.max(metrics.maxDatabaseQueryLatencyMs, elapsedMs).toFixed(2));
      recentQueryLatencies.push({ at: Date.now(), latencyMs: elapsedMs });
      pruneRecentMetrics();
    }
  }

  function snapshot() {
    pruneRecentMetrics();
    const activeConnections = Math.max(0, pool.totalCount - pool.idleCount);
    const databaseErrorRate = recentQueryOutcomes.length
      ? Number(((recentQueryOutcomes.filter((query) => !query.success).length / recentQueryOutcomes.length) * 100).toFixed(2))
      : 0;
    const recentAverageLatency = recentQueryLatencies.length
      ? recentQueryLatencies.reduce((sum, query) => sum + query.latencyMs, 0) / recentQueryLatencies.length
      : 0;
    return {
      totalDatabaseQueries: metrics.totalDatabaseQueries,
      successfulDatabaseQueries: metrics.successfulDatabaseQueries,
      failedDatabaseQueries: metrics.failedDatabaseQueries,
      activeDatabaseConnections: activeConnections,
      idleDatabaseConnections: pool.idleCount,
      waitingDatabaseRequests: pool.waitingCount,
      averageDatabaseQueryLatencyMs: Number(recentAverageLatency.toFixed(2)),
      maxDatabaseQueryLatencyMs: Number(metrics.maxDatabaseQueryLatencyMs.toFixed(2)),
      databaseErrorRate
    };
  }

  async function runDatabaseStress() {
    if (stressRunning) return;
    stressRunning = true;
    try {
      while (simulations.isActive('database-overload')) {
        const delayMs = simulations.getDatabaseDelayMs();
        const concurrency = simulations.getDatabaseQueryMultiplier();
        const sleepSeconds = Math.max(delayMs, 1) / 1000;
        await Promise.all(Array.from({ length: concurrency }, () =>
          execute('SELECT pg_sleep($1)', [sleepSeconds], false).catch((error) => {
            logger.warn('database_stress_query_failed', { message: error.message });
          })
        ));
      }
    } finally {
      stressRunning = false;
    }
  }

  return {
    pool,
    query: execute,
    snapshot,
    runDatabaseStress,
    async checkHealth() {
      await execute('SELECT 1');
      return true;
    },
    close: () => pool.end()
  };
}

module.exports = { createServiceDatabase };
