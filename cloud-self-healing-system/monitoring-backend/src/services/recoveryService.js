const Docker = require('dockerode');
const { execFile } = require('node:child_process');

const ALLOWED_ACTIONS = new Set(['restart_service', 'scale_service']);
const ALLOWED_TARGETS = new Set(['payment-service', 'order-service', 'user-service']);
const SCALABLE_TARGETS = new Set(['payment-service']);
const ABSOLUTE_MAX_REPLICAS = 5;
const RECOVERY_STATUSES = new Set([
  'planned',
  'executing',
  'executed',
  'verification_pending',
  'recovered',
  'partially_recovered',
  'not_recovered',
  'failed',
  'blocked',
  'skipped',
  'manual_intervention_required',
  'expired'
]);
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const recoveryConfig = {
  autoRecoveryEnabled: process.env.AUTO_RECOVERY_ENABLED === 'true',
  maxActionsPerHour: Number(process.env.AUTO_RECOVERY_MAX_ACTIONS_PER_HOUR || 5),
  cooldownMs: Number(process.env.RECOVERY_COOLDOWN_MS || 120000),
  maxActionsPerIncident: Number(process.env.MAX_RECOVERY_ACTIONS_PER_INCIDENT || 3),
  maxActionsPerServicePerHour: Number(process.env.MAX_RECOVERY_ACTIONS_PER_SERVICE_PER_HOUR || 5),
  maxFailuresBeforeManual: Number(process.env.RECOVERY_MAX_FAILURES_BEFORE_MANUAL || 3),
  verificationDelayMs: Number(process.env.RECOVERY_VERIFICATION_DELAY_MS || 30000),
  verificationSamples: Number(process.env.RECOVERY_VERIFICATION_SAMPLES || 6),
  maxServiceReplicas: Math.min(Number(process.env.MAX_SERVICE_REPLICAS || 5), ABSOLUTE_MAX_REPLICAS),
  minServiceReplicas: Number(process.env.MIN_SERVICE_REPLICAS || 1)
};

function getRecoveryConfig() {
  return { ...recoveryConfig };
}

