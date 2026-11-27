const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const { initDatabase, client } = require('./db/init');
const { startMetricsCollector, getServiceStatus, getCollectorHealth, SERVICES } = require('./jobs/metricsCollector');
const { detectForSample, detectAllCurrentIncidents } = require('./services/incidentDetector');
const { getRecoveryConfig, updateRecoveryConfig, recommendRecovery } = require('./services/recoveryService');
const { runRecovery, startRecoveryReconciliation } = require('./services/recoveryOrchestrator');
const {
  buildIncidentSummaryResult,
  buildTemplateReport,
  formatReport
} = require('./services/genAiService');
const { getMlIntegrationStatus } = require('./services/mlService');
const logger = require('./utils/logger');

const app = express();
const port = Number(process.env.PORT || 5000);
const LOAD_GENERATOR_URL = process.env.LOAD_GENERATOR_URL || 'http://load-generator:8004';
app.use(cors());
app.use(express.json());

const serviceNames = new Set(SERVICES.map((service) => service.name));

function validateServiceName(value) {
  if (!value || !serviceNames.has(value)) {
    const error = new Error(`Unknown service. Expected one of: ${SERVICES.map((service) => service.name).join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function parseRange(value) {
  const match = String(value || '1h').match(/^(\d+)(m|h|d)$/i);
  if (!match) {
    const error = new Error('range must use a format such as 5m, 1h, or 7d');
    error.statusCode = 400;
    throw error;
  }
  const amount = Number(match[1]);
  const multiplier = { m: 60, h: 3600, d: 86400 }[match[2].toLowerCase()];
  return Math.min(amount * multiplier, 7 * 86400);
}

async function queryMonitoringHistory(service, seconds) {
  const result = await client.query(
    `SELECT * FROM monitoring_samples WHERE service_name = $1 AND collected_at >= NOW() - ($2 * INTERVAL '1 second') ORDER BY collected_at ASC`,
    [service, seconds]
  );
  return result.rows;
}

async function queryCurrentMonitoring(service) {
  const currentWindowSeconds = Math.max(30, Number(process.env.MONITORING_INTERVAL_MS || 5000) * 3 / 1000);
  const result = await client.query(
    `SELECT DISTINCT ON (service_name, container_id) * FROM monitoring_samples
     WHERE service_name = $1 AND collected_at >= NOW() - ($2 * INTERVAL '1 second')
     ORDER BY service_name, container_id, collected_at DESC`,
    [service, currentWindowSeconds]
  );
  return result.rows;
}

async function queryRecoveryTimeline(incidentId) {
  return client.query(
    `SELECT ra.id, ra.incident_id AS "incidentId", ra.created_at AS timestamp,
       ra.created_at AS "createdAt", ra.updated_at AS "updatedAt",
       ra.action_type AS action, ra.action_type AS "actionType",
       ra.target_service AS "targetService", ra.status, ra.recovery_status AS "recoveryStatus",
       COALESCE(ra.decision_reason, ra.message) AS reason, incident.root_cause AS "rootCause",
       ra.before_metrics AS "beforeMetrics", ra.after_metrics AS "afterMetrics",
       ra.effectiveness_score AS "effectivenessScore", ra.effectiveness_by_metric AS "effectivenessByMetric",
       ra.verification_samples AS "verificationSamples", ra.samples_used AS "samplesUsed",
       ra.verification_window_ms AS "verificationWindowMs",
       ra.safety_check AS "safetyCheck", ra.replica_limit AS "replicaLimit",
       ra.execution_details AS "executionDetails", ra.execution_started_at AS "executionStartedAt",
       ra.execution_completed_at AS "executionCompletedAt",
       ra.verification_started_at AS "verificationStartedAt",
       ra.verification_completed_at AS "verificationCompletedAt",
       ra.cooldown_started_at AS "cooldownStartedAt", ra.cooldown_until AS "cooldownUntil",
       ra.error_details AS "errorDetails", ra.triggered_by AS "triggeredBy",
       ra.decision_confidence AS "decisionConfidence", ra.recommendation
     FROM recovery_actions ra
     JOIN incidents incident ON incident.id = ra.incident_id
     WHERE ra.incident_id = $1 ORDER BY ra.created_at ASC`,
    [incidentId]
  );
}

async function insertMetricRecord(payload) {
  const serviceName = payload.service || 'unknown';
  await client.query(
    `INSERT INTO metrics (service_name, cpu_usage, memory_usage, request_rate, latency_ms, error_rate, db_connections, status, failure_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      serviceName,
      Number(payload.cpuUsage || 0),
      Number(payload.memoryUsage || 0),
      Number(payload.requestRate || 0),
      Number(payload.latencyMs || 0),
      Number(payload.errorRate || 0),
      Number(payload.dbConnections || 0),
      payload.status || 'healthy',
      payload.failureMode || 'normal'
    ]
  );
}

app.post('/api/metrics', async (req, res) => {
  try {
    const metrics = req.body;
    await insertMetricRecord(metrics);
    res.json({ success: true, message: 'Metric stored successfully.' });
  } catch (error) {
    logger.error('metric_ingestion_failed', { message: error.message });
    res.status(500).json({ error: 'Metric ingestion failed' });
  }
});

app.get('/api/metrics/latest', async (req, res) => {
  try {
    const service = validateServiceName(req.query.service || 'payment-service');
    res.json((await queryCurrentMonitoring(service))[0] || null);
  } catch (error) {
    res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'Monitoring data unavailable' });
  }
});

