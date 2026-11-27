const { client } = require('../config/db');
const { collectServiceMetrics } = require('../jobs/metricsCollector');
const {
  buildIncidentSummaryResult,
  buildTemplateReport,
  formatReport
} = require('./genAiService');
const {
  decideRecoveryAction,
  executeRecoveryAction,
  getCurrentReplicas,
  getServiceContainers,
  getRecoveryConfig,
  recommendRecovery,
  ALLOWED_TARGETS,
  RECOVERY_STATUSES
} = require('./recoveryService');
const { verifyRecovery } = require('./recoveryVerifier');
const logger = require('../utils/logger');

const inFlightIncidents = new Set();
let automaticRecoveryInFlight = false;
const NON_EXECUTED_STATUSES = [
  'blocked',
  'skipped',
  'manual_intervention_required',
  'no_safe_action',
  'max_replicas_reached',
  'requires_database_remediation',
  'rate_limited',
  'cooldown',
  'action_limit_reached'
];

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

function weightedMean(samples, valueKey, weightKey) {
  const valid = samples
    .map((sample) => ({ value: Number(sample[valueKey]), weight: Number(sample[weightKey]) }))
    .filter((item) => Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0);
  if (!valid.length) return numericMean(samples.map((sample) => sample[valueKey]));
  const totalWeight = valid.reduce((sum, item) => sum + item.weight, 0);
  return valid.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
}

