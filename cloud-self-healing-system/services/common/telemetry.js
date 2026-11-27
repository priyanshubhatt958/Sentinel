const { Worker } = require('worker_threads');
const logger = require('./logger');

const SIMULATION_TYPES = ['traffic-spike', 'database-overload', 'memory-leak', 'cpu-overload'];
const CPU_WORKER_SOURCE = `
  const { workerData } = require('worker_threads');
  function work() {
    const until = Date.now() + workerData.busyMs;
    while (Date.now() < until) {}
    setTimeout(work, workerData.idleMs);
  }
  work();
`;

function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)].toFixed(2));
}

function createTelemetry(serviceName, businessPrefixes) {
  const startedAt = Date.now();
  const completedRequests = [];
  const latencySamples = [];
  let totalRequests = 0;
  let successfulRequests = 0;
  let failedRequests = 0;
  let activeRequests = 0;
  let maxLatencyMs = 0;
  let minLatencyMs = null;
  let lastError = null;
  let lastRequestAt = null;

  function prune(now = Date.now()) {
    while (completedRequests.length && completedRequests[0].at < now - 60000) completedRequests.shift();
    while (latencySamples.length && latencySamples[0].at < now - 60000) latencySamples.shift();
  }

  function middleware(req, res, next) {
    if (!businessPrefixes.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
      return next();
    }

    activeRequests += 1;
    const started = process.hrtime.bigint();
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      activeRequests = Math.max(0, activeRequests - 1);
      totalRequests += 1;
      const now = Date.now();
      const latencyMs = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(2));
      completedRequests.push({ at: now, success: res.statusCode < 400 });
      latencySamples.push({ at: now, latencyMs });
      maxLatencyMs = Math.max(maxLatencyMs, latencyMs);
      minLatencyMs = minLatencyMs === null ? latencyMs : Math.min(minLatencyMs, latencyMs);
      lastRequestAt = new Date(now).toISOString();
      if (res.statusCode >= 400) {
        failedRequests += 1;
        lastError = res.locals.telemetryError || `HTTP ${res.statusCode}`;
      } else {
        successfulRequests += 1;
      }
      prune(now);
    };

    res.once('finish', complete);
    res.once('close', complete);
    next();
  }

  function snapshot() {
    prune();
    const currentLatencySamples = latencySamples.map((sample) => sample.latencyMs);
    return {
      service: serviceName,
      totalRequests,
      successfulRequests,
      failedRequests,
      activeRequests,
      requestsLastMinute: completedRequests.length,
      requestsPerSecond: completedRequests.filter((request) => request.at > Date.now() - 1000).length,
      averageLatencyMs: currentLatencySamples.length
        ? Number((currentLatencySamples.reduce((sum, latency) => sum + latency, 0) / currentLatencySamples.length).toFixed(2))
        : 0,
      p95LatencyMs: percentile(currentLatencySamples, 0.95),
      maxLatencyMs: Number(maxLatencyMs.toFixed(2)),
      minLatencyMs: minLatencyMs === null ? 0 : Number(minLatencyMs.toFixed(2)),
      errorRate: completedRequests.length
        ? Number(((completedRequests.filter((request) => !request.success).length / completedRequests.length) * 100).toFixed(2))
        : 0,
      lastError,
      lastRequestAt,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
    };
  }

  return { middleware, snapshot };
}

