const axios = require('axios');
const Docker = require('dockerode');
const { client } = require('../config/db');

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
const POLL_INTERVAL_MS = Number(process.env.MONITORING_INTERVAL_MS || 5000);
const PROBE_TIMEOUT_MS = Number(process.env.MONITORING_PROBE_TIMEOUT_MS || 3000);
const RETENTION_DAYS = Number(process.env.MONITORING_RETENTION_DAYS || 7);
const LOAD_GENERATOR_URL = process.env.LOAD_GENERATOR_URL || 'http://load-generator:8004';
let lastCollectionAt = null;
let lastCollectionError = null;
const SERVICES = [
  { name: 'payment-service', healthUrl: 'http://payment-service:8002/health' },
  { name: 'order-service', healthUrl: 'http://order-service:8001/health' },
  { name: 'user-service', healthUrl: 'http://user-service:8003/health' },
  { name: 'load-generator', healthUrl: `${LOAD_GENERATOR_URL}/health` }
];

function calculateCpuPercent(stats) {
  const cpuDelta = Number(stats.cpu_stats?.cpu_usage?.total_usage || 0) - Number(stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = Number(stats.cpu_stats?.system_cpu_usage || 0) - Number(stats.precpu_stats?.system_cpu_usage || 0);
  const onlineCpus = Number(stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1);
  if (cpuDelta <= 0 || systemDelta <= 0) return 0;
  return Number(((cpuDelta / systemDelta) * onlineCpus * 100).toFixed(2));
}

function calculateMemory(stats) {
  const memoryStats = stats.memory_stats || {};
  const rawUsage = Number(memoryStats.usage || 0);
  const cache = Number(memoryStats.stats?.cache || 0);
  const used = Math.max(0, rawUsage - cache);
  const limit = Number(memoryStats.limit || 0);
  return {
    used,
    limit,
    percent: limit > 0 ? Number(((used / limit) * 100).toFixed(2)) : null
  };
}

async function probeHealth(service) {
  const started = process.hrtime.bigint();
  try {
    const response = await axios.get(service.healthUrl, {
      timeout: PROBE_TIMEOUT_MS,
      validateStatus: () => true
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      latencyMs: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(2)),
      statusCode: response.status,
      error: response.status >= 200 && response.status < 300 ? null : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      statusCode: error.response?.status || null,
      error: error.code === 'ECONNABORTED' ? 'Probe timed out' : error.message
    };
  }
}

async function collectContainer(service, containerInfo, probe, loadMetrics = null) {
  const container = docker.getContainer(containerInfo.Id);
  let inspect;

  try {
    inspect = await container.inspect();
  } catch (error) {
    return {
      serviceName: service.name,
      containerId: containerInfo.Id,
      containerName: containerInfo.Names?.[0]?.replace(/^\//, '') || null,
      lifecycleState: 'unavailable',
      healthStatus: 'unavailable',
      lastError: error.message,
      probe,
      loadMetrics
    };
  }

  const baseSample = {
    serviceName: service.name,
    containerId: inspect.Id,
    containerName: inspect.Name?.replace(/^\//, '') || null,
    lifecycleState: inspect.State?.Status || 'unknown',
    healthStatus: inspect.State?.Health?.Status || (inspect.State?.Running ? 'unavailable' : 'unavailable'),
    uptimeSeconds: inspect.State?.Running && inspect.State?.StartedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(inspect.State.StartedAt).getTime()) / 1000))
      : 0,
    restartCount: Number(inspect.RestartCount || 0),
    lastError: inspect.State?.Error || null,
    probe,
    loadMetrics
  };

  if (!inspect.State?.Running) {
    return { ...baseSample, cpuPercent: null, memoryUsedBytes: null, memoryLimitBytes: null, memoryPercent: null };
  }

  let stats;
  try {
    stats = await inspectState(container);
  } catch (error) {
    return { ...baseSample, cpuPercent: null, memoryUsedBytes: null, memoryLimitBytes: null, memoryPercent: null, lastError: error.message };
  }

  const memory = calculateMemory(stats);
  return {
    ...baseSample,
    cpuPercent: calculateCpuPercent(stats),
    memoryUsedBytes: memory.used,
    memoryLimitBytes: memory.limit,
    memoryPercent: memory.percent,
    probe,
    loadMetrics
  };
}