function updateRecoveryConfig(input = {}) {
  const allowed = new Set([
    'autoRecoveryEnabled',
    'maxActionsPerHour',
    'cooldownMs',
    'maxActionsPerIncident',
    'maxActionsPerServicePerHour',
    'maxFailuresBeforeManual',
    'verificationDelayMs',
    'verificationSamples',
    'maxServiceReplicas',
    'minServiceReplicas'
  ]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Unsupported recovery configuration: ${unknown.join(', ')}`);

  const next = { ...recoveryConfig, ...input };
  if (typeof next.autoRecoveryEnabled !== 'boolean') throw new Error('autoRecoveryEnabled must be boolean');
  if (!Number.isInteger(next.maxActionsPerHour) || next.maxActionsPerHour < 1 || next.maxActionsPerHour > 60) {
    throw new Error('maxActionsPerHour must be between 1 and 60');
  }
  if (!Number.isInteger(next.cooldownMs) || next.cooldownMs < 1000 || next.cooldownMs > 3600000) {
    throw new Error('cooldownMs must be between 1000 and 3600000');
  }
  if (!Number.isInteger(next.maxActionsPerIncident) || next.maxActionsPerIncident < 1 || next.maxActionsPerIncident > 20) {
    throw new Error('maxActionsPerIncident must be between 1 and 20');
  }
  if (!Number.isInteger(next.maxActionsPerServicePerHour) || next.maxActionsPerServicePerHour < 1 || next.maxActionsPerServicePerHour > 60) {
    throw new Error('maxActionsPerServicePerHour must be between 1 and 60');
  }
  if (!Number.isInteger(next.maxFailuresBeforeManual) || next.maxFailuresBeforeManual < 1 || next.maxFailuresBeforeManual > 10) {
    throw new Error('maxFailuresBeforeManual must be between 1 and 10');
  }
  if (!Number.isInteger(next.verificationDelayMs) || next.verificationDelayMs < 30000 || next.verificationDelayMs > 60000) {
    throw new Error('verificationDelayMs must be between 30000 and 60000');
  }
  if (!Number.isInteger(next.verificationSamples) || next.verificationSamples < 3 || next.verificationSamples > 6) {
    throw new Error('verificationSamples must be between 3 and 6');
  }
  if (!Number.isInteger(next.maxServiceReplicas) || next.maxServiceReplicas < 2 || next.maxServiceReplicas > ABSOLUTE_MAX_REPLICAS) {
    throw new Error(`maxServiceReplicas must be between 2 and ${ABSOLUTE_MAX_REPLICAS}`);
  }
  if (!Number.isInteger(next.minServiceReplicas) || next.minServiceReplicas < 1 || next.minServiceReplicas > next.maxServiceReplicas) {
    throw new Error('minServiceReplicas must be between 1 and maxServiceReplicas');
  }

  Object.assign(recoveryConfig, next);
  return getRecoveryConfig();
}

function normalizedIncidentValue(incident, camelName, snakeName) {
  return incident[camelName] ?? incident[snakeName] ?? '';
}

function decideRecoveryAction(incident, currentReplicas = null, config = recoveryConfig) {
  const incidentType = normalizedIncidentValue(incident, 'incidentType', 'incident_type');
  const rootCause = normalizedIncidentValue(incident, 'rootCause', 'root_cause');
  const service = normalizedIncidentValue(incident, 'service', 'service_name');
  const affected = incident.affectedServices || incident.affected_services || [];

  if ((incidentType === 'traffic_spike' || incidentType === 'cpu_overload') && rootCause === 'payment-service') {
    if (!Number.isInteger(currentReplicas) || currentReplicas < 1) {
      return { action: null, target: 'payment-service', status: 'skipped', reason: 'No safe recovery action available: current payment-service replica count is unavailable.' };
    }
    if (currentReplicas >= config.maxServiceReplicas) {
      return {
        action: null,
        decisionAction: 'scale_service',
        target: 'payment-service',
        status: 'blocked',
        reason: `Scaling blocked: maximum replica limit of ${config.maxServiceReplicas} reached.`
      };
    }
    return {
      action: 'scale_service',
      target: 'payment-service',
      fromReplicas: currentReplicas,
      toReplicas: currentReplicas + 1,
      reason: incidentType === 'traffic_spike' ? 'Traffic spike detected; add one payment-service replica.' : 'CPU overload detected; add one payment-service replica.'
    };
  }

  if (incidentType === 'memory_leak' && rootCause === 'payment-service') {
    return { action: 'restart_service', target: 'payment-service', reason: 'Memory leak detected; restart payment-service to release retained memory.' };
  }

  if (incidentType === 'database_bottleneck') {
    return {
      action: null,
      target: 'not_applicable',
      status: 'manual_intervention_required',
      reason: 'Database remediation required: Application-only recovery cannot repair a database-level issue.'
    };
  }

  if (incidentType === 'network_failure') {
    const target = ALLOWED_TARGETS.has(service) ? service : affected.find((name) => ALLOWED_TARGETS.has(name));
    if (target) return { action: 'restart_service', target, reason: `Restart ${target} to recover from the network failure.` };
  }

  return { action: null, target: ALLOWED_TARGETS.has(service) ? service : 'not_applicable', status: 'skipped', reason: 'No safe recovery action available.' };
}

function recommendRecovery(incident, failedAttempts = 0, config = recoveryConfig) {
  const incidentType = normalizedIncidentValue(incident, 'incidentType', 'incident_type');
  const rootCause = normalizedIncidentValue(incident, 'rootCause', 'root_cause');
  const recoveryStatus = normalizedIncidentValue(incident, 'recoveryStatus', 'recovery_status');
  if (incident.manual_intervention_required || failedAttempts >= config.maxFailuresBeforeManual) {
    return {
      recommendation: 'manual_intervention_required',
      reason: `Recovery has failed ${failedAttempts} times; an operator should investigate before another action.`,
      confidence: Number(incident.classification_confidence) || null
    };
  }
  if (incidentType === 'database_bottleneck') {
    return {
      recommendation: 'database_remediation_required',
      reason: 'Database is the identified root cause; restarting an application service is not a safe remediation.',
      confidence: Number(incident.classification_confidence) || null
    };
  }
  if (incident.anomaly_detected === false || recoveryStatus === 'recovered' || recoveryStatus === 'no_action_required') {
    return {
      recommendation: 'no_action_required',
      reason: 'No unresolved anomaly remains for this incident.',
      confidence: Number(incident.classification_confidence) || null
    };
  }
  if (['traffic_spike', 'cpu_overload'].includes(incidentType) && rootCause === 'payment-service') {
    return {
      recommendation: 'scale_service',
      targetService: 'payment-service',
      reason: `Add one payment-service replica to address ${incidentType.replace('_', ' ')}.`,
      confidence: Number(incident.classification_confidence) || null
    };
  }
  if (incidentType === 'memory_leak' && rootCause === 'payment-service') {
    return {
      recommendation: 'restart_service',
      targetService: 'payment-service',
      reason: 'Restart payment-service to release retained memory.',
      confidence: Number(incident.classification_confidence) || null
    };
  }
  const action = decideRecoveryAction(incident, null, config);
  if (action.action === 'restart_service') {
    return {
      recommendation: 'restart_service',
      targetService: action.target,
      reason: action.reason,
      confidence: Number(incident.classification_confidence) || null
    };
  }
  if (action.action === 'scale_service') {
    return {
      recommendation: 'scale_service',
      targetService: action.target,
      reason: action.reason,
      confidence: Number(incident.classification_confidence) || null
    };
  }
  return {
    recommendation: 'manual_intervention_required',
    reason: action.reason || 'No safe automated action is available.',
    confidence: Number(incident.classification_confidence) || null
  };
}

async function getServiceContainers(target, includeStopped = false) {
  if (!ALLOWED_TARGETS.has(target)) throw new Error(`Target ${target} is not allowlisted.`);
  const projectName = process.env.COMPOSE_PROJECT_NAME || 'cloud-self-healing-system';
  const containers = await docker.listContainers({
    all: includeStopped,
    filters: { label: [`com.docker.compose.project=${projectName}`, `com.docker.compose.service=${target}`] }
  });
  return containers;
}

async function getCurrentReplicas(target) {
  return (await getServiceContainers(target)).filter((container) => container.State === 'running').length;
}

function validateAction(actionConfig) {
  if (!actionConfig || !ALLOWED_ACTIONS.has(actionConfig.action)) throw new Error(`Action '${actionConfig?.action}' is not allowlisted.`);
  if (!ALLOWED_TARGETS.has(actionConfig.target)) throw new Error(`Target '${actionConfig.target}' is not allowlisted.`);
}

function composeScaleArguments(actionConfig, config = recoveryConfig) {
  validateAction(actionConfig);
  if (!SCALABLE_TARGETS.has(actionConfig.target)) throw new Error(`Scaling ${actionConfig.target} is not allowed.`);
  if (!Number.isInteger(actionConfig.toReplicas)
    || actionConfig.toReplicas < config.minServiceReplicas
    || actionConfig.toReplicas > config.maxServiceReplicas) {
    throw new Error(`Requested replica count must be between ${config.minServiceReplicas} and ${config.maxServiceReplicas}.`);
  }
  const projectDirectory = process.env.COMPOSE_PROJECT_DIRECTORY || '/workspace';
  const projectFile = process.env.COMPOSE_FILE_PATH || `${projectDirectory}/docker-compose.yml`;
  const projectName = process.env.COMPOSE_PROJECT_NAME || 'cloud-self-healing-system';
  return [
    'compose',
    '--project-directory', projectDirectory,
    '--project-name', projectName,
    '--file', projectFile,
    'up',
    '--detach',
    '--no-deps',
    '--no-build',
    '--no-recreate',
    '--scale', `${actionConfig.target}=${actionConfig.toReplicas}`,
    actionConfig.target
  ];
}

function commandText(command, args) {
  return [command, ...args].map((part) => /\s/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part).join(' ');
}

async function scaleService(actionConfig, config = recoveryConfig) {
  const containers = (await getServiceContainers(actionConfig.target)).filter((container) => container.State === 'running');
  const currentReplicas = containers.length;
  if (currentReplicas >= config.maxServiceReplicas) {
    return { status: 'blocked', message: `Scaling blocked: maximum replica limit of ${config.maxServiceReplicas} reached.` };
  }
  if (currentReplicas !== actionConfig.fromReplicas || actionConfig.toReplicas !== currentReplicas + 1) {
    return { status: 'blocked', message: 'Scaling blocked: replica count changed before execution; no action was performed.' };
  }

  const args = composeScaleArguments(actionConfig, config);
  const composeCommand = commandText('docker', args);
  const projectDirectory = process.env.COMPOSE_PROJECT_DIRECTORY || '/workspace';
  await new Promise((resolve, reject) => {
    execFile('docker', args, { cwd: projectDirectory, timeout: 300000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message).trim();
        const composeError = new Error(`Docker Compose scaling failed: ${detail}`);
        composeError.executionDetails = { command: composeCommand, error: detail };
        reject(composeError);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
  return {
    status: 'executed',
    message: `${actionConfig.target} scaled from ${currentReplicas} to ${actionConfig.toReplicas} replicas using Docker Compose.`,
    command: composeCommand,
    fromReplicas: currentReplicas,
    toReplicas: actionConfig.toReplicas
  };
}

async function executeRecoveryAction(actionConfig, config = recoveryConfig) {
  validateAction(actionConfig);
  if (actionConfig.action === 'scale_service') return scaleService(actionConfig, config);

  const containers = (await getServiceContainers(actionConfig.target, true))
    .filter((container) => container.State === 'running');
  if (!containers.length) throw new Error(`No running containers found for ${actionConfig.target}.`);
  const startedAt = new Date().toISOString();
  await Promise.all(containers.map((container) => docker.getContainer(container.Id).restart({ t: 10 })));
  return {
    status: 'executed',
    message: `${actionConfig.target} restarted successfully.`,
    command: `Docker Engine restart (${containers.length} container${containers.length === 1 ? '' : 's'})`,
    containerIds: containers.map((container) => container.Id),
    startedAt,
    completedAt: new Date().toISOString()
  };
}

module.exports = {
  decideRecoveryAction,
  executeRecoveryAction,
  getCurrentReplicas,
  getServiceContainers,
  getRecoveryConfig,
  updateRecoveryConfig,
  recommendRecovery,
  validateAction,
  composeScaleArguments,
  RECOVERY_STATUSES,
  ALLOWED_ACTIONS,
  ALLOWED_TARGETS,
  SCALABLE_TARGETS,
  ABSOLUTE_MAX_REPLICAS
};