app.get('/api/metrics/history', async (req, res) => {
  try {
    const service = validateServiceName(req.query.service || 'payment-service');
    const seconds = req.query.range ? parseRange(req.query.range) : Math.min(Number(req.query.minutes || 60) * 60, 7 * 86400);
    if (!Number.isFinite(seconds) || seconds <= 0) throw Object.assign(new Error('range must be positive'), { statusCode: 400 });
    res.json(await queryMonitoringHistory(service, seconds));
  } catch (error) {
    res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'Monitoring history unavailable' });
  }
});

app.get('/api/metrics/current', async (req, res) => {
  try {
    const services = req.query.service ? [validateServiceName(req.query.service)] : SERVICES.map((service) => service.name);
    const current = {};
    for (const service of services) current[service] = await queryCurrentMonitoring(service);
    res.json({ timestamp: new Date().toISOString(), services: current });
  } catch (error) {
    res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'Current monitoring data unavailable' });
  }
});

app.get(['/api/health', '/api/monitoring/health'], async (req, res) => {
  try {
    await client.query('SELECT 1');
    await getServiceStatus();
    const mlIntegration = getMlIntegrationStatus();
    res.json({
      status: mlIntegration.available === false ? 'degraded' : 'healthy',
      ...getCollectorHealth(),
      mlIntegration,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unavailable',
      ...getCollectorHealth(),
      mlIntegration: getMlIntegrationStatus(),
      error: 'Monitoring dependencies unavailable',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/load/start', async (req, res) => {
  try {
    const response = await axios.post(`${LOAD_GENERATOR_URL}/start`, req.body, { timeout: 10000 });
    res.status(response.status).json(response.data);
  } catch (error) {
    const status = error.response?.status || 503;
    res.status(status).json(error.response?.data || { error: 'Load generator unavailable' });
  }
});

app.post('/api/load/stop', async (req, res) => {
  try {
    const response = await axios.post(`${LOAD_GENERATOR_URL}/stop`, {}, { timeout: 10000 });
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(error.response?.status || 503).json(error.response?.data || { error: 'Load generator unavailable' });
  }
});

app.get('/api/load/status', async (req, res) => {
  try {
    const response = await axios.get(`${LOAD_GENERATOR_URL}/status`, { timeout: 10000 });
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 503).json(error.response?.data || { error: 'Load generator unavailable' });
  }
});

app.get('/api/services/status', async (req, res) => {
  try {
    const statuses = await getServiceStatus();
    const dbCheck = await client.query('SELECT 1');
    statuses.push({ service: 'database', state: dbCheck.rows.length ? 'running' : 'unavailable', health: dbCheck.rows.length ? 'healthy' : 'unavailable', containers: [] });
    res.json({ status: 'ok', services: statuses, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'unavailable', services: [], error: 'Docker monitoring unavailable', timestamp: new Date().toISOString() });
  }
});

app.get('/api/incidents', async (req, res) => {
  const result = await client.query(`SELECT * FROM incidents ORDER BY created_at DESC`);
  res.json(result.rows);
});

app.get('/api/incidents/active', async (req, res) => {
  const result = await client.query(
    `SELECT * FROM incidents WHERE recovery_status IN
      ('pending', 'open', 'planned', 'executing', 'executed', 'verification_pending', 'in_progress',
       'partially_recovered', 'not_recovered', 'blocked', 'skipped', 'manual_intervention_required')
     ORDER BY created_at DESC`
  );
  res.json(result.rows);
});

app.get('/api/recovery/config', (req, res) => {
  res.json(getRecoveryConfig());
});

app.post('/api/recovery/config', (req, res) => {
  try {
    res.json(updateRecoveryConfig(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/recovery/actions', async (req, res) => {
  try {
    const incidentId = req.query.incidentId;
    if (incidentId !== undefined && (!/^\d+$/.test(String(incidentId)) || Number(incidentId) < 1)) {
      return res.status(400).json({ error: 'incidentId must be a positive integer' });
    }
    const result = incidentId
      ? await client.query(
        `SELECT recovery_actions.*, incidents.root_cause, incidents.incident_type
         FROM recovery_actions JOIN incidents ON incidents.id = recovery_actions.incident_id
         WHERE recovery_actions.incident_id = $1 ORDER BY recovery_actions.created_at DESC`,
        [Number(incidentId)]
      )
      : await client.query(
        `SELECT recovery_actions.*, incidents.root_cause, incidents.incident_type
         FROM recovery_actions JOIN incidents ON incidents.id = recovery_actions.incident_id
         ORDER BY recovery_actions.created_at DESC LIMIT 100`
      );
    res.json(result.rows);
  } catch (error) {
    res.status(503).json({ error: 'Recovery action history unavailable' });
  }
});

app.post('/api/incidents/detect', async (req, res) => {
  try {
    const results = await detectAllCurrentIncidents();
    const recoveries = [];
    if (getRecoveryConfig().autoRecoveryEnabled) {
      for (const result of results) {
        if (result.anomaly && result.incident?.id) {
          recoveries.push(await runRecovery(result.incident.id, 'automatic'));
        }
      }
    }
    res.json({ success: true, results, recoveries });
  } catch (error) {
    logger.error('manual_incident_detection_failed', { message: error.message });
    res.status(503).json({ error: 'Incident detection unavailable' });
  }
});

app.get('/api/incidents/:id', async (req, res) => {
  const result = await client.query(`SELECT * FROM incidents WHERE id = $1`, [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Incident not found' });
  const incident = result.rows[0];
  const history = await client.query(
    `SELECT COUNT(*)::INTEGER AS failures FROM recovery_actions
      WHERE incident_id = $1 AND status IN ('failed', 'not_recovered')`,
    [incident.id]
  );
  const recommendation = recommendRecovery(incident, Number(history.rows[0]?.failures || 0));
  res.json({ ...incident, recoveryRecommendation: recommendation });
});

app.get('/api/incidents/:id/recovery-timeline', async (req, res) => {
  try {
    const incidentResult = await client.query('SELECT id FROM incidents WHERE id = $1', [req.params.id]);
    if (!incidentResult.rows[0]) return res.status(404).json({ error: 'Incident not found' });
    const result = await queryRecoveryTimeline(incidentResult.rows[0].id);
    res.json(result.rows);
  } catch (error) {
    logger.error('recovery_timeline_unavailable', { incidentId: req.params.id, message: error.message });
    res.status(503).json({ error: 'Recovery timeline unavailable' });
  }
});

app.get('/api/incidents/:id/summary', async (req, res) => {
  try {
    const incidentResult = await client.query('SELECT * FROM incidents WHERE id = $1', [req.params.id]);
    if (!incidentResult.rows[0]) return res.status(404).json({ error: 'Incident not found' });

    const incident = incidentResult.rows[0];
    const recoveryHistory = await queryRecoveryTimeline(incident.id);
    const timeline = recoveryHistory.rows;
    const recovery = timeline[timeline.length - 1] || null;
    let summary = incident.genai_summary;
    let source = incident.genai_summary_source || (summary ? 'unknown' : null);
    let report = incident.genai_report;

    if (!summary || !report) {
      const verified = ['recovered', 'partially_recovered', 'not_recovered'].includes(incident.recovery_status);
      const summaryInput = {
        id: incident.id,
        service: incident.service_name,
        incidentType: incident.incident_type,
        rootCause: incident.root_cause,
        anomalyScore: incident.anomaly_score,
        riskLevel: incident.risk_level,
        failureProbability: incident.failure_probability,
        affectedServices: incident.affected_services,
        evidence: incident.evidence,
        metrics: incident.latest_metrics,
        timeline,
        recoveryEffectiveness: recovery?.effectivenessScore,
        recoveryAction: recovery ? { action: recovery.actionType, target: recovery.targetService } : null,
        recoveryResult: recovery
          ? {
            status: recovery.recoveryStatus,
            beforeMetrics: recovery.beforeMetrics,
            afterMetrics: recovery.afterMetrics,
            effectivenessScore: recovery.effectivenessScore,
            recommendation: recovery.recommendation
          }
          : { status: incident.recovery_status || 'pending' }
      };
      const result = verified
        ? await buildIncidentSummaryResult(summaryInput)
        : (() => {
          const fallbackReport = buildTemplateReport(summaryInput);
          return {
            summary: formatReport(fallbackReport),
            source: 'fallback',
            report: fallbackReport
          };
        })();
      summary = result.summary;
      source = result.source;
      report = result.report;
      await client.query(
        'UPDATE incidents SET genai_summary = $1, genai_summary_source = $2, genai_report = $3, updated_at = NOW() WHERE id = $4',
        [summary, source, report ? JSON.stringify(report) : null, incident.id]
      );
    }

    res.json({
      id: incident.id,
      summary,
      report,
      source,
      fallback: source === 'fallback',
      rootCause: incident.root_cause,
      evidence: incident.evidence,
      recoveryAction: recovery ? { action: recovery.actionType, target: recovery.targetService } : null,
      recoveryResult: recovery
        ? {
          status: recovery.recoveryStatus,
          beforeMetrics: recovery.beforeMetrics,
          afterMetrics: recovery.afterMetrics,
          effectivenessScore: recovery.effectivenessScore,
          recommendation: recovery.recommendation
        }
        : { status: incident.recovery_status || 'pending' },
      remainingRisks: report?.remainingRisks || null,
      recommendedNextSteps: report?.recommendedNextSteps || incident.recovery_recommendation || null,
      timeline,
      recoveryRecommendation: recommendRecovery(incident)
    });
  } catch (error) {
    logger.error('incident_summary_unavailable', { incidentId: req.params.id, message: error.message });
    res.status(503).json({ error: 'Incident summary unavailable' });
  }
});

app.post('/api/incidents/:id/recover', async (req, res) => {
  try {
    const result = await runRecovery(req.params.id, 'manual');
    if (result.status === 'not_found') return res.status(404).json(result);
    if (['in_progress', 'blocked'].includes(result.status)) {
      return res.status(409).json(result);
    }
    if (['skipped', 'manual_intervention_required'].includes(result.status)) return res.status(422).json(result);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    logger.error('recovery_failed', { message: error.message });
    res.status(500).json({ error: 'Recovery failed', details: error.message });
  }
});

app.get('/api/dependency-graph', (req, res) => {
  res.json({
    nodes: [
      'frontend',
      'monitoring-backend',
      'load-generator',
      'user-service',
      'order-service',
      'payment-service',
      'database',
      'ml-service'
    ],
    edges: [
      { source: 'frontend', target: 'monitoring-backend' },
      { source: 'monitoring-backend', target: 'load-generator' },
      { source: 'monitoring-backend', target: 'ml-service' },
      { source: 'monitoring-backend', target: 'database' },
      { source: 'load-generator', target: 'user-service' },
      { source: 'load-generator', target: 'order-service' },
      { source: 'load-generator', target: 'payment-service' },
      { source: 'user-service', target: 'order-service' },
      { source: 'order-service', target: 'payment-service' },
      { source: 'payment-service', target: 'database' }
    ]
  });
});

app.get('/api/simulations/status', async (req, res) => {
  const services = {
    'payment-service': 'http://payment-service:8002',
    'order-service': 'http://order-service:8001',
    'user-service': 'http://user-service:8003'
  };
  const statuses = await Promise.all(Object.entries(services).map(async ([service, baseUrl]) => {
    try {
      const response = await axios.get(`${baseUrl}/simulate/status`, { timeout: 5000 });
      return { service, available: true, ...response.data };
    } catch (error) {
      return {
        service,
        available: false,
        error: error.response?.data?.error || error.message
      };
    }
  }));
  const active = statuses.some((service) => service.simulations?.some((simulation) => simulation.active));
  res.json({ active, services: statuses, timestamp: new Date().toISOString() });
});

async function simulateService(service, route, payload = {}) {
  const baseUrl = service === 'payment-service' ? 'http://payment-service:8002' : service === 'order-service' ? 'http://order-service:8001' : 'http://user-service:8003';
  const response = await axios.post(`${baseUrl}${route}`, payload, { timeout: 10000 });
  return response.data;
}

async function startTrafficLoad() {
  try {
    const response = await axios.post(`${LOAD_GENERATOR_URL}/start`, {
      targetService: 'payment-service',
      requestsPerSecond: 120,
      durationSeconds: 60,
      scenario: 'traffic-spike'
    }, { timeout: 10000 });
    return response.data;
  } catch (error) {
    if (error.response?.status === 409) return error.response.data;
    throw error;
  }
}

app.post('/api/simulate/traffic-spike', async (req, res) => {
  try {
    const [results, load] = await Promise.all([
      Promise.all([
        simulateService('payment-service', '/simulate/traffic-spike', req.body),
        simulateService('order-service', '/simulate/traffic-spike', req.body),
        simulateService('user-service', '/simulate/traffic-spike', req.body)
      ]),
      startTrafficLoad()
    ]);
    res.json({ success: true, results, load, incidentTracking: 'metrics_collector_ml_pipeline' });
  } catch (error) {
    logger.error('traffic_spike_simulation_failed', { message: error.message });
    res.status(error.response?.status || 503).json({ error: 'Traffic spike simulation failed', details: error.message });
  }
});

app.post('/api/simulate/database-overload', async (req, res) => {
  try {
    const results = await Promise.all([
      simulateService('payment-service', '/simulate/database-overload', req.body),
      simulateService('order-service', '/simulate/database-overload', req.body),
      simulateService('user-service', '/simulate/database-overload', req.body)
    ]);
    res.json({ success: true, results, incidentTracking: 'metrics_collector_ml_pipeline' });
  } catch (error) {
    logger.error('database_overload_simulation_failed', { message: error.message });
    res.status(error.response?.status || 503).json({ error: 'Database overload simulation failed', details: error.message });
  }
});

app.post('/api/simulate/memory-leak', async (req, res) => {
  try {
    const payment = await simulateService('payment-service', '/simulate/memory-leak', req.body);
    res.json({ success: true, payment, incidentTracking: 'metrics_collector_ml_pipeline' });
  } catch (error) {
    logger.error('memory_leak_simulation_failed', { message: error.message });
    res.status(error.response?.status || 503).json({ error: 'Memory leak simulation failed', details: error.message });
  }
});

app.post('/api/simulate/cpu-overload', async (req, res) => {
  try {
    const payment = await simulateService('payment-service', '/simulate/cpu-overload', req.body);
    res.json({ success: true, payment, incidentTracking: 'metrics_collector_ml_pipeline' });
  } catch (error) {
    logger.error('cpu_overload_simulation_failed', { message: error.message });
    res.status(error.response?.status || 503).json({ error: 'CPU overload simulation failed', details: error.message });
  }
});

app.post('/api/simulate/stop', async (req, res) => {
  try {
    const results = await Promise.all([
      simulateService('payment-service', '/simulate/stop'),
      simulateService('order-service', '/simulate/stop'),
      simulateService('user-service', '/simulate/stop')
    ]);
    const load = await axios.post(`${LOAD_GENERATOR_URL}/stop`, {}, { timeout: 10000 }).then((response) => response.data);
    res.json({ success: true, results, load });
  } catch (error) {
    logger.error('simulation_stop_failed', { message: error.message });
    res.status(error.response?.status || 503).json({ error: 'Stop simulation failed', details: error.message });
  }
});

async function bootstrap() {
  await initDatabase();
  startRecoveryReconciliation();
  startMetricsCollector(async (sample) => {
    const detection = await detectForSample(sample);
    if (getRecoveryConfig().autoRecoveryEnabled && detection.anomaly && detection.incident?.id) {
      const recovery = await runRecovery(detection.incident.id, 'automatic');
      if (recovery.status === 'failed') logger.error('automatic_recovery_failed', { incidentId: detection.incident.id, message: recovery.message });
    }
  });

  app.listen(port, () => {
    logger.info('monitoring_backend_started', { port });
  });
}

bootstrap();
