const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');

const { initDatabase, client } = require('./db/init');
const { startMetricsCollector, getServiceStatus, getCollectorHealth, SERVICES } = require('./jobs/metricsCollector');
const { detectForSample, detectAllCurrentIncidents } = require('./services/incidentDetector');
const { detectRootCause } = require('./graph/dependencyGraph');
const { getRecoveryConfig, updateRecoveryConfig } = require('./services/recoveryService');
const { runRecovery } = require('./services/recoveryOrchestrator');
const { buildIncidentSummary, buildTemplateSummary } = require('./services/genAiService');

dotenv.config();

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

async function insertIncidentRecord(data) {
  const result = await client.query(
    `INSERT INTO incidents (service_name, incident_type, root_cause, affected_services, anomaly_score, failure_probability, risk_level, evidence, recommended_action, action_status, recovery_status, genai_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      data.service,
      data.incidentType,
      data.rootCause,
      data.affectedServices || [data.service],
      Number(data.anomalyScore || 0),
      Number(data.failureProbability || 0),
      data.riskLevel || 'MEDIUM',
      JSON.stringify(data.evidence || {}),
      data.recommendedAction || 'scale_service',
      data.actionStatus || 'planned',
      data.recoveryStatus || 'pending',
      data.genaiSummary || null
    ]
  );

  return result.rows[0];
}

async function buildIncidentFromMetrics(serviceName, payload) {
  const rootCauseInfo = detectRootCause(serviceName, payload);

  return {
    service: serviceName,
    incidentType: payload.failureMode || 'traffic_spike',
    rootCause: rootCauseInfo.rootCause,
    affectedServices: rootCauseInfo.affectedServices,
    anomalyScore: 0.91,
    failureProbability: 0.86,
    riskLevel: 'HIGH',
    evidence: {
      ...payload,
      rootCauseEvidence: rootCauseInfo.evidence,
      dependencyPath: rootCauseInfo.propagationPath
    },
    recommendedAction: 'manual_review',
    actionStatus: 'planned',
    recoveryStatus: 'pending'
  };
}

async function createOrUpdateIncident(incidentData) {
  const existing = await client.query(
    `SELECT * FROM incidents WHERE service_name = $1 ORDER BY id DESC LIMIT 1`,
    [incidentData.service]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    const updated = await client.query(
      `UPDATE incidents SET incident_type = $1, root_cause = $2, affected_services = $3, anomaly_score = $4, failure_probability = $5, risk_level = $6, evidence = $7, recommended_action = $8, action_status = $9, recovery_status = $10, genai_summary = NULL, updated_at = NOW()
       WHERE id = $11 RETURNING *`,
      [
        incidentData.incidentType,
        incidentData.rootCause,
        incidentData.affectedServices || [incidentData.service],
        Number(incidentData.anomalyScore || 0),
        Number(incidentData.failureProbability || 0),
        incidentData.riskLevel || 'MEDIUM',
        JSON.stringify(incidentData.evidence || {}),
        incidentData.recommendedAction || 'scale_service',
        incidentData.actionStatus || 'planned',
        incidentData.recoveryStatus || 'pending',
        row.id
      ]
    );
    return updated.rows[0];
  }

  return insertIncidentRecord(incidentData);
}

app.post('/api/metrics', async (req, res) => {
  try {
    const metrics = req.body;
    await insertMetricRecord(metrics);
    res.json({ success: true, message: 'Metric stored successfully.' });
  } catch (error) {
    console.error('Metric ingestion failed:', error.message);
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

app.get('/api/monitoring/health', async (req, res) => {
  try {
    await client.query('SELECT 1');
    await getServiceStatus();
    res.json({ status: 'healthy', ...getCollectorHealth(), timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'unavailable', ...getCollectorHealth(), error: 'Monitoring dependencies unavailable', timestamp: new Date().toISOString() });
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
    `SELECT * FROM incidents WHERE recovery_status IN ('pending', 'open', 'in_progress', 'partially_recovered') ORDER BY created_at DESC`
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
      ? await client.query('SELECT * FROM recovery_actions WHERE incident_id = $1 ORDER BY created_at DESC', [Number(incidentId)])
      : await client.query('SELECT * FROM recovery_actions ORDER BY created_at DESC LIMIT 100');
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
    console.error('Manual incident detection failed:', error.message);
    res.status(503).json({ error: 'Incident detection unavailable' });
  }
});

app.get('/api/incidents/:id', async (req, res) => {
  const result = await client.query(`SELECT * FROM incidents WHERE id = $1`, [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Incident not found' });
  res.json(result.rows[0]);
});

app.get('/api/incidents/:id/summary', async (req, res) => {
  const incidentResult = await client.query(`SELECT * FROM incidents WHERE id = $1`, [req.params.id]);
  if (!incidentResult.rows[0]) return res.status(404).json({ error: 'Incident not found' });

  const incident = incidentResult.rows[0];
  const verified = ['recovered', 'partially_recovered', 'not_recovered'].includes(incident.recovery_status);
  const summary = incident.genai_summary || (verified
    ? await buildIncidentSummary(incident)
    : buildTemplateSummary({ service: incident.service_name, incidentType: incident.incident_type, rootCause: incident.root_cause, recoveryResult: { status: incident.recovery_status || 'pending' } }));
  res.json({ id: req.params.id, summary });
});

app.post('/api/incidents/:id/recover', async (req, res) => {
  try {
    const result = await runRecovery(req.params.id, 'manual');
    if (result.status === 'not_found') return res.status(404).json(result);
    if (result.status === 'in_progress') return res.status(409).json(result);
    if (result.status === 'no_safe_action') return res.status(422).json(result);
    if (result.status === 'max_replicas_reached') return res.status(409).json(result);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('Recovery failed:', error.message);
    res.status(500).json({ error: 'Recovery failed', details: error.message });
  }
});

app.get('/api/dependency-graph', (req, res) => {
  res.json({
    nodes: ['user-service', 'order-service', 'payment-service', 'database'],
    edges: [
      { source: 'user-service', target: 'order-service' },
      { source: 'order-service', target: 'payment-service' },
      { source: 'payment-service', target: 'database' }
    ]
  });
});

async function simulateService(service, route) {
  const baseUrl = service === 'payment-service' ? 'http://payment-service:8002' : service === 'order-service' ? 'http://order-service:8001' : 'http://user-service:8003';
  const response = await axios.post(`${baseUrl}${route}`, {}, { timeout: 10000 });
  return response.data;
}

async function startTrafficLoad() {
  try {
    const response = await axios.post(`${LOAD_GENERATOR_URL}/start`, {
      targetService: 'payment-service',
      requestsPerSecond: 50,
      durationSeconds: 60,
      scenario: 'traffic-spike'
    }, { timeout: 10000 });
    return response.data;
  } catch (error) {
    if (error.response?.status === 409) return error.response.data;
    throw error;
  }
}

async function maybeRunAutomaticRecovery(incident) {
  if (!incident?.id || !getRecoveryConfig().autoRecoveryEnabled) return null;
  return runRecovery(incident.id, 'automatic');
}

app.post('/api/simulate/traffic-spike', async (req, res) => {
  try {
    const [results, load] = await Promise.all([
      Promise.all([
      simulateService('payment-service', '/simulate/traffic-spike'),
      simulateService('order-service', '/simulate/traffic-spike'),
      simulateService('user-service', '/simulate/traffic-spike')
      ]),
      startTrafficLoad()
    ]);

    const paymentMetrics = results[0].metrics;
    const incident = await buildIncidentFromMetrics('payment-service', paymentMetrics);
    const saved = await createOrUpdateIncident(incident);
    const recovery = await maybeRunAutomaticRecovery(saved);

    res.json({ success: true, results, load, incident: saved, recovery });
  } catch (error) {
    console.error('Traffic spike simulation failed:', error);
    res.status(500).json({ error: 'Traffic spike simulation failed' });
  }
});

app.post('/api/simulate/database-overload', async (req, res) => {
  try {
    const results = await Promise.all([
      simulateService('payment-service', '/simulate/database-overload'),
      simulateService('order-service', '/simulate/database-overload'),
      simulateService('user-service', '/simulate/database-overload')
    ]);
    const incident = await buildIncidentFromMetrics('payment-service', results[0].metrics);
    const saved = await createOrUpdateIncident(incident);
    const recovery = await maybeRunAutomaticRecovery(saved);
    res.json({ success: true, results, incident: saved, recovery });
  } catch (error) {
    res.status(500).json({ error: 'Database overload simulation failed' });
  }
});

app.post('/api/simulate/memory-leak', async (req, res) => {
  try {
    const payment = await simulateService('payment-service', '/simulate/memory-leak');
    const incident = await buildIncidentFromMetrics('payment-service', payment.metrics);
    incident.incidentType = 'memory_leak';
    const saved = await createOrUpdateIncident(incident);
    const recovery = await maybeRunAutomaticRecovery(saved);
    res.json({ success: true, incident: saved, payment, recovery });
  } catch (error) {
    res.status(500).json({ error: 'Memory leak simulation failed' });
  }
});

app.post('/api/simulate/cpu-overload', async (req, res) => {
  try {
    const payment = await simulateService('payment-service', '/simulate/cpu-overload');
    const incident = await buildIncidentFromMetrics('payment-service', payment.metrics);
    incident.incidentType = 'cpu_overload';
    const saved = await createOrUpdateIncident(incident);
    const recovery = await maybeRunAutomaticRecovery(saved);
    res.json({ success: true, incident: saved, payment, recovery });
  } catch (error) {
    res.status(500).json({ error: 'CPU overload simulation failed' });
  }
});

app.post('/api/simulate/stop', async (req, res) => {
  try {
    const results = await Promise.all([
      simulateService('payment-service', '/simulate/stop'),
      simulateService('order-service', '/simulate/stop'),
      simulateService('user-service', '/simulate/stop')
    ]);
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ error: 'Stop simulation failed' });
  }
});

async function bootstrap() {
  await initDatabase();
  startMetricsCollector(async (sample) => {
    const detection = await detectForSample(sample);
    if (getRecoveryConfig().autoRecoveryEnabled && detection.anomaly && detection.incident?.id) {
      const recovery = await runRecovery(detection.incident.id, 'automatic');
      if (recovery.status === 'failed') console.error(`Automatic recovery failed for incident ${detection.incident.id}: ${recovery.message}`);
    }
  });

  app.listen(port, () => {
    console.log(`Monitoring Backend running on port ${port}`);
  });
}

bootstrap();
