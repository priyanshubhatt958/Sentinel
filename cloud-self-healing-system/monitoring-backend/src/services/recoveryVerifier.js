function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentReduction(before, after) {
  const oldValue = numeric(before);
  const newValue = numeric(after);
  if (oldValue === null || newValue === null || oldValue <= 0) return null;
  return Math.min(100, Math.max(0, ((oldValue - newValue) / oldValue) * 100));
}

function verificationValues(metrics = {}) {
  const load = metrics.loadMetrics || {};
  return {
    cpuUsage: numeric(metrics.cpuUsage ?? metrics.cpu_percent),
    memoryUsage: numeric(metrics.memoryUsage ?? metrics.memory_percent),
    probeLatencyMs: numeric(metrics.probeLatencyMs ?? metrics.probe_latency_ms),
    probeFailures: numeric(metrics.probeFailures),
    errorRate: numeric(metrics.errorRate ?? load.errorRate ?? metrics.load_error_rate),
    latencyMs: numeric(metrics.latencyMs ?? metrics.averageLatencyMs ?? load.averageLatencyMs ?? metrics.load_average_latency_ms),
    p95LatencyMs: numeric(metrics.p95LatencyMs ?? metrics.p95_latency_ms),
    dbAverageQueryLatencyMs: numeric(metrics.dbAverageQueryLatencyMs ?? metrics.db_average_query_latency_ms),
    dbErrorRate: numeric(metrics.dbErrorRate ?? metrics.db_error_rate),
    requestRate: numeric(metrics.requestRate ?? load.currentRequestsPerSecond ?? metrics.load_current_requests_per_second),
    containerState: metrics.containerState ?? metrics.lifecycle_state ?? null
  };
}

function measuredReduction(before, after, requiredReduction, requiredAbsoluteReduction = 0) {
  const oldValue = numeric(before);
  const newValue = numeric(after);
  if (oldValue === null || newValue === null || oldValue <= 0) return null;
  const absoluteReduction = oldValue - newValue;
  const reductionPercent = Math.min(100, Math.max(0, (absoluteReduction / oldValue) * 100));
  if (absoluteReduction < requiredAbsoluteReduction || reductionPercent < requiredReduction) return null;
  return reductionPercent;
}

function probeHealthReduction(before, after) {
  const oldValue = numeric(before);
  const newValue = numeric(after);
  if (oldValue === null || newValue === null || oldValue <= 0) return null;
  if (newValue === 0) return 100;
  const reduction = (oldValue - newValue) / oldValue;
  return reduction >= 0.5 ? Number((reduction * 100).toFixed(2)) : null;
}

function verifyRecovery(beforeMetrics, afterMetrics, samplesUsed = null, verificationWindowMs = null) {
  if (!beforeMetrics || !afterMetrics) {
    return {
      status: 'verification_pending',
      effectivenessScore: null,
      effectivenessByMetric: null,
      beforeMetrics: beforeMetrics || null,
      afterMetrics: afterMetrics || null,
      samplesUsed,
      verificationWindowMs
    };
  }

  const before = verificationValues(beforeMetrics);
  const after = verificationValues(afterMetrics);
  const definitions = [
    { key: 'cpuImprovement', before: before.cpuUsage, after: after.cpuUsage, weight: 30, required: 'at least 10 percentage points' },
    { key: 'memoryImprovement', before: before.memoryUsage, after: after.memoryUsage, weight: 25, required: 'at least 5 percentage points' },
    { key: 'latencyImprovement', before: before.latencyMs, after: after.latencyMs, weight: 20, required: 'at least 15% reduction' },
    { key: 'errorRateImprovement', before: before.errorRate, after: after.errorRate, weight: 15, required: 'at least 20% reduction' },
    { key: 'probeHealthImprovement', before: before.probeFailures, after: after.probeFailures, weight: 10, required: 'zero failures or at least 50% fewer failures' }
  ];

  const effectivenessByMetric = {};
  let score = 0;
  let comparableMetricCount = 0;
  let improvedMetricCount = 0;
  for (const definition of definitions) {
    const oldValue = numeric(definition.before);
    const newValue = numeric(definition.after);
    const comparable = oldValue !== null && newValue !== null;
    if (comparable) comparableMetricCount += 1;
    let improvementPercent = null;
    if (definition.key === 'cpuImprovement') {
      improvementPercent = measuredReduction(oldValue, newValue, 0, 10);
    } else if (definition.key === 'memoryImprovement') {
      improvementPercent = measuredReduction(oldValue, newValue, 0, 5);
    } else if (definition.key === 'latencyImprovement') {
      improvementPercent = measuredReduction(oldValue, newValue, 15);
    } else if (definition.key === 'errorRateImprovement') {
      improvementPercent = measuredReduction(oldValue, newValue, 20);
    } else {
      improvementPercent = probeHealthReduction(oldValue, newValue);
    }

    const thresholdMet = improvementPercent !== null;
    effectivenessByMetric[definition.key] = {
      before: oldValue,
      after: newValue,
      weight: definition.weight,
      required: definition.required,
      thresholdMet,
      improvementPercent
    };
    if (thresholdMet) {
      score += improvementPercent * (definition.weight / 100);
      improvedMetricCount += 1;
    }
  }

  if (!comparableMetricCount) {
    return {
      status: 'verification_pending',
      effectivenessScore: null,
      effectivenessByMetric,
      beforeMetrics: before,
      afterMetrics: after,
      samplesUsed,
      verificationWindowMs
    };
  }

  const effectivenessScore = Number(score.toFixed(2));
  const status = effectivenessScore >= 80
    ? 'recovered'
    : improvedMetricCount > 0
      ? 'partially_recovered'
      : 'not_recovered';

  return {
    status,
    effectivenessScore,
    effectivenessByMetric,
    beforeMetrics: before,
    afterMetrics: after,
    samplesUsed,
    verificationWindowMs
  };
}

module.exports = {
  verifyRecovery,
  verificationValues,
  percentReduction,
  measuredReduction,
  probeHealthReduction
};
