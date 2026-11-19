function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentReduction(before, after) {
  const oldValue = numeric(before);
  const newValue = numeric(after);
  if (oldValue === null || newValue === null || oldValue <= 0) return null;
  return Math.max(0, ((oldValue - newValue) / oldValue) * 100);
}

function verificationValues(metrics = {}) {
  const load = metrics.loadMetrics || {};
  return {
    cpuUsage: numeric(metrics.cpuUsage ?? metrics.cpu_percent),
    memoryUsage: numeric(metrics.memoryUsage ?? metrics.memory_percent),
    probeLatencyMs: numeric(metrics.probeLatencyMs ?? metrics.probe_latency_ms),
    probeFailures: numeric(metrics.probeFailures),
    errorRate: numeric(metrics.errorRate ?? load.errorRate ?? metrics.load_error_rate),
    latencyMs: numeric(metrics.latencyMs ?? load.averageLatencyMs ?? metrics.load_average_latency_ms ?? metrics.probeLatencyMs ?? metrics.probe_latency_ms),
    requestRate: numeric(metrics.requestRate ?? load.currentRequestsPerSecond ?? metrics.load_current_requests_per_second),
    containerState: metrics.containerState ?? metrics.lifecycle_state ?? null
  };
}

function verifyRecovery(beforeMetrics, afterMetrics) {
  if (!beforeMetrics || !afterMetrics) {
    return { status: 'pending', effectivenessScore: null, beforeMetrics: beforeMetrics || null, afterMetrics: afterMetrics || null };
  }

  const before = verificationValues(beforeMetrics);
  const after = verificationValues(afterMetrics);
  const latencyReduction = percentReduction(before.latencyMs, after.latencyMs);
  const errorReduction = percentReduction(before.errorRate, after.errorRate);
  const measurableReductions = [
    percentReduction(before.cpuUsage, after.cpuUsage),
    percentReduction(before.memoryUsage, after.memoryUsage),
    percentReduction(before.probeLatencyMs, after.probeLatencyMs),
    percentReduction(before.probeFailures, after.probeFailures),
    errorReduction,
    latencyReduction,
    percentReduction(before.requestRate, after.requestRate)
  ].filter((value) => value !== null);
  const effectivenessScore = measurableReductions.length
    ? Number((measurableReductions.reduce((sum, value) => sum + value, 0) / measurableReductions.length).toFixed(2))
    : null;

  let status = 'not_recovered';
  if (latencyReduction !== null && latencyReduction >= 30 && errorReduction !== null && errorReduction >= 30) {
    status = 'recovered';
  } else {
    const otherImprovements = [
      percentReduction(before.cpuUsage, after.cpuUsage),
      percentReduction(before.memoryUsage, after.memoryUsage),
      percentReduction(before.probeLatencyMs, after.probeLatencyMs),
      percentReduction(before.probeFailures, after.probeFailures),
      percentReduction(before.requestRate, after.requestRate)
    ].some((value) => value !== null && value > 0);
    if ((latencyReduction !== null && latencyReduction > 0)
      || (errorReduction !== null && errorReduction > 0)
      || otherImprovements) {
      status = 'partially_recovered';
    }
  }

  return { status, effectivenessScore, beforeMetrics: before, afterMetrics: after };
}

module.exports = { verifyRecovery, verificationValues, percentReduction };