async function inspectState(container) {
  return container.stats({ stream: false });
}

async function listServiceContainers(serviceName) {
  return docker.listContainers({ all: true, filters: { label: [`com.docker.compose.service=${serviceName}`] } });
}

async function insertMonitoringSample(sample) {
  await client.query(
    `INSERT INTO monitoring_samples
      (service_name, container_id, container_name, lifecycle_state, health_status, uptime_seconds, restart_count, last_error,
       cpu_percent, memory_used_bytes, memory_limit_bytes, memory_percent, probe_latency_ms, probe_status_code, probe_ok, probe_error,
       load_active, load_target_service, load_scenario, load_requests_per_second, load_total_requests, load_successful_requests,
       load_failed_requests, load_current_requests_per_second, load_average_latency_ms, load_max_latency_ms, load_min_latency_ms, load_error_rate)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)`,
    [sample.serviceName, sample.containerId, sample.containerName, sample.lifecycleState, sample.healthStatus,
      sample.uptimeSeconds, sample.restartCount, sample.lastError, sample.cpuPercent, sample.memoryUsedBytes,
      sample.memoryLimitBytes, sample.memoryPercent, sample.probe.latencyMs, sample.probe.statusCode,
      sample.probe.ok, sample.probe.error, sample.loadMetrics?.active ?? null, sample.loadMetrics?.targetService ?? null,
      sample.loadMetrics?.scenario ?? null, sample.loadMetrics?.requestsPerSecond ?? null, sample.loadMetrics?.totalRequests ?? null,
      sample.loadMetrics?.successfulRequests ?? null, sample.loadMetrics?.failedRequests ?? null,
      sample.loadMetrics?.currentRequestsPerSecond ?? null, sample.loadMetrics?.averageLatencyMs ?? null,
      sample.loadMetrics?.maxLatencyMs ?? null, sample.loadMetrics?.minLatencyMs ?? null, sample.loadMetrics?.errorRate ?? null]
  );
}

async function pruneMonitoringSamples() {
  await client.query(`DELETE FROM monitoring_samples WHERE collected_at < NOW() - ($1 * INTERVAL '1 day')`, [RETENTION_DAYS]);
}