function createSimulationController(serviceName) {
  const configuredMaxDuration = Number(process.env.SIMULATION_MAX_DURATION_MS || 60000);
  const maxDurationMs = Math.min(60000, Math.max(1000, Number.isFinite(configuredMaxDuration) ? configuredMaxDuration : 60000));
  const configuredCpuPercent = Number(process.env.CPU_LOAD_PERCENT || 70);
  const cpuLoadPercent = Math.min(90, Math.max(1, Number.isFinite(configuredCpuPercent) ? configuredCpuPercent : 70));
  const configuredMemoryMb = Number(process.env.MEMORY_LOAD_MB || 100);
  const memoryLoadMb = Math.min(256, Math.max(1, Number.isFinite(configuredMemoryMb) ? configuredMemoryMb : 100));
  const configuredDbDelay = Number(process.env.DATABASE_DELAY_MS || 300);
  const databaseDelayMs = Math.min(2000, Math.max(0, Number.isFinite(configuredDbDelay) ? configuredDbDelay : 300));
  const configuredMultiplier = Number(process.env.DATABASE_QUERY_MULTIPLIER || 5);
  const databaseQueryMultiplier = Math.min(10, Math.max(1, Number.isInteger(configuredMultiplier) ? configuredMultiplier : 5));
  const simulations = new Map(SIMULATION_TYPES.map((type) => [type, {
    type,
    service: serviceName,
    active: false,
    startedAt: null,
    endsAt: null,
    endedAt: null,
    durationMs: null,
    maxDurationMs,
    cleanupStatus: 'not_started'
  }]));
  const resources = new Map();

  function stop(type) {
    const state = simulations.get(type);
    if (!state?.active) return;
    state.active = false;
    state.endedAt = new Date().toISOString();
    state.endsAt = null;
    state.cleanupStatus = 'pending';
    const resource = resources.get(type);
    if (resource?.timer) clearTimeout(resource.timer);
    if (resource?.worker) {
      resource.worker.terminate().then(() => {
        state.cleanupStatus = 'completed';
      }).catch((error) => {
        state.cleanupStatus = 'failed';
        logger.error('cpu_simulation_cleanup_failed', { service: serviceName, message: error.message });
      });
    } else {
      state.cleanupStatus = 'completed';
    }
    resources.delete(type);
  }

  function start(type, requestedDurationMs) {
    const state = simulations.get(type);
    if (!state) {
      const error = new Error(`Unknown simulation type: ${type}`);
      error.statusCode = 400;
      throw error;
    }
    if (state.active) {
      const error = new Error(`${type} simulation is already active.`);
      error.statusCode = 409;
      throw error;
    }
    if (requestedDurationMs !== undefined && (!Number.isInteger(Number(requestedDurationMs)) || Number(requestedDurationMs) < 1)) {
      const error = new Error('durationMs must be a positive integer.');
      error.statusCode = 400;
      throw error;
    }

    const durationMs = Math.min(Number(requestedDurationMs || maxDurationMs), maxDurationMs);
    const now = Date.now();
    Object.assign(state, {
      active: true,
      startedAt: new Date(now).toISOString(),
      endsAt: new Date(now + durationMs).toISOString(),
      endedAt: null,
      durationMs,
      cleanupStatus: 'scheduled'
    });

    const resource = { timer: null, worker: null, memory: null };
    if (type === 'memory-leak') resource.memory = Buffer.alloc(memoryLoadMb * 1024 * 1024, 1);
    if (type === 'cpu-overload') {
      const cycleMs = 100;
      const busyMs = Math.max(1, Math.floor(cycleMs * cpuLoadPercent / 100));
      resource.worker = new Worker(CPU_WORKER_SOURCE, {
        eval: true,
        workerData: { busyMs, idleMs: cycleMs - busyMs }
      });
      resource.worker.on('error', (error) => {
        logger.error('cpu_simulation_worker_failed', { service: serviceName, message: error.message });
        stop(type);
      });
    }
    resource.timer = setTimeout(() => stop(type), durationMs);
    resources.set(type, resource);
    return { ...state };
  }

  function stopAll() {
    for (const type of SIMULATION_TYPES) stop(type);
    return getStatus();
  }

  function isActive(type) {
    return Boolean(simulations.get(type)?.active);
  }

  function getStatus() {
    return {
      service: serviceName,
      maxDurationMs,
      simulations: SIMULATION_TYPES.map((type) => ({ ...simulations.get(type) }))
    };
  }

  function middleware(req, res, next) {
    const isBusinessRequest = ['/users', '/orders', '/payments']
      .some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`));
    const delayMs = isBusinessRequest && isActive('traffic-spike') ? databaseDelayMs : 0;
    if (!delayMs) return next();
    setTimeout(() => {
      if (!res.destroyed) next();
    }, delayMs);
  }

  return {
    start,
    stopAll,
    isActive,
    getStatus,
    middleware,
    getDatabaseDelayMs: () => isActive('database-overload') ? databaseDelayMs : 0,
    getDatabaseQueryMultiplier: () => databaseQueryMultiplier
  };
}

module.exports = { createTelemetry, createSimulationController };
