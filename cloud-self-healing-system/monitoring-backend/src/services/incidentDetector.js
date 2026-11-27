const { client } = require('../config/db');
const { detectAnomaly, predictFailure, classifyIncident, analyzeRootCause } = require('./mlService');

const ACTIVE_RECOVERY_STATUSES = ['pending', 'open', 'in_progress', 'partially_recovered'];
const DETECTION_COOLDOWN_MS = 2 * 60 * 1000;
const inFlightServices = new Set();

function numberOrNull(value) {
  return value === null || value === undefined || value === '' || Number.isNaN(Number(value)) ? null : Number(value);
}

async function latestLoadMetrics() {
  const result = await client.query(
    `SELECT * FROM monitoring_samples
     WHERE service_name = 'load-generator' AND collected_at >= NOW() - INTERVAL '30 seconds'
     ORDER BY collected_at DESC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function probeFailureCount(serviceName) {
  const result = await client.query(
    `SELECT COUNT(*)::INTEGER AS failures FROM monitoring_samples
     WHERE service_name = $1 AND probe_ok = FALSE AND collected_at >= NOW() - INTERVAL '2 minutes'`,
    [serviceName]
  );
  return Number(result.rows[0]?.failures || 0);
}

async function buildRealMetrics(sample) {
  const load = await latestLoadMetrics();
  const loadTargetsService = load?.load_target_service === sample.service_name || load?.load_target_service === 'all';
  const probeFailures = await probeFailureCount(sample.service_name);
  const requestsLastMinute = numberOrNull(sample.requests_last_minute);
  const serviceRequestsPerSecond = numberOrNull(sample.requests_per_second);
  const loadRequestsPerSecond = loadTargetsService ? numberOrNull(load.load_current_requests_per_second) : null;
  const requestRate = loadRequestsPerSecond === null
    ? serviceRequestsPerSecond ?? (requestsLastMinute === null ? null : Number((requestsLastMinute / 60).toFixed(2)))
    : Math.max(serviceRequestsPerSecond || 0, loadRequestsPerSecond);

  return {
    service: sample.service_name,
    cpuUsage: numberOrNull(sample.cpu_percent),
    memoryUsage: numberOrNull(sample.memory_percent),
    totalRequests: numberOrNull(sample.total_requests),
    successfulRequests: numberOrNull(sample.successful_requests),
    failedRequests: numberOrNull(sample.failed_requests),
    activeRequests: numberOrNull(sample.active_requests),
    requestsLastMinute,
    requestsPerSecond: numberOrNull(sample.requests_per_second),
    requestRate,
    averageLatencyMs: numberOrNull(sample.average_latency_ms),
    p95LatencyMs: numberOrNull(sample.p95_latency_ms),
    latencyMs: numberOrNull(sample.average_latency_ms) ?? numberOrNull(sample.probe_latency_ms),
    errorRate: numberOrNull(sample.service_error_rate)
      ?? (loadTargetsService ? numberOrNull(load.load_error_rate) : null),
    dbActiveConnections: numberOrNull(sample.db_active_connections),
    dbWaitingRequests: numberOrNull(sample.db_waiting_requests),
    dbAverageQueryLatencyMs: numberOrNull(sample.db_average_query_latency_ms),
    dbErrorRate: numberOrNull(sample.db_error_rate),
    dbConnections: numberOrNull(sample.db_active_connections),
    probeLatencyMs: numberOrNull(sample.probe_latency_ms),
    probeFailures,
    restartCount: sample.restart_count === null ? null : Number(sample.restart_count),
    containerState: sample.lifecycle_state,
    loadMetrics: loadTargetsService ? {
      active: load.load_active,
      targetService: load.load_target_service,
      scenario: load.load_scenario,
      totalRequests: load.load_total_requests,
      successfulRequests: load.load_successful_requests,
      failedRequests: load.load_failed_requests,
      currentRequestsPerSecond: load.load_current_requests_per_second,
      averageLatencyMs: load.load_average_latency_ms,
      errorRate: load.load_error_rate
    } : null
  };
}

function incidentEvidence(metrics, detection, prediction, classification, rootCause) {
  return {
    latestMetrics: metrics,
    anomaly: detection,
    failurePrediction: prediction,
    classification,
    rootCause
  };
}

async function persistIncident(service, metrics, detection, prediction, classification, rootCause) {
  const incidentType = classification.incidentType || 'unknown';
  const evidence = incidentEvidence(metrics, detection, prediction, classification, rootCause);
  const detectedBy = detection.detectedBy || [];
  const contributingFeatures = detection.contributingFeatures || [];
  const propagationPath = rootCause.propagationPath || [service];
  const confidence = numberOrNull(classification.confidence ?? classification.classificationConfidence);
  const existingResult = await client.query(
    `SELECT * FROM incidents WHERE service_name = $1 AND incident_type = $2 ORDER BY created_at DESC LIMIT 1`,
    [service, incidentType]
  );
  const existing = existingResult.rows[0];
  const isActive = existing && ACTIVE_RECOVERY_STATUSES.includes(existing.recovery_status);
  const isWithinCooldown = existing && Date.now() - new Date(existing.created_at).getTime() < DETECTION_COOLDOWN_MS;

  if (isActive) {
    const updated = await client.query(
      `UPDATE incidents SET anomaly_score = $1, failure_probability = $2, risk_level = $3,
       evidence = $4, detected_by = $5, contributing_features = $6, classification_confidence = $7,
       propagation_path = $8, latest_metrics = $9, genai_summary = NULL, genai_summary_source = NULL,
       anomaly_detected_at = NOW(), updated_at = NOW()
       WHERE id = $10 RETURNING *`,
      [numberOrNull(detection.anomalyScore), numberOrNull(prediction.failureProbability), prediction.riskLevel || 'LOW',
        JSON.stringify(evidence), detectedBy, contributingFeatures, confidence, propagationPath, JSON.stringify(metrics), existing.id]
    );
    return { created: false, updated: true, incident: updated.rows[0] };
  }

  if (isWithinCooldown) return { created: false, updated: false, skipped: true, reason: 'cooldown' };

  const inserted = await client.query(
    `INSERT INTO incidents
      (service_name, incident_type, root_cause, affected_services, anomaly_score, failure_probability, risk_level,
       evidence, recommended_action, action_status, recovery_status, detected_by, contributing_features,
       classification_confidence, propagation_path, latest_metrics, anomaly_detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'not_started', 'pending', $10, $11, $12, $13, $14, NOW())
     RETURNING *`,
    [service, incidentType, rootCause.rootCause || service, rootCause.affectedServices || [service],
      numberOrNull(detection.anomalyScore), numberOrNull(prediction.failureProbability), prediction.riskLevel || 'LOW',
      JSON.stringify(evidence), 'manual_review', detectedBy, contributingFeatures, confidence, propagationPath, JSON.stringify(metrics)]
  );
  return { created: true, updated: false, incident: inserted.rows[0] };
}

async function detectForSample(sample) {
  if (!sample?.service_name || inFlightServices.has(sample.service_name)) return { skipped: true };
  inFlightServices.add(sample.service_name);
  try {
    const metrics = await buildRealMetrics(sample);
    const detection = await detectAnomaly(sample.service_name, metrics);
    if (!detection.anomaly) return { anomaly: false, metrics, detection };

    const [prediction, classification, rootCause] = await Promise.all([
      predictFailure(sample.service_name, metrics),
      classifyIncident(sample.service_name, metrics),
      analyzeRootCause(sample.service_name, metrics)
    ]);
    const persistence = await persistIncident(sample.service_name, metrics, detection, prediction, classification, rootCause);
    return { anomaly: true, metrics, detection, prediction, classification, rootCause, ...persistence };
  } finally {
    inFlightServices.delete(sample.service_name);
  }
}

async function detectAllCurrentIncidents() {
  const result = await client.query(
    `SELECT DISTINCT ON (service_name) * FROM monitoring_samples ORDER BY service_name, collected_at DESC`
  );
  const detections = [];
  for (const sample of result.rows) detections.push(await detectForSample(sample));
  return detections;
}

module.exports = {
  ACTIVE_RECOVERY_STATUSES,
  buildRealMetrics,
  detectForSample,
  detectAllCurrentIncidents,
  persistIncident
};
