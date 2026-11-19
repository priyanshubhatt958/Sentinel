const axios = require('axios');

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://ml-service:8000';

function toMlPayload(service, metrics) {
  return {
    service,
    cpuUsage: metrics.cpuUsage ?? metrics.cpu_percent ?? null,
    memoryUsage: metrics.memoryUsage ?? metrics.memory_percent ?? null,
    requestRate: metrics.requestRate ?? metrics.load_current_requests_per_second ?? null,
    latencyMs: metrics.latencyMs ?? metrics.probe_latency_ms ?? null,
    errorRate: metrics.errorRate ?? metrics.load_error_rate ?? null,
    dbConnections: metrics.dbConnections ?? null,
    probeLatencyMs: metrics.probeLatencyMs ?? metrics.probe_latency_ms ?? null,
    probeFailures: metrics.probeFailures ?? (metrics.probe_ok === false ? 1 : 0),
    restartCount: metrics.restartCount ?? metrics.restart_count ?? null,
    containerState: metrics.containerState ?? metrics.lifecycle_state ?? null
  };
}

async function detectAnomaly(service, metrics) {
  try {
    const response = await axios.post(`${ML_SERVICE_URL}/ml/detect`, toMlPayload(service, metrics), { timeout: 15000 });
    return response.data;
  } catch (error) {
    return {
      service,
      anomaly: false,
      anomalyScore: 0.0,
      detectedBy: [],
      contributingFeatures: []
    };
  }
}

async function predictFailure(service, metrics) {
  try {
    const response = await axios.post(`${ML_SERVICE_URL}/ml/predict`, toMlPayload(service, metrics), { timeout: 15000 });
    return response.data;
  } catch (error) {
    return {
      service,
      failureProbability: 0.1,
      riskLevel: 'LOW',
      estimatedFailureWindow: 'Unknown',
      reason: 'Prediction unavailable; using safe default.'
    };
  }
}

async function classifyIncident(service, metrics) {
  try {
    const response = await axios.post(`${ML_SERVICE_URL}/ml/classify`, toMlPayload(service, metrics), { timeout: 15000 });
    return response.data;
  } catch (error) {
    return { service, incidentType: 'unknown' };
  }
}

async function analyzeRootCause(service, metrics) {
  try {
    const response = await axios.post(`${ML_SERVICE_URL}/ml/root-cause`, toMlPayload(service, metrics), { timeout: 15000 });
    return response.data;
  } catch (error) {
    return {
      rootCause: service,
      rootCauseType: 'unknown',
      affectedServices: [service],
      propagationPath: [service],
      evidence: ['Root cause analysis unavailable']
    };
  }
}

async function summarizeIncident(incidentRecord) {
  try {
    const response = await axios.post(`${ML_SERVICE_URL}/ml/summarize`, incidentRecord, { timeout: 15000 });
    return response.data.summary || response.data;
  } catch (error) {
    return 'The system detected an anomaly and initiated recovery checks.';
  }
}

module.exports = {
  detectAnomaly,
  predictFailure,
  classifyIncident,
  analyzeRootCause,
  summarizeIncident,
  toMlPayload
};