async function getServiceStatus() {
  await docker.ping();
  const statuses = [];

  for (const service of SERVICES) {
    const containers = await listServiceContainers(service.name);
    if (!containers.length) {
      statuses.push({
        service: service.name,
        state: 'unavailable',
        health: 'unavailable',
        containers: [],
        error: 'No matching Docker container found'
      });
      continue;
    }

    const details = await Promise.all(containers.map(async (containerInfo) => {
      const inspect = await docker.getContainer(containerInfo.Id).inspect();
      const probeHistory = await client.query(
        `SELECT
           MAX(collected_at) FILTER (WHERE probe_ok = TRUE) AS last_successful_health_check,
           MAX(collected_at) FILTER (WHERE probe_ok = FALSE) AS last_failed_health_check,
           (ARRAY_AGG(probe_error ORDER BY collected_at DESC) FILTER (WHERE probe_ok = FALSE))[1] AS last_probe_error
         FROM monitoring_samples WHERE container_id = $1`,
        [inspect.Id]
      );
      const latestProbe = probeHistory.rows[0] || {};
      return {
        id: inspect.Id,
        name: inspect.Name?.replace(/^\//, '') || null,
        state: inspect.State?.Status || 'unknown',
        health: inspect.State?.Health?.Status || 'unavailable',
        uptimeSeconds: inspect.State?.Running && inspect.State?.StartedAt
          ? Math.max(0, Math.floor((Date.now() - new Date(inspect.State.StartedAt).getTime()) / 1000))
          : 0,
        restartCount: Number(inspect.RestartCount || 0),
        lastError: inspect.State?.Error || null,
        startedAt: inspect.State?.StartedAt || null,
        lastSuccessfulHealthCheck: latestProbe.last_successful_health_check || null,
        lastFailedHealthCheck: latestProbe.last_failed_health_check || null,
        lastProbeError: latestProbe.last_probe_error || null
      };
    }));

    statuses.push({
      service: service.name,
      state: details.every((item) => item.state === 'running') ? 'running' : details[0].state,
      health: details.every((item) => item.health === 'healthy') ? 'healthy' : details.some((item) => item.health === 'starting') ? 'starting' : details[0].health,
      containers: details
    });
  }

  return statuses;
}

function getCollectorHealth() {
  return { lastCollectionAt, lastCollectionError, intervalMs: POLL_INTERVAL_MS };
}

async function collectMetrics(onSample) {
  lastCollectionError = null;
  const results = [];
  for (const service of SERVICES) {
    let loadMetrics = null;
    if (service.name === 'load-generator') {
      try {
        const response = await axios.get(`${LOAD_GENERATOR_URL}/metrics`, { timeout: PROBE_TIMEOUT_MS });
        loadMetrics = response.data;
      } catch (error) {
        lastCollectionError = `Load-generator metrics unavailable: ${error.message}`;
      }
    }
    const [containers, probe] = await Promise.all([
      listServiceContainers(service.name),
      probeHealth(service)
    ]);
    if (!containers.length) {
      const unavailable = {
        serviceName: service.name,
        containerId: null,
        containerName: null,
        lifecycleState: 'unavailable',
        healthStatus: 'unavailable',
        uptimeSeconds: 0,
        restartCount: null,
        lastError: 'No matching Docker container found',
        cpuPercent: null,
        memoryUsedBytes: null,
        memoryLimitBytes: null,
        memoryPercent: null,
        probe,
        loadMetrics
      };
      results.push(unavailable);
      try {
        await insertMonitoringSample(unavailable);
      } catch (error) {
        lastCollectionError = `Database persistence failed: ${error.message}`;
      }
      if (onSample) Promise.resolve(onSample(unavailable)).catch((error) => console.error(`Anomaly detection failed: ${error.message}`));
      continue;
    }
    for (const container of containers) {
      const sample = await collectContainer(service, container, probe, loadMetrics);
      results.push(sample);
      try {
        await insertMonitoringSample(sample);
      } catch (error) {
        lastCollectionError = `Database persistence failed: ${error.message}`;
      }
      if (onSample) Promise.resolve(onSample(sample)).catch((error) => console.error(`Anomaly detection failed: ${error.message}`));
    }
  }
  try {
    await pruneMonitoringSamples();
  } catch (error) {
    lastCollectionError = `Database retention cleanup failed: ${error.message}`;
  }
  lastCollectionAt = new Date().toISOString();
  return results;
}

async function collectServiceMetrics(serviceName) {
  const service = SERVICES.find((entry) => entry.name === serviceName);
  if (!service) throw new Error(`Unknown monitored service: ${serviceName}`);

  let loadMetrics = null;
  if (service.name === 'load-generator') {
    const response = await axios.get(`${LOAD_GENERATOR_URL}/metrics`, { timeout: PROBE_TIMEOUT_MS });
    loadMetrics = response.data;
  }
  const [containers, probe] = await Promise.all([
    listServiceContainers(service.name),
    probeHealth(service)
  ]);
  const samples = containers.length
    ? await Promise.all(containers.map((container) => collectContainer(service, container, probe, loadMetrics)))
    : [{
      serviceName: service.name,
      containerId: null,
      containerName: null,
      lifecycleState: 'unavailable',
      healthStatus: 'unavailable',
      uptimeSeconds: 0,
      restartCount: null,
      lastError: 'No matching Docker container found',
      cpuPercent: null,
      memoryUsedBytes: null,
      memoryLimitBytes: null,
      memoryPercent: null,
      probe,
      loadMetrics
    }];

  for (const sample of samples) {
    try {
      await insertMonitoringSample(sample);
    } catch (error) {
      lastCollectionError = `Database persistence failed: ${error.message}`;
      throw error;
    }
  }
  lastCollectionAt = new Date().toISOString();
  return samples;
}

function startMetricsCollector(onSample, intervalMs = POLL_INTERVAL_MS) {
  if (typeof onSample !== 'function') {
    intervalMs = onSample || POLL_INTERVAL_MS;
    onSample = null;
  }
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      await collectMetrics(onSample);
    } catch (error) {
      lastCollectionError = error.message;
      console.error(`Monitoring collection failed: ${error.message}`);
    } finally {
      running = false;
    }
  };
  poll();
  return setInterval(poll, intervalMs);
}

module.exports = { startMetricsCollector, collectMetrics, collectServiceMetrics, calculateCpuPercent, calculateMemory, getServiceStatus, getCollectorHealth, SERVICES };
