function createMetrics() {
  return {
    service: 'load-generator',
    active: false,
    targetService: null,
    scenario: null,
    requestsPerSecond: 0,
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    currentRequestsPerSecond: 0,
    averageLatencyMs: 0,
    maxLatencyMs: 0,
    minLatencyMs: 0,
    errorRate: 0,
    startedAt: null,
    stoppedAt: null,
    timestamp: new Date().toISOString()
  };
}

function createMetricsStore() {
  let metrics = createMetrics();
  let latencyTotal = 0;
  let latencyCount = 0;
  let windowStartedAt = Date.now();
  let windowRequests = 0;

  return {
    start(options) {
      metrics = {
        ...createMetrics(),
        active: true,
        targetService: options.targetService,
        scenario: options.scenario,
        requestsPerSecond: options.requestsPerSecond,
        startedAt: new Date().toISOString()
      };
      latencyTotal = 0;
      latencyCount = 0;
      windowStartedAt = Date.now();
      windowRequests = 0;
    },
    record(result) {
      const latency = Number(result.latencyMs);
      metrics.totalRequests += 1;
      windowRequests += 1;
      if (result.ok) metrics.successfulRequests += 1;
      else metrics.failedRequests += 1;
      if (Number.isFinite(latency)) {
        latencyTotal += latency;
        latencyCount += 1;
        metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, latency);
        metrics.minLatencyMs = metrics.minLatencyMs === 0 ? latency : Math.min(metrics.minLatencyMs, latency);
      }
      metrics.averageLatencyMs = latencyCount ? Number((latencyTotal / latencyCount).toFixed(2)) : 0;
      metrics.errorRate = metrics.totalRequests
        ? Number(((metrics.failedRequests / metrics.totalRequests) * 100).toFixed(2))
        : 0;
      const elapsedSeconds = Math.max((Date.now() - windowStartedAt) / 1000, 0.001);
      metrics.currentRequestsPerSecond = Number((windowRequests / elapsedSeconds).toFixed(2));
      metrics.timestamp = new Date().toISOString();
    },
    stop() {
      metrics.active = false;
      metrics.stoppedAt = new Date().toISOString();
      metrics.timestamp = metrics.stoppedAt;
    },
    snapshot() {
      metrics.timestamp = new Date().toISOString();
      return { ...metrics };
    }
  };
}

module.exports = { createMetrics, createMetricsStore };