function sumMetric(samples, key) {
  const values = samples
    .map((sample) => sample[key])
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(Number)
    .filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function shouldLimitAutomaticRecovery(actionsInLastHour, maxActionsPerHour) {
  return actionsInLastHour >= maxActionsPerHour;
}

function aggregateSamples(samples) {
  if (!samples?.length) return null;
  const first = samples[0];
  const load = first.loadMetrics || null;
  const probe = samples.map((sample) => sample.probe).find((value) => value && typeof value.ok === 'boolean');
  const probeLatencyMs = numericMean([probe?.latencyMs ?? first.probeLatencyMs]);
  const loadTargetsService = load && (load.targetService === first.serviceName || load.targetService === 'all');
  const totalRequests = sumMetric(samples, 'totalRequests');
  const failedRequests = sumMetric(samples, 'failedRequests');
  const requestsPerSecond = sumMetric(samples, 'requestsPerSecond');
  const serviceErrorRate = weightedMean(samples, 'serviceErrorRate', 'requestsLastMinute');
  const averageLatencyMs = weightedMean(samples, 'averageLatencyMs', 'requestsLastMinute');

  return {
    service: first.serviceName,
    cpuUsage: numericMean(samples.map((sample) => sample.cpuPercent)),
    memoryUsage: numericMean(samples.map((sample) => sample.memoryPercent)),
    totalRequests,
    successfulRequests: sumMetric(samples, 'successfulRequests'),
    failedRequests,
    activeRequests: sumMetric(samples, 'activeRequests'),
    requestsLastMinute: sumMetric(samples, 'requestsLastMinute'),
    requestsPerSecond: requestsPerSecond === null ? null : Number(requestsPerSecond.toFixed(2)),
    requestRate: requestsPerSecond === null ? null : Number(requestsPerSecond.toFixed(2)),
    averageLatencyMs,
    p95LatencyMs: numericMaximum(samples.map((sample) => sample.p95LatencyMs)),
    latencyMs: averageLatencyMs,
    errorRate: serviceErrorRate ?? (loadTargetsService ? Number(load.errorRate || 0) : null),
    probeLatencyMs,
    probeFailures: probe ? Number(!probe.ok) : null,
    restartCount: numericMaximum(samples.map((sample) => sample.restartCount)),
    containerState: samples.every((sample) => sample.lifecycleState === 'running') ? 'running' : samples[0].lifecycleState,
    memoryUsedBytes: numericMean(samples.map((sample) => sample.memoryUsedBytes)),
    memoryLimitBytes: numericMean(samples.map((sample) => sample.memoryLimitBytes)),
    dbActiveConnections: sumMetric(samples, 'dbActiveConnections'),
    dbIdleConnections: sumMetric(samples, 'dbIdleConnections'),
    dbWaitingRequests: sumMetric(samples, 'dbWaitingRequests'),
    dbAverageQueryLatencyMs: numericMean(samples.map((sample) => sample.dbAverageQueryLatencyMs)),
    dbErrorRate: numericMean(samples.map((sample) => sample.dbErrorRate)),
    loadMetrics: load
  };
}

function numericMaximum(values) {
  const valid = values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(Number)
    .filter(Number.isFinite);
  return valid.length ? Math.max(...valid) : null;
}

function averageSnapshots(snapshots) {
  if (!snapshots.length) return null;
  const metricKeys = [
    'cpuUsage',
    'memoryUsage',
    'latencyMs',
    'averageLatencyMs',
    'p95LatencyMs',
    'errorRate',
    'probeLatencyMs',
    'probeFailures'
  ];
  return {
    service: snapshots[0].service,
    ...Object.fromEntries(metricKeys.map((key) => [key, numericMean(snapshots.map((snapshot) => snapshot[key]))])),
    containerState: snapshots.every((snapshot) => snapshot.containerState === 'running') ? 'running' : snapshots[0].containerState
  };
}

function hasComparableMetrics(metrics) {
  return Boolean(metrics && [
    metrics.cpuUsage,
    metrics.memoryUsage,
    metrics.latencyMs,
    metrics.errorRate,
    metrics.probeFailures
  ].some((value) => value !== null && value !== undefined && Number.isFinite(Number(value))));
}

async function captureBeforeMetrics(targetService, collectMetrics = collectServiceMetrics) {
  const metrics = aggregateSamples(await collectMetrics(targetService));
  if (!hasComparableMetrics(metrics)) {
    throw new Error('Fresh before-action metrics are unavailable.');
  }
  return metrics;
}

async function collectVerificationWindow({
  targetService,
  beforeMetrics,
  verificationWindowMs,
  sampleCount,
  collectMetrics = collectServiceMetrics,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  startedAt = Date.now()
}) {
  const sampleIntervalMs = Math.floor(verificationWindowMs / sampleCount);
  const verificationSamples = [];
  const sampleErrors = [];
  for (let index = 0; index < sampleCount; index += 1) {
    await wait(sampleIntervalMs);
    try {
      const metrics = aggregateSamples(await collectMetrics(targetService));
      if (hasComparableMetrics(metrics)) {
        verificationSamples.push({ collectedAt: new Date().toISOString(), metrics });
      }
    } catch (error) {
      sampleErrors.push(error.message);
      logger.warn('fresh_recovery_metrics_unavailable', {
        targetService,
        sample: index + 1,
        message: error.message
      });
    }
  }
  const afterMetrics = averageSnapshots(verificationSamples.map((sample) => sample.metrics));
  const elapsedWindowMs = Date.now() - startedAt;
  const verification = verificationSamples.length >= 3
    ? verifyRecovery(beforeMetrics, afterMetrics, verificationSamples.length, elapsedWindowMs)
    : {
      status: 'verification_pending',
      effectivenessScore: null,
      effectivenessByMetric: null,
      beforeMetrics,
      afterMetrics,
      samplesUsed: verificationSamples.length,
      verificationWindowMs: elapsedWindowMs
    };
  return {
    verification,
    verificationSamples,
    sampleErrors,
    afterMetrics,
    verificationWindowMs: elapsedWindowMs
  };
}

function lifecycleStatus(status) {
  const legacyStatuses = {
    no_safe_action: 'skipped',
    max_replicas_reached: 'blocked',
    requires_database_remediation: 'manual_intervention_required',
    rate_limited: 'blocked',
    cooldown: 'blocked',
    action_limit_reached: 'blocked',
    in_progress: 'executing',
    pending: 'planned'
  };
  const resolved = legacyStatuses[status] || status;
  if (!RECOVERY_STATUSES.has(resolved)) throw new Error(`Unsupported recovery lifecycle status: ${status}`);
  return resolved;
}

async function getIncident(incidentId) {
  const result = await client.query('SELECT * FROM incidents WHERE id = $1', [incidentId]);
  return result.rows[0] || null;
}

async function latestSampleMetrics(serviceName) {
  const result = await client.query(
    `SELECT DISTINCT ON (container_id) * FROM monitoring_samples
     WHERE service_name = $1 AND collected_at >= NOW() - INTERVAL '30 seconds'
     ORDER BY container_id, collected_at DESC LIMIT 20`,
    [serviceName]
  );
  const rows = result.rows;
  if (!rows.length) return null;
  const load = rows.find((row) => row.load_total_requests !== null);
  return aggregateSamples(rows.map((row) => ({
    serviceName,
    cpuPercent: row.cpu_percent,
    memoryPercent: row.memory_percent,
    totalRequests: row.total_requests,
    successfulRequests: row.successful_requests,
    failedRequests: row.failed_requests,
    activeRequests: row.active_requests,
    requestsLastMinute: row.requests_last_minute,
    requestsPerSecond: row.requests_per_second,
    averageLatencyMs: row.average_latency_ms,
    p95LatencyMs: row.p95_latency_ms,
    serviceErrorRate: row.service_error_rate,
    dbTotalQueries: row.db_total_queries,
    dbActiveConnections: row.db_active_connections,
    dbIdleConnections: row.db_idle_connections,
    dbWaitingRequests: row.db_waiting_requests,
    dbAverageQueryLatencyMs: row.db_average_query_latency_ms,
    dbErrorRate: row.db_error_rate,
    probeLatencyMs: row.probe_latency_ms,
    probe: { ok: row.probe_ok, latencyMs: row.probe_latency_ms },
    restartCount: row.restart_count,
    lifecycleState: row.lifecycle_state,
    memoryUsedBytes: row.memory_used_bytes,
    memoryLimitBytes: row.memory_limit_bytes,
    loadMetrics: load ? {
      targetService: load.load_target_service,
      currentRequestsPerSecond: load.load_current_requests_per_second,
      averageLatencyMs: load.load_average_latency_ms,
      errorRate: load.load_error_rate
    } : null
  })));
}

async function recordRecoveryAction({
  incident,
  action,
  triggeredBy,
  status,
  recoveryStatus = status,
  message,
  beforeMetrics,
  cooldownStartedAt,
  cooldownUntil,
  decisionReason,
  decisionConfidence,
  errorDetails,
  recommendation,
  safetyCheck,
  replicaLimit,
  executionDetails,
  executionStartedAt,
  executionCompletedAt,
  verificationStartedAt,
  verificationCompletedAt,
  verificationSamples,
  samplesUsed,
  verificationWindowMs,
  afterMetrics,
  effectivenessScore,
  effectivenessByMetric
}) {
  const target = ALLOWED_TARGETS.has(action.target) ? action.target : 'not_applicable';
  const result = await client.query(
    `INSERT INTO recovery_actions
      (incident_id, action_type, target_service, previous_replicas, new_replicas, status, message,
       before_metrics, recovery_status, triggered_by, cooldown_started_at, cooldown_until,
       decision_reason, decision_confidence, error_details, recommendation, safety_check, replica_limit,
       execution_details, execution_started_at, execution_completed_at, verification_started_at,
       verification_completed_at, verification_samples, samples_used, verification_window_ms,
       after_metrics, effectiveness_score, effectiveness_by_metric, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
       $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, NOW()) RETURNING *`,
    [incident.id, action.action || action.decisionAction || action.status || status, target,
      action.fromReplicas ?? null, action.toReplicas ?? null, lifecycleStatus(status), message,
      beforeMetrics ? JSON.stringify(beforeMetrics) : null, lifecycleStatus(recoveryStatus), triggeredBy,
      cooldownStartedAt || null, cooldownUntil || null, decisionReason || action.reason || message || null,
      decisionConfidence ?? null, errorDetails || null, recommendation || null,
      safetyCheck ? JSON.stringify(safetyCheck) : null, replicaLimit ?? null,
      executionDetails ? JSON.stringify(executionDetails) : null, executionStartedAt || null,
      executionCompletedAt || null, verificationStartedAt || null, verificationCompletedAt || null,
      verificationSamples ? JSON.stringify(verificationSamples) : null, samplesUsed ?? null,
      verificationWindowMs ?? null, afterMetrics ? JSON.stringify(afterMetrics) : null,
      effectivenessScore ?? null, effectivenessByMetric ? JSON.stringify(effectivenessByMetric) : null]
  );
  return result.rows[0];
}

async function updateNoExecution(incident, action, status, triggeredBy, message, options = {}) {
  const resolvedStatus = lifecycleStatus(status);
  const recommendation = options.recommendation
    || action.action
    || recommendRecovery(incident).recommendation;
  const record = await recordRecoveryAction({
    incident,
    action,
    triggeredBy,
    status: resolvedStatus,
    recoveryStatus: resolvedStatus,
    message,
    cooldownStartedAt: options.cooldownStartedAt,
    cooldownUntil: options.cooldownUntil,
    decisionReason: action.reason || message,
    decisionConfidence: incident.classification_confidence,
    errorDetails: options.errorDetails,
    recommendation,
    safetyCheck: options.safetyCheck || { safe: false, reason: message },
    replicaLimit: options.replicaLimit
  });
  await client.query(
    `UPDATE incidents SET action_status = $1, recovery_status = $2,
      recovery_recommendation = COALESCE($3, recovery_recommendation),
      manual_intervention_required = $4, updated_at = NOW() WHERE id = $5`,
    [resolvedStatus, resolvedStatus, recommendation || null, Boolean(options.manualInterventionRequired), incident.id]
  );
  return { success: false, status: resolvedStatus, recoveryStatus: resolvedStatus, message, actionRecord: record };
}

async function activeActionCooldown(incidentId, actionType, targetService) {
  const result = await client.query(
    `SELECT cooldown_started_at, cooldown_until FROM recovery_actions
      WHERE incident_id = $1 AND action_type = $2 AND target_service = $3
        AND cooldown_until > NOW() AND status NOT IN ('cooldown', 'rate_limited', 'action_limit_reached')
      ORDER BY created_at DESC LIMIT 1`,
    [incidentId, actionType, targetService]
  );
  return result.rows[0] || null;
}

async function incidentRecoveryStats(incidentId) {
  const result = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE status <> ALL($2::text[]))::INTEGER AS action_count,
       COUNT(*) FILTER (WHERE status IN ('failed', 'not_recovered'))::INTEGER AS failed_count
     FROM recovery_actions WHERE incident_id = $1`,
    [incidentId, NON_EXECUTED_STATUSES]
  );
  return {
    actionCount: Number(result.rows[0]?.action_count || 0),
    failedCount: Number(result.rows[0]?.failed_count || 0)
  };
}

async function serviceActionsInLastHour(serviceName) {
  const result = await client.query(
    `SELECT COUNT(*)::INTEGER AS count FROM recovery_actions
      WHERE target_service = $1 AND created_at >= NOW() - INTERVAL '1 hour'
        AND status <> ALL($2::text[])`,
    [serviceName, NON_EXECUTED_STATUSES]
  );
  return Number(result.rows[0]?.count || 0);
}

async function serviceFailureCount(serviceName, incidentType) {
  const result = await client.query(
    `SELECT COUNT(*)::INTEGER AS count
       FROM recovery_actions ra
       JOIN incidents incident ON incident.id = ra.incident_id
      WHERE ra.target_service = $1 AND incident.incident_type = $2
        AND ra.status IN ('failed', 'not_recovered')
        AND ra.created_at >= NOW() - INTERVAL '24 hours'`,
    [serviceName, incidentType]
  );
  return Number(result.rows[0]?.count || 0);
}

async function automaticActionsInLastHour() {
  const result = await client.query(
    `SELECT COUNT(*)::INTEGER AS count FROM recovery_actions
      WHERE triggered_by = 'automatic' AND created_at >= NOW() - INTERVAL '1 hour'
        AND status <> ALL($1::text[])`,
    [NON_EXECUTED_STATUSES]
  );
  return Number(result.rows[0]?.count || 0);
}

function updateIncidentResult(incident, actionStatus, recoveryStatus, beforeMetrics, afterMetrics, triggeredBy, effectivenessScore, effectivenessByMetric) {
  const evidence = parseJson(incident.evidence);
  return {
    ...evidence,
    recovery: {
      actionStatus,
      recoveryStatus,
      triggeredBy,
      beforeMetrics,
      afterMetrics,
      effectivenessScore,
      effectivenessByMetric
    }
  };
}

function calculateCooldownMs(baseCooldownMs, previousFailures) {
  const multiplier = 2 ** Math.min(previousFailures, 4);
  return Math.min(baseCooldownMs * multiplier, 30 * 60 * 1000);
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
    const stats = await incidentRecoveryStats(incident.id);
    if (stats.failedCount >= config.maxFailuresBeforeManual || incident.manual_intervention_required) {
      const recommendation = 'manual_intervention_required';
      return updateNoExecution(
        incident,
        { target: incident.service_name, status: recommendation },
        recommendation,
        triggeredBy,
        `Recovery failed ${stats.failedCount} times; manual intervention is required.`,
        { recommendation, manualInterventionRequired: true }
      );
    }
    if (stats.actionCount >= config.maxActionsPerIncident) {
      return updateNoExecution(
        incident,
        { target: incident.service_name, status: 'blocked' },
        'blocked',
        triggeredBy,
        `The incident action limit of ${config.maxActionsPerIncident} has been reached.`,
        { recommendation: 'manual_intervention_required', manualInterventionRequired: true }
      );
    }
    if (triggeredBy === 'automatic' && shouldLimitAutomaticRecovery(await automaticActionsInLastHour(), config.maxActionsPerHour)) {
      return updateNoExecution(incident, { target: incident.service_name }, 'blocked', triggeredBy,
        `Automatic recovery limit of ${config.maxActionsPerHour} actions per hour has been reached.`);
    }

    const configForDecision = { ...config, maxServiceReplicas: Math.min(config.maxServiceReplicas, 5) };
    const replicas = ['traffic_spike', 'cpu_overload'].includes(incident.incident_type)
      ? await getCurrentReplicas('payment-service')
      : null;
    const action = decideRecoveryAction(incident, replicas, configForDecision);
    if (!action.action) {
      const status = lifecycleStatus(action.status || 'skipped');
      const recommendation = status === 'manual_intervention_required'
        ? 'database_remediation_required'
        : status === 'skipped' ? 'no_safe_action' : 'manual_intervention_required';
      return updateNoExecution(incident, action, status, triggeredBy, action.reason, {
        recommendation,
        replicaLimit: status === 'blocked' ? config.maxServiceReplicas : null
      });
    }
    const failedServiceActions = await serviceFailureCount(action.target, incident.incident_type);
    const failureCount = Math.max(stats.failedCount, failedServiceActions);
    if (failureCount >= config.maxFailuresBeforeManual) {
      return updateNoExecution(
        incident,
        action,
        'manual_intervention_required',
        triggeredBy,
        `The ${action.target} service has failed ${failureCount} recovery attempts for ${incident.incident_type}; manual intervention is required.`,
        { recommendation: 'manual_intervention_required', manualInterventionRequired: true }
      );
    }
    if (action.status === 'blocked') {
      return updateNoExecution(incident, action, 'blocked', triggeredBy, action.reason, {
        recommendation: action.action || 'manual_intervention_required',
        replicaLimit: config.maxServiceReplicas
      });
    }

    const cooldown = await activeActionCooldown(incident.id, action.action, action.target);
    if (cooldown) {
      return updateNoExecution(
        incident,
        action,
        'blocked',
        triggeredBy,
        `The same ${action.action} action is cooling down until ${new Date(cooldown.cooldown_until).toISOString()}.`,
        {
          cooldownStartedAt: cooldown.cooldown_started_at,
          cooldownUntil: cooldown.cooldown_until,
          recommendation: action.action
        }
      );
    }
    if (await serviceActionsInLastHour(action.target) >= config.maxActionsPerServicePerHour) {
      return updateNoExecution(
        incident,
        action,
        'blocked',
        triggeredBy,
        `Recovery limit of ${config.maxActionsPerServicePerHour} actions for ${action.target} per hour has been reached.`,
        { recommendation: action.action }
      );
    }

    const cooldownStartedAt = new Date();
    const cooldownUntil = new Date(
      cooldownStartedAt.getTime() + calculateCooldownMs(config.cooldownMs, failureCount)
    );
    const recommendation = recommendRecovery(incident, failureCount, config);
    if (action.action) {
      recommendation.recommendation = action.action;
      recommendation.targetService = action.target;
      recommendation.reason = action.reason;
    }

    actionRecord = await recordRecoveryAction({
      incident,
      action,
      triggeredBy,
      status: 'planned',
      recoveryStatus: 'planned',
      message: action.reason,
      cooldownStartedAt,
      cooldownUntil,
      decisionReason: action.reason,
      decisionConfidence: incident.classification_confidence,
      recommendation: recommendation.recommendation,
      safetyCheck: { safe: true, reason: 'Action and target passed the recovery allowlist and current replica checks.' },
      replicaLimit: config.maxServiceReplicas
    });
    await client.query(
      `UPDATE incidents SET action_status = 'planned', recovery_status = 'planned',
        recovery_recommendation = $1, manual_intervention_required = FALSE, updated_at = NOW() WHERE id = $2`,
      [recommendation.recommendation, incident.id]
    );

    let beforeMetrics;
    try {
      beforeMetrics = await captureBeforeMetrics(action.target);
    } catch (error) {
      const message = `Fresh before-action metrics could not be collected; no recovery action was executed. ${error.message}`;
      await client.query(
        `UPDATE recovery_actions SET status = 'blocked', recovery_status = 'blocked', message = $1,
          error_details = $2, updated_at = NOW() WHERE id = $3`,
        [message, error.message, actionRecord.id]
      );
      await client.query(
        `UPDATE incidents SET action_status = 'blocked', recovery_status = 'blocked', updated_at = NOW() WHERE id = $1`,
        [incident.id]
      );
      return { success: false, status: 'blocked', message, actionRecordId: actionRecord.id };
    }

    const executionStartedAt = new Date();
    await client.query(
      `UPDATE recovery_actions SET status = 'executing', recovery_status = 'executing',
        before_metrics = $1, execution_started_at = $2, updated_at = NOW() WHERE id = $3`,
      [JSON.stringify(beforeMetrics), executionStartedAt, actionRecord.id]
    );
    await client.query(
      `UPDATE incidents SET action_status = 'executing', recovery_status = 'executing', updated_at = NOW() WHERE id = $1`,
      [incident.id]
    );

    let execution;
    try {
      execution = await executeRecoveryAction(action, configForDecision);
    } catch (error) {
      await client.query(
        `UPDATE recovery_actions SET status = 'failed', message = $1, error_details = $2,
          recovery_status = 'failed', execution_completed_at = NOW(), execution_details = $3, updated_at = NOW()
         WHERE id = $4`,
        [error.message, error.message, JSON.stringify(error.executionDetails || {
          action: action.action,
          target: action.target,
          error: error.message
        }), actionRecord.id]
      );
      await client.query(
        `UPDATE incidents SET action_status = 'failed', recovery_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [incident.id]
      );
      const failedStats = await incidentRecoveryStats(incident.id);
      const serviceFailures = await serviceFailureCount(action.target, incident.incident_type);
      if (Math.max(failedStats.failedCount, serviceFailures) >= config.maxFailuresBeforeManual) {
        await client.query(
          `UPDATE incidents SET manual_intervention_required = TRUE, recovery_recommendation = 'manual_intervention_required', updated_at = NOW() WHERE id = $1`,
          [incident.id]
        );
      }
      return { success: false, status: 'failed', message: error.message, actionRecordId: actionRecord.id };
    }

    if (execution.status !== 'executed') {
      return updateExecutionRejected(incident, actionRecord, execution, triggeredBy, beforeMetrics, executionStartedAt);
    }

    const executionCompletedAt = execution.completedAt ? new Date(execution.completedAt) : new Date();
    await client.query(
      `UPDATE recovery_actions SET status = 'executed', recovery_status = 'executed', message = $1,
        execution_details = $2, execution_completed_at = $3, updated_at = NOW() WHERE id = $4`,
      [execution.message, JSON.stringify(execution), executionCompletedAt, actionRecord.id]
    );
    const verificationStartedAt = new Date();
    await client.query(
      `UPDATE recovery_actions SET status = 'verification_pending', recovery_status = 'verification_pending',
        verification_started_at = $1, updated_at = NOW() WHERE id = $2`,
      [verificationStartedAt, actionRecord.id]
    );
    await client.query(
      `UPDATE incidents SET action_status = 'verification_pending', recovery_status = 'verification_pending', updated_at = NOW()
       WHERE id = $1`,
      [incident.id]
    );

    const verificationWindow = await collectVerificationWindow({
      targetService: action.target,
      beforeMetrics,
      verificationWindowMs: config.verificationDelayMs,
      sampleCount: config.verificationSamples,
      startedAt: verificationStartedAt.getTime()
    });
    const {
      verification,
      verificationSamples,
      sampleErrors,
      afterMetrics,
      verificationWindowMs
    } = verificationWindow;
    const verificationCompletedAt = new Date();
    const serviceFailures = verification.status === 'not_recovered'
      ? await serviceFailureCount(action.target, incident.incident_type)
      : 0;
    const requiresManualIntervention = verification.status === 'not_recovered'
      && Math.max(stats.failedCount + 1, serviceFailures) >= config.maxFailuresBeforeManual;
    const actionStatus = verification.status;
    const evidenceWithRecovery = updateIncidentResult(
      incident, 'executed', verification.status, verification.beforeMetrics, verification.afterMetrics,
      triggeredBy, verification.effectivenessScore, verification.effectivenessByMetric
    );

    await client.query(
      `UPDATE recovery_actions SET status = $1, recovery_status = $2, before_metrics = $3, after_metrics = $4,
       effectiveness_score = $5, effectiveness_by_metric = $6, message = $7, verification_samples = $8,
       samples_used = $9, verification_window_ms = $10, verification_completed_at = $11,
       error_details = $12, updated_at = NOW() WHERE id = $13`,
      [actionStatus, verification.status, verification.beforeMetrics ? JSON.stringify(verification.beforeMetrics) : null,
        verification.afterMetrics ? JSON.stringify(verification.afterMetrics) : null, verification.effectivenessScore,
        verification.effectivenessByMetric ? JSON.stringify(verification.effectivenessByMetric) : null,
        execution.message, JSON.stringify(verificationSamples), verificationSamples.length,
        verificationWindowMs, verificationCompletedAt,
        sampleErrors.length ? sampleErrors.join('\n') : null, actionRecord.id]
    );
    const updatedResult = await client.query(
      `UPDATE incidents SET action_status = $1, recovery_status = $1, evidence = $2,
       manual_intervention_required = $3, recovery_recommendation = $4, updated_at = NOW() WHERE id = $5 RETURNING *`,
      [
        verification.status,
        JSON.stringify(evidenceWithRecovery),
        requiresManualIntervention,
        requiresManualIntervention
          ? 'manual_intervention_required'
          : recommendation.recommendation,
        incident.id
      ]
    );
    const updatedIncident = updatedResult.rows[0];

    const summaryInput = {
      ...updatedIncident,
      service: incident.service_name,
      incidentType: incident.incident_type,
      rootCause: incident.root_cause,
      affectedServices: incident.affected_services,
      metrics: incident.latest_metrics,
      timeline: (await client.query(
        `SELECT created_at, action_type, target_service, status, message, before_metrics,
          after_metrics, effectiveness_score, cooldown_started_at, cooldown_until,
          error_details, triggered_by
         FROM recovery_actions WHERE incident_id = $1 ORDER BY created_at ASC`,
        [incident.id]
      )).rows,
      recoveryAction: action,
      recoveryResult: {
        status: verification.status,
        effectivenessScore: verification.effectivenessScore,
        effectivenessByMetric: verification.effectivenessByMetric,
        latencyBeforeMs: verification.beforeMetrics?.latencyMs,
        latencyAfterMs: verification.afterMetrics?.latencyMs,
        errorRateBefore: verification.beforeMetrics?.errorRate,
        errorRateAfter: verification.afterMetrics?.errorRate
      }
    };
    const summaryResult = verification.status === 'verification_pending'
      ? (() => {
        const report = buildTemplateReport(summaryInput);
        return { summary: formatReport(report), report, source: 'fallback' };
      })()
      : await buildIncidentSummaryResult(summaryInput);
    await client.query(
      `UPDATE incidents SET genai_summary = $1, genai_summary_source = $2, genai_report = $3,
        updated_at = NOW() WHERE id = $4`,
      [summaryResult.summary, summaryResult.source, JSON.stringify(summaryResult.report), incident.id]
    );

    return {
      success: true,
      action: execution,
      selectedAction: action,
      triggeredBy,
      recoveryStatus: verification.status,
      status: verification.status,
      effectivenessScore: verification.effectivenessScore,
      effectivenessByMetric: verification.effectivenessByMetric,
      beforeMetrics: verification.beforeMetrics,
      afterMetrics: verification.afterMetrics,
      summary: summaryResult.summary,
      report: summaryResult.report,
      summarySource: summaryResult.source,
      actionRecordId: actionRecord.id,
      incident: updatedIncident
    };
  } finally {
    inFlightIncidents.delete(Number(incidentId));
    if (triggeredBy === 'automatic') automaticRecoveryInFlight = false;
  }
}

