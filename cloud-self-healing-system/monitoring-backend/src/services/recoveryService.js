const Docker = require('dockerode');

const ALLOWED_ACTIONS = new Set(['restart_service', 'scale_service']);
const ALLOWED_TARGETS = new Set(['payment-service', 'order-service', 'user-service', 'load-generator']);
const SCALABLE_TARGETS = new Set(['payment-service']);
const ABSOLUTE_MAX_REPLICAS = 5;
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const recoveryConfig = {
  autoRecoveryEnabled: process.env.AUTO_RECOVERY_ENABLED === 'true',
  maxActionsPerHour: Number(process.env.AUTO_RECOVERY_MAX_ACTIONS_PER_HOUR || 5),
  verificationDelayMs: Number(process.env.RECOVERY_VERIFICATION_DELAY_MS || 10000),
  maxServiceReplicas: Math.min(Number(process.env.MAX_SERVICE_REPLICAS || 5), ABSOLUTE_MAX_REPLICAS),
  minServiceReplicas: Number(process.env.MIN_SERVICE_REPLICAS || 2)
};

function getRecoveryConfig() {
  return { ...recoveryConfig };
}

function updateRecoveryConfig(input = {}) {
  const allowed = new Set(['autoRecoveryEnabled', 'maxActionsPerHour', 'verificationDelayMs', 'maxServiceReplicas', 'minServiceReplicas']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Unsupported recovery configuration: ${unknown.join(', ')}`);

  const next = { ...recoveryConfig, ...input };
  if (typeof next.autoRecoveryEnabled !== 'boolean') throw new Error('autoRecoveryEnabled must be boolean');
  if (!Number.isInteger(next.maxActionsPerHour) || next.maxActionsPerHour < 1 || next.maxActionsPerHour > 60) {
    throw new Error('maxActionsPerHour must be between 1 and 60');
  }
  if (!Number.isInteger(next.verificationDelayMs) || next.verificationDelayMs < 1000 || next.verificationDelayMs > 120000) {
    throw new Error('verificationDelayMs must be between 1000 and 120000');
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
      return { action: null, target: 'payment-service', status: 'no_safe_action', reason: 'Current payment-service replica count is unavailable.' };
    }
    if (currentReplicas >= config.maxServiceReplicas) {
      return { action: null, target: 'payment-service', status: 'max_replicas_reached', fromReplicas: currentReplicas, toReplicas: currentReplicas, reason: `payment-service is already at the maximum of ${config.maxServiceReplicas} replicas.` };
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
      action: 'restart_service',
      target: 'payment-service',
      reason: 'Database bottleneck requires database-level remediation, which is outside the current safe action scope. Restarting payment-service is limited containment.'
    };
  }

  if (incidentType === 'network_failure') {
    const target = ALLOWED_TARGETS.has(service) ? service : affected.find((name) => ALLOWED_TARGETS.has(name));
    if (target) return { action: 'restart_service', target, reason: `Restart ${target} to recover from the network failure.` };
  }

  return { action: null, target: ALLOWED_TARGETS.has(service) ? service : 'not_applicable', status: 'no_safe_action', reason: `No allowlisted recovery action is defined for incident type '${incidentType || 'unknown'}' and root cause '${rootCause || 'unknown'}'.` };
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

async function scaleService(actionConfig, config = recoveryConfig) {
  if (!SCALABLE_TARGETS.has(actionConfig.target)) throw new Error(`Scaling ${actionConfig.target} is not allowed.`);
  const containers = (await getServiceContainers(actionConfig.target)).filter((container) => container.State === 'running');
  const currentReplicas = containers.length;
  if (currentReplicas >= config.maxServiceReplicas) {
    return { status: 'max_replicas_reached', message: `${actionConfig.target} is already at ${currentReplicas} replicas.` };
  }
  if (currentReplicas !== actionConfig.fromReplicas || actionConfig.toReplicas !== currentReplicas + 1) {
    return { status: 'replica_count_changed', message: 'Replica count changed before execution; no scale action was performed.' };
  }

  const source = await docker.getContainer(containers[0].Id).inspect();
  const networks = Object.keys(source.NetworkSettings.Networks || {});
  if (!networks.length) throw new Error(`No Docker network is attached to ${actionConfig.target}.`);
  const networkName = networks[0];
  const replicaNumber = currentReplicas + 1;
  const labels = {
    ...source.Config.Labels,
    'com.docker.compose.project': process.env.COMPOSE_PROJECT_NAME || 'cloud-self-healing-system',
    'com.docker.compose.service': actionConfig.target,
    'com.docker.compose.container-number': String(replicaNumber),
    'com.docker.compose.oneoff': 'False'
  };
  const replica = await docker.createContainer({
    name: `${process.env.COMPOSE_PROJECT_NAME || 'cloud-self-healing-system'}-${actionConfig.target}-${replicaNumber}`,
    Image: source.Config.Image,
    Env: source.Config.Env,
    Cmd: source.Config.Cmd,
    Entrypoint: source.Config.Entrypoint,
    WorkingDir: source.Config.WorkingDir,
    User: source.Config.User,
    ExposedPorts: source.Config.ExposedPorts,
    Healthcheck: source.Config.Healthcheck,
    Labels: labels,
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
    NetworkingConfig: {
      EndpointsConfig: {
        [networkName]: { Aliases: [actionConfig.target] }
      }
    }
  });
  await replica.start();
  return { status: 'executed', message: `${actionConfig.target} scaled from ${currentReplicas} to ${replicaNumber} replicas.` };
}

async function executeRecoveryAction(actionConfig, config = recoveryConfig) {
  validateAction(actionConfig);
  if (actionConfig.action === 'scale_service') return scaleService(actionConfig, config);

  const containers = await getServiceContainers(actionConfig.target, true);
  if (!containers.length) throw new Error(`No running containers found for ${actionConfig.target}.`);
  await Promise.all(containers.map((container) => docker.getContainer(container.Id).restart({ t: 10 })));
  return { status: 'executed', message: `${actionConfig.target} restarted successfully.` };
}

module.exports = {
  decideRecoveryAction,
  executeRecoveryAction,
  getCurrentReplicas,
  getServiceContainers,
  getRecoveryConfig,
  updateRecoveryConfig,
  validateAction,
  ALLOWED_ACTIONS,
  ALLOWED_TARGETS,
  SCALABLE_TARGETS,
  ABSOLUTE_MAX_REPLICAS
};
