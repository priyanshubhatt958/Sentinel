const axios = require('axios');
const logger = require('../utils/logger');

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://ml-service:8000';
const MAX_ATTEMPTS = 3;
let integrationStatus = {
  available: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null
};

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined);
}

function toMlPayload(service, metrics) {
  const requestsLastMinute = firstPresent(metrics.requestsLastMinute, metrics.requests_last_minute);
  const measuredRequestRate = firstPresent(
    metrics.requestRate,
    metrics.requestsPerSecond,
    metrics.requests_per_second,
    requestsLastMinute === undefined ? undefined : Number(requestsLastMinute) / 60,
    metrics.load_current_requests_per_second
  );
  return {
    service,
    cpuUsage: firstPresent(metrics.cpuUsage, metrics.cpu_percent),
    memoryUsage: firstPresent(metrics.memoryUsage, metrics.memory_percent),
    requestRate: measuredRequestRate,
    latencyMs: firstPresent(metrics.latencyMs, metrics.averageLatencyMs, metrics.average_latency_ms, metrics.probe_latency_ms),
    errorRate: firstPresent(metrics.errorRate, metrics.serviceErrorRate, metrics.service_error_rate, metrics.load_error_rate),
    dbConnections: firstPresent(metrics.dbConnections, metrics.dbActiveConnections, metrics.db_active_connections),
    totalRequests: firstPresent(metrics.totalRequests, metrics.total_requests),
    successfulRequests: firstPresent(metrics.successfulRequests, metrics.successful_requests),
    failedRequests: firstPresent(metrics.failedRequests, metrics.failed_requests),
    activeRequests: firstPresent(metrics.activeRequests, metrics.active_requests),
    requestsLastMinute,
    requestsPerSecond: measuredRequestRate,
    averageLatencyMs: firstPresent(metrics.averageLatencyMs, metrics.average_latency_ms, metrics.latencyMs),
    p95LatencyMs: firstPresent(metrics.p95LatencyMs, metrics.p95_latency_ms),
    dbActiveConnections: firstPresent(metrics.dbActiveConnections, metrics.db_active_connections, metrics.dbConnections),
    dbWaitingRequests: firstPresent(metrics.dbWaitingRequests, metrics.db_waiting_requests),
    dbAverageQueryLatencyMs: firstPresent(metrics.dbAverageQueryLatencyMs, metrics.db_average_query_latency_ms),
    dbErrorRate: firstPresent(metrics.dbErrorRate, metrics.db_error_rate),
    probeLatencyMs: firstPresent(metrics.probeLatencyMs, metrics.probe_latency_ms),
    probeFailures: firstPresent(metrics.probeFailures, metrics.probe_failures, metrics.probe_ok === false ? 1 : 0),
    restartCount: firstPresent(metrics.restartCount, metrics.restart_count),
    containerState: firstPresent(metrics.containerState, metrics.lifecycle_state)
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestMl(path, service, metrics, payload = toMlPayload(service, metrics)) {
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    integrationStatus.lastAttemptAt = new Date().toISOString();
    try {
      const response = await axios.post(
        `${ML_SERVICE_URL}${path}`,
        payload,
        { timeout: 10000 }
      );
      integrationStatus = {
        available: true,
        lastAttemptAt: integrationStatus.lastAttemptAt,
        lastSuccessAt: new Date().toISOString(),
        lastError: null
      };
      return response.data;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < MAX_ATTEMPTS) await wait(250 * (2 ** attempt));
    }
  }

  integrationStatus = {
    available: false,
    lastAttemptAt: integrationStatus.lastAttemptAt,
    lastSuccessAt: integrationStatus.lastSuccessAt,
    lastError: lastError?.message || 'ML service request failed'
  };
  const unavailable = new Error(`ML service unavailable after ${MAX_ATTEMPTS} attempts: ${integrationStatus.lastError}`);
  unavailable.code = 'ML_SERVICE_UNAVAILABLE';
  unavailable.cause = lastError;
  logger.error('ml_service_unavailable', { message: unavailable.message });
  throw unavailable;
}

function detectAnomaly(service, metrics) {
  return requestMl('/ml/detect', service, metrics);
}

function predictFailure(service, metrics) {
  return requestMl('/ml/predict', service, metrics);
}

function classifyIncident(service, metrics) {
  return requestMl('/ml/classify', service, metrics);
}

function analyzeRootCause(service, metrics) {
  return requestMl('/ml/root-cause', service, metrics);
}

function summarizeIncident(incidentRecord) {
  return requestMl(
    '/ml/summarize',
    incidentRecord.service || incidentRecord.service_name,
    incidentRecord,
    incidentRecord
  );
}

function getMlIntegrationStatus() {
  return { ...integrationStatus };
}

module.exports = {
  detectAnomaly,
  predictFailure,
  classifyIncident,
  analyzeRootCause,
  summarizeIncident,
  toMlPayload,
  getMlIntegrationStatus
};
