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

function createMetricsStore({ now = Date.now, windowMs = 1000 } = {}) {
  let metrics = createMetrics();
  let latencyTotal = 0;
  let latencyCount = 0;
  let requestTimes = [];

  function refreshWindow(currentTime = now()) {
    requestTimes = requestTimes.filter((timestamp) => timestamp > currentTime - windowMs);
    metrics.currentRequestsPerSecond = Number((requestTimes.length * 1000 / windowMs).toFixed(2));
  }

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
      requestTimes = [];
    },
    record(result, timestamp = now()) {
      const latency = Number(result.latencyMs);
      metrics.totalRequests += 1;
      requestTimes.push(timestamp);
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
      refreshWindow(timestamp);
      metrics.timestamp = new Date(timestamp).toISOString();
    },
    stop() {
      metrics.active = false;
      metrics.stoppedAt = new Date().toISOString();
      metrics.timestamp = metrics.stoppedAt;
    },
    snapshot() {
      const currentTime = now();
      refreshWindow(currentTime);
      metrics.timestamp = new Date(currentTime).toISOString();
      return { ...metrics };
    }
  };
}

module.exports = { createMetrics, createMetricsStore };
