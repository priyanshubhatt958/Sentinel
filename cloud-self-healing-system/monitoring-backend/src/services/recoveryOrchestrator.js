const { client } = require('../config/db');
const { collectServiceMetrics } = require('../jobs/metricsCollector');
const { buildIncidentSummary, buildTemplateSummary } = require('./genAiService');
const {
  decideRecoveryAction,
  executeRecoveryAction,
  getCurrentReplicas,
  getRecoveryConfig,
  ALLOWED_TARGETS
} = require('./recoveryService');
const { verifyRecovery } = require('./recoveryVerifier');

const INCIDENT_COOLDOWN_MS = 2 * 60 * 1000;
const inFlightIncidents = new Set();
let automaticRecoveryInFlight = false;

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return value;
}

function numericMean(values) {
  const valid = values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(Number)
    .filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function shouldLimitAutomaticRecovery(actionsInLastHour, maxActionsPerHour) {
  return actionsInLastHour >= maxActionsPerHour;
}

function aggregateSamples(samples) {
  if (!samples?.length) return null;
  const first = samples[0];
  const load = first.loadMetrics || null;
  const probeOk = samples.every((sample) => sample.probe?.ok === true);
  const probeLatencyMs = numericMean(samples.map((sample) => sample.probe?.latencyMs));
  const loadTargetsService = load && (load.targetService === first.serviceName || load.targetService === 'all');

  return {
    service: first.serviceName,
    cpuUsage: numericMean(samples.map((sample) => sample.cpuPercent)),
    memoryUsage: numericMean(samples.map((sample) => sample.memoryPercent)),
    requestRate: loadTargetsService ? Number(load.currentRequestsPerSecond || 0) : null,
    latencyMs: loadTargetsService ? Number(load.averageLatencyMs || 0) : probeLatencyMs,
    errorRate: loadTargetsService ? Number(load.errorRate || 0) : null,
    probeLatencyMs,
    probeFailures: samples.filter((sample) => sample.probe?.ok === false).length,
    restartCount: Math.max(...samples.map((sample) => Number(sample.restartCount || 0))),
    containerState: samples.every((sample) => sample.lifecycleState === 'running') ? 'running' : samples[0].lifecycleState,
    memoryUsedBytes: numericMean(samples.map((sample) => sample.memoryUsedBytes)),
    memoryLimitBytes: numericMean(samples.map((sample) => sample.memoryLimitBytes)),
    loadMetrics: load
  };
}

async function getIncident(incidentId) {
  const result = await client.query('SELECT * FROM incidents WHERE id = $1', [incidentId]);
  return result.rows[0] || null;
}

async function latestSampleMetrics(serviceName) {
  const result = await client.query(
    `SELECT * FROM monitoring_samples WHERE service_name = $1 ORDER BY collected_at DESC LIMIT 5`,
    [serviceName]
  );
  const rows = result.rows;
  if (!rows.length) return null;
  const load = rows.find((row) => row.load_total_requests !== null);
  return {
    service: serviceName,
    cpuUsage: numericMean(rows.map((row) => row.cpu_percent)),
    memoryUsage: numericMean(rows.map((row) => row.memory_percent)),
    requestRate: load ? Number(load.load_current_requests_per_second) : null,
    latencyMs: load ? Number(load.load_average_latency_ms) : numericMean(rows.map((row) => row.probe_latency_ms)),
    errorRate: load ? Number(load.load_error_rate) : null,
    probeLatencyMs: numericMean(rows.map((row) => row.probe_latency_ms)),
    probeFailures: rows.filter((row) => row.probe_ok === false).length,
    restartCount: Math.max(...rows.map((row) => Number(row.restart_count || 0))),
    containerState: rows.every((row) => row.lifecycle_state === 'running') ? 'running' : rows[0].lifecycle_state,
    memoryUsedBytes: numericMean(rows.map((row) => row.memory_used_bytes)),
    memoryLimitBytes: numericMean(rows.map((row) => row.memory_limit_bytes))
  };
}

async function recordRecoveryAction({ incident, action, triggeredBy, status, recoveryStatus = 'pending', message, beforeMetrics, cooldownUntil }) {
  const target = ALLOWED_TARGETS.has(action.target) ? action.target : 'not_applicable';
  const result = await client.query(
    `INSERT INTO recovery_actions
      (incident_id, action_type, target_service, previous_replicas, new_replicas, status, message,
       before_metrics, recovery_status, triggered_by, cooldown_until, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW()) RETURNING *`,
    [incident.id, action.action || status, target,
      action.fromReplicas ?? null, action.toReplicas ?? null, status, message,
      beforeMetrics ? JSON.stringify(beforeMetrics) : null, recoveryStatus, triggeredBy, cooldownUntil || null]
  );
  return result.rows[0];
}

async function updateNoExecution(incident, action, status, triggeredBy, message) {
  const cooldownUntil = triggeredBy === 'automatic' ? new Date(Date.now() + INCIDENT_COOLDOWN_MS) : null;
  const record = await recordRecoveryAction({ incident, action, triggeredBy, status, message, cooldownUntil });
  await client.query(
    `UPDATE incidents SET action_status = $1, recovery_status = 'pending', updated_at = NOW() WHERE id = $2`,
    [status, incident.id]
  );
  return { success: false, status, message, actionRecord: record };
}

async function isAutomaticCooldownActive(incidentId) {
  const result = await client.query(
    `SELECT id FROM recovery_actions WHERE incident_id = $1 AND triggered_by = 'automatic'
      AND cooldown_until > NOW() ORDER BY created_at DESC LIMIT 1`,
    [incidentId]
  );
  return result.rows.length > 0;
}

async function automaticActionsInLastHour() {
  const result = await client.query(
    `SELECT COUNT(*)::INTEGER AS count FROM recovery_actions
      WHERE triggered_by = 'automatic' AND created_at >= NOW() - INTERVAL '1 hour'
        AND status NOT IN ('no_safe_action', 'max_replicas_reached', 'rate_limited')`,
    []
  );
  return Number(result.rows[0]?.count || 0);
}

function updateIncidentResult(incident, actionStatus, recoveryStatus, beforeMetrics, afterMetrics, triggeredBy, effectivenessScore) {
  const evidence = parseJson(incident.evidence);
  return {
    ...evidence,
    recovery: {
      actionStatus,
      recoveryStatus,
      triggeredBy,
      beforeMetrics,
      afterMetrics,
      effectivenessScore
    }
  };
}

async function runRecovery(incidentId, triggeredBy = 'manual') {
  if (!['manual', 'automatic'].includes(triggeredBy)) throw new Error('triggeredBy must be manual or automatic');
  if (triggeredBy === 'automatic' && automaticRecoveryInFlight) {
    return { success: false, status: 'in_progress', message: 'Another automatic recovery action is already running.' };
  }
  if (inFlightIncidents.has(Number(incidentId))) {
    return { success: false, status: 'in_progress', message: 'A recovery action is already running for this incident.' };
  }

  if (triggeredBy === 'automatic') automaticRecoveryInFlight = true;
  inFlightIncidents.add(Number(incidentId));
  let actionRecord = null;
  let incident = null;
  try {
    incident = await getIncident(incidentId);
    if (!incident) return { success: false, status: 'not_found', message: 'Incident not found.' };

    const config = getRecoveryConfig();
    if (triggeredBy === 'automatic' && !config.autoRecoveryEnabled) {
      return { success: false, status: 'disabled', message: 'Automatic recovery is disabled.' };
    }
    if (triggeredBy === 'automatic' && await isAutomaticCooldownActive(incident.id)) {
      return { success: false, status: 'cooldown', message: 'This incident is within the automatic recovery cooldown.' };
    }
    if (triggeredBy === 'automatic' && shouldLimitAutomaticRecovery(await automaticActionsInLastHour(), config.maxActionsPerHour)) {
      return updateNoExecution(incident, { target: incident.service_name }, 'rate_limited', triggeredBy,
        `Automatic recovery limit of ${config.maxActionsPerHour} actions per hour has been reached.`);
    }

    const configForDecision = { ...config, maxServiceReplicas: Math.min(config.maxServiceReplicas, 5) };
    const replicas = ['traffic_spike', 'cpu_overload'].includes(incident.incident_type)
      ? await getCurrentReplicas('payment-service')
      : null;
    const action = decideRecoveryAction(incident, replicas, configForDecision);
    if (!action.action) {
      return updateNoExecution(incident, action, action.status || 'no_safe_action', triggeredBy, action.reason);
    }
    if (action.status === 'max_replicas_reached') {
      return updateNoExecution(incident, action, 'max_replicas_reached', triggeredBy, action.reason);
    }

    const evidence = parseJson(incident.evidence);
    const baseline = parseJson(incident.latest_metrics);
    const beforeMetrics = Object.keys(baseline).length ? baseline : await latestSampleMetrics(action.target);
    const cooldownUntil = triggeredBy === 'automatic'
      ? new Date(Date.now() + Math.max(INCIDENT_COOLDOWN_MS, config.verificationDelayMs))
      : null;

    actionRecord = await recordRecoveryAction({
      incident,
      action,
      triggeredBy,
      status: 'executing',
      recoveryStatus: 'in_progress',
      message: action.reason,
      beforeMetrics,
      cooldownUntil
    });
    await client.query(
      `UPDATE incidents SET action_status = 'executing', recovery_status = 'in_progress', updated_at = NOW() WHERE id = $1`,
      [incident.id]
    );

    let execution;
    try {
      execution = await executeRecoveryAction(action, configForDecision);
    } catch (error) {
      await client.query(
        `UPDATE recovery_actions SET status = 'failed', message = $1, recovery_status = 'pending', updated_at = NOW() WHERE id = $2`,
        [error.message, actionRecord.id]
      );
      await client.query(
        `UPDATE incidents SET action_status = 'failed', recovery_status = 'pending', updated_at = NOW() WHERE id = $1`,
        [incident.id]
      );
      return { success: false, status: 'failed', message: error.message, actionRecordId: actionRecord.id };
    }

    if (execution.status !== 'executed') {
      return updateExecutionRejected(incident, actionRecord, execution, triggeredBy);
    }

    await client.query(
      `UPDATE recovery_actions SET message = $1, updated_at = NOW() WHERE id = $2`,
      [execution.message, actionRecord.id]
    );
    await new Promise((resolve) => setTimeout(resolve, config.verificationDelayMs));

    let afterMetrics = null;
    try {
      afterMetrics = aggregateSamples(await collectServiceMetrics(action.target));
    } catch (error) {
      console.warn(`Fresh recovery metrics unavailable for ${action.target}: ${error.message}`);
    }
    const verification = verifyRecovery(beforeMetrics, afterMetrics);
    const actionStatus = verification.status === 'pending' ? 'verification_pending' : verification.status;
    const evidenceWithRecovery = updateIncidentResult(
      incident, 'executed', verification.status, verification.beforeMetrics, verification.afterMetrics,
      triggeredBy, verification.effectivenessScore
    );

    await client.query(
      `UPDATE recovery_actions SET status = $1, recovery_status = $2, before_metrics = $3, after_metrics = $4,
       effectiveness_score = $5, message = $6, updated_at = NOW() WHERE id = $7`,
      [actionStatus, verification.status, JSON.stringify(verification.beforeMetrics),
        JSON.stringify(verification.afterMetrics), verification.effectivenessScore,
        execution.message, actionRecord.id]
    );
    const updatedResult = await client.query(
      `UPDATE incidents SET action_status = 'executed', recovery_status = $1, evidence = $2,
       updated_at = NOW() WHERE id = $3 RETURNING *`,
      [verification.status, JSON.stringify(evidenceWithRecovery), incident.id]
    );
    const updatedIncident = updatedResult.rows[0];

    const summaryInput = {
      ...updatedIncident,
      service: incident.service_name,
      incidentType: incident.incident_type,
      rootCause: incident.root_cause,
      recoveryAction: action,
      recoveryResult: {
        status: verification.status,
        latencyBeforeMs: verification.beforeMetrics?.latencyMs,
        latencyAfterMs: verification.afterMetrics?.latencyMs,
        errorRateBefore: verification.beforeMetrics?.errorRate,
        errorRateAfter: verification.afterMetrics?.errorRate
      }
    };
    const summary = verification.status === 'pending'
      ? buildTemplateSummary(summaryInput)
      : await buildIncidentSummary(summaryInput);
    await client.query(`UPDATE incidents SET genai_summary = $1, updated_at = NOW() WHERE id = $2`, [summary, incident.id]);

    return {
      success: true,
      action: execution,
      selectedAction: action,
      triggeredBy,
      recoveryStatus: verification.status,
      effectivenessScore: verification.effectivenessScore,
      beforeMetrics: verification.beforeMetrics,
      afterMetrics: verification.afterMetrics,
      summary,
      actionRecordId: actionRecord.id,
      incident: updatedIncident
    };
  } finally {
    inFlightIncidents.delete(Number(incidentId));
    if (triggeredBy === 'automatic') automaticRecoveryInFlight = false;
  }
}

async function updateExecutionRejected(incident, actionRecord, execution, triggeredBy) {
  const status = execution.status === 'max_replicas_reached' ? 'max_replicas_reached' : 'failed';
  await client.query(
    `UPDATE recovery_actions SET status = $1, message = $2, recovery_status = 'pending', updated_at = NOW() WHERE id = $3`,
    [status, execution.message, actionRecord.id]
  );
  await client.query(
    `UPDATE incidents SET action_status = $1, recovery_status = 'pending', updated_at = NOW() WHERE id = $2`,
    [status, incident.id]
  );
  return { success: false, status, message: execution.message, triggeredBy, actionRecordId: actionRecord.id };
}

module.exports = { runRecovery, aggregateSamples, latestSampleMetrics, automaticActionsInLastHour, shouldLimitAutomaticRecovery };