async function updateExecutionRejected(incident, actionRecord, execution, triggeredBy, beforeMetrics, executionStartedAt) {
  const status = execution.status === 'blocked' || execution.status === 'max_replicas_reached' ? 'blocked' : 'failed';
  await client.query(
    `UPDATE recovery_actions SET status = $1, message = $2, error_details = $3, recovery_status = $1,
      before_metrics = $4, execution_started_at = $5, execution_completed_at = NOW(),
      execution_details = $6, updated_at = NOW() WHERE id = $7`,
    [status, execution.message, status === 'failed' ? execution.message : null,
      beforeMetrics ? JSON.stringify(beforeMetrics) : null, executionStartedAt,
      JSON.stringify(execution), actionRecord.id]
  );
  await client.query(
    `UPDATE incidents SET action_status = $1, recovery_status = $1, updated_at = NOW() WHERE id = $2`,
    [status, incident.id]
  );
  return { success: false, status, recoveryStatus: status, message: execution.message, triggeredBy, actionRecordId: actionRecord.id };
}

async function reconcileRecoveryActions({ db = client, listContainers = getServiceContainers } = {}) {
  const expiredResult = await db.query(
    `UPDATE recovery_actions
       SET status = 'expired', recovery_status = 'expired',
           message = COALESCE(message, 'Recovery action expired before verification completed.'),
           updated_at = NOW()
     WHERE status IN ('planned', 'verification_pending')
       AND updated_at <= NOW() - INTERVAL '10 minutes'
     RETURNING id, incident_id, created_at`
  );
  for (const action of expiredResult.rows) {
    await db.query(
      `UPDATE incidents SET action_status = 'expired', recovery_status = 'expired', updated_at = NOW()
       WHERE id = $1 AND NOT EXISTS (
         SELECT 1 FROM recovery_actions newer
          WHERE newer.incident_id = $1 AND newer.id <> $2 AND newer.created_at > $3
       )`,
      [action.incident_id, action.id, action.created_at]
    );
  }

  const executingResult = await db.query(
    `SELECT id, incident_id, target_service, created_at FROM recovery_actions WHERE status = 'executing'`
  );
  let failedCount = 0;
  for (const action of executingResult.rows) {
    const containers = await listContainers(action.target_service, true);
    if (containers.length) continue;
    const message = `Target container for ${action.target_service} no longer exists; recovery execution failed.`;
    const updateResult = await db.query(
      `UPDATE recovery_actions SET status = 'failed', recovery_status = 'failed',
        message = $1, error_details = $1, updated_at = NOW()
       WHERE id = $2 AND status = 'executing' RETURNING id`,
      [message, action.id]
    );
    if (!updateResult.rows.length) continue;
    failedCount += 1;
    await db.query(
      `UPDATE incidents SET action_status = 'failed', recovery_status = 'failed', updated_at = NOW()
       WHERE id = $1 AND NOT EXISTS (
         SELECT 1 FROM recovery_actions newer
          WHERE newer.incident_id = $1 AND newer.id <> $2 AND newer.created_at > $3
       )`,
      [action.incident_id, action.id, action.created_at]
    );
  }
  return { expiredCount: expiredResult.rows.length, failedCount };
}

function startRecoveryReconciliation(intervalMs = 60000) {
  const reconcile = () => {
    reconcileRecoveryActions().catch((error) => {
      logger.error('recovery_reconciliation_failed', { message: error.message });
    });
  };
  reconcile();
  const timer = setInterval(reconcile, intervalMs);
  timer.unref();
  return timer;
}

module.exports = {
  runRecovery,
  aggregateSamples,
  averageSnapshots,
  hasComparableMetrics,
  captureBeforeMetrics,
  collectVerificationWindow,
  recordRecoveryAction,
  latestSampleMetrics,
  automaticActionsInLastHour,
  shouldLimitAutomaticRecovery,
  calculateCooldownMs,
  incidentRecoveryStats,
  serviceActionsInLastHour,
  serviceFailureCount,
  lifecycleStatus,
  reconcileRecoveryActions,
  startRecoveryReconciliation
};
