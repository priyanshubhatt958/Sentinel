import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const serviceColors = {
  'payment-service': '#f97316',
  'order-service': '#3b82f6',
  'user-service': '#10b981'
};
const businessServices = Object.keys(serviceColors);

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Request failed: ${response.status}`);
  }
  return payload;
}

function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '0';
  }
  return Number(value).toFixed(digits);
}

function formatMetricTime(point) {
  const timestamp = [point.collected_at, point.created_at, point.timestamp]
    .find((value) => value !== null && value !== undefined && value !== '');
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

const lifecycleLabels = {
  manual_intervention_required: 'Manual intervention required',
  verification_pending: 'Verification pending',
  partially_recovered: 'Partially recovered',
  not_recovered: 'Not recovered',
  planned: 'Planned',
  skipped: 'Skipped',
  blocked: 'Blocked',
  recovered: 'Recovered',
  failed: 'Failed',
  expired: 'Expired'
};

function lifecycleLabel(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return lifecycleLabels[normalized]
    || normalized.split('_').filter(Boolean).map((word) => `${word[0].toUpperCase()}${word.slice(1)}`).join(' ')
    || 'Unknown';
}

const auditFieldGroups = [
  {
    title: 'Decision, safety & replica limits',
    fields: [
      [['root_cause', 'rootCause'], 'Root cause'],
      [['action_type', 'actionType', 'action'], 'Selected action'],
      [['decision_reason', 'decisionReason', 'reason'], 'Decision reason'],
      [['decision_confidence', 'decisionConfidence', 'confidence'], 'Decision confidence'],
      [['recommendation'], 'Recommendation'],
      [['safety', 'safety_details', 'safetyDetails'], 'Safety details'],
      [['safety_checks', 'safetyChecks'], 'Safety checks'],
      [['safety_check', 'safetyCheck', 'safety_status', 'safetyStatus', 'safety_reason', 'safetyReason'], 'Safety result'],
      [['replica_check', 'replicaCheck', 'replica_guard', 'replicaGuard', 'replica_limit_check', 'replicaLimitCheck'], 'Replica limit check'],
      [['replica_limit', 'replicaLimit'], 'Replica limit'],
      [['min_service_replicas', 'minServiceReplicas', 'min_replicas', 'minReplicas'], 'Minimum replicas'],
      [['max_service_replicas', 'maxServiceReplicas', 'max_replicas', 'maxReplicas'], 'Maximum replicas'],
      [['previous_replicas', 'previousReplicas'], 'Previous replicas'],
      [['new_replicas', 'newReplicas'], 'New replicas'],
      [['replica_change', 'replicaChange'], 'Replica change'],
      [['cooldown_started_at', 'cooldownStartedAt'], 'Cooldown started'],
      [['cooldown_until', 'cooldownUntil'], 'Cooldown until']
    ]
  },
  {
    title: 'Metrics & verification',
    fields: [
      [['before_metrics', 'beforeMetrics'], 'Before metrics'],
      [['after_metrics', 'afterMetrics'], 'After metrics'],
      [['verification_samples', 'verificationSamples', 'samples'], 'Verification samples'],
      [['samples_used', 'samplesUsed', 'verification_sample_count', 'verificationSampleCount', 'sample_count', 'sampleCount'], 'Verification sample count'],
      [['verification_window', 'verificationWindow', 'verification_window_ms', 'verificationWindowMs', 'verification_window_seconds', 'verificationWindowSeconds'], 'Verification window'],
      [['verification_started_at', 'verificationStartedAt', 'verification_window_start', 'verificationWindowStart', 'verification_window_started_at', 'verificationWindowStartedAt'], 'Verification started'],
      [['verification_completed_at', 'verificationCompletedAt', 'verification_window_end', 'verificationWindowEnd', 'verification_window_ended_at', 'verificationWindowEndedAt'], 'Verification completed'],
      [['effectiveness_by_metric', 'effectivenessByMetric'], 'Metric improvement details'],
      [['metric_improvements', 'metricImprovements'], 'Metric improvements'],
      [['effectiveness_score', 'effectivenessScore'], 'Effectiveness score']
    ]
  },
  {
    title: 'Execution',
    fields: [
      [['execution_details', 'executionDetails'], 'Execution details'],
      [['execution_started_at', 'executionStartedAt', 'started_at', 'startedAt'], 'Execution started'],
      [['execution_completed_at', 'executionCompletedAt', 'completed_at', 'completedAt'], 'Execution completed'],
      [['execution_result', 'executionResult', 'result'], 'Execution result'],
      [['execution_status', 'executionStatus'], 'Execution status'],
      [['message'], 'Execution message'],
      [['triggered_by', 'triggeredBy'], 'Triggered by'],
      [['created_at', 'createdAt', 'timestamp'], 'Record created'],
      [['updated_at', 'updatedAt'], 'Last updated']
    ]
  },
  {
    title: 'Errors',
    fields: [
      [['error_details', 'errorDetails', 'error'], 'Error details']
    ]
  }
];

function auditValue(record, keys) {
  return keys.map((key) => record?.[key]).find((value) => (
    value !== null && value !== undefined && value !== ''
  ));
}

function hasValue(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function hasMetricSnapshot(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).some((metric) => metric !== null && metric !== undefined);
}

function formatAuditValue(value, label) {
  if (value && typeof value === 'object') {
    return <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '0.35rem 0 0' }}>{JSON.stringify(value, null, 2)}</pre>;
  }
  if (/(started|completed|created|updated|until|timestamp)/i.test(label)) {
    return formatTimestamp(value);
  }
  return String(value);
}

function AuditDetails({ record }) {
  const beforeMetrics = auditValue(record, ['before_metrics', 'beforeMetrics']);
  const afterMetrics = auditValue(record, ['after_metrics', 'afterMetrics']);
  const hasMetrics = hasMetricSnapshot(beforeMetrics) || hasMetricSnapshot(afterMetrics);
  const status = String(record.status || record.recovery_status || record.recoveryStatus || '').toLowerCase();
  const reason = String(auditValue(record, ['decision_reason', 'decisionReason', 'reason', 'message']) || '');
  const decisionMessage = status === 'manual_intervention_required'
    ? reason.includes('Application-only recovery cannot repair')
      ? 'Database remediation required'
      : 'Manual intervention required'
    : status === 'skipped'
      ? 'No safe recovery action available'
      : status === 'blocked'
        ? reason.includes('maximum replica limit')
          ? 'Scaling blocked: maximum replica limit reached'
          : 'Recovery action blocked'
        : status === 'planned' ? 'Awaiting execution' : null;

  return (
    <div className="audit-details">
      {decisionMessage && !record.execution_details && !record.executionDetails && (
        <p className="muted" style={{ marginTop: 0 }}>{decisionMessage} · Decision-only action · No recovery action executed.</p>
      )}
      {!hasMetrics && (
        <p className="muted" style={{ marginTop: 0 }}>
          No before/after metric snapshots were recorded for this entry.
        </p>
      )}
      {auditFieldGroups.map((group) => {
        const fields = group.fields
          .map(([keys, label]) => ({ label, value: auditValue(record, keys) }))
          .filter(({ label, value }) => (
            label === 'Before metrics' || label === 'After metrics'
              ? hasMetricSnapshot(value)
              : hasValue(value)
          ));
        if (!fields.length) return null;
        return (
          <section className="audit-group" key={group.title}>
            <h4>{group.title}</h4>
            <dl className="audit-grid">
              {fields.map(({ label, value }) => (
                <div className="audit-field" key={label}>
                  <dt>{label}</dt>
                  <dd>{formatAuditValue(value, label)}</dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}

function StatusBadge({ value }) {
  const normalized = String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
  const palette = {
    healthy: { bg: '#dcfce7', text: '#166534' },
    warning: { bg: '#fef3c7', text: '#92400e' },
    critical: { bg: '#fee2e2', text: '#991b1b' },
    unhealthy: { bg: '#f3f4f6', text: '#374151' },
    recovered: { bg: '#dbeafe', text: '#1d4ed8' },
    partially_recovered: { bg: '#fef3c7', text: '#a16207' },
    partial: { bg: '#fef3c7', text: '#a16207' },
    not_recovered: { bg: '#fee2e2', text: '#991b1b' },
    manual_intervention_required: { bg: '#ffedd5', text: '#9a3412' },
    verification_pending: { bg: '#dbeafe', text: '#1d4ed8' },
    planned: { bg: '#e2e8f0', text: '#334155' },
    skipped: { bg: '#e2e8f0', text: '#334155' },
    blocked: { bg: '#fee2e2', text: '#991b1b' },
    expired: { bg: '#fef3c7', text: '#92400e' },
    degraded: { bg: '#fef3c7', text: '#92400e' },
    failed: { bg: '#fee2e2', text: '#991b1b' },
    unavailable: { bg: '#fee2e2', text: '#991b1b' },
    active: { bg: '#dcfce7', text: '#166534' },
    enabled: { bg: '#dcfce7', text: '#166534' },
    running: { bg: '#dcfce7', text: '#166534' },
    stopped: { bg: '#e2e8f0', text: '#334155' },
    disabled: { bg: '#e2e8f0', text: '#334155' }
  };

  const style = palette[normalized] || { bg: '#e2e8f0', text: '#334155' };

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.35rem 0.7rem',
        borderRadius: 999,
        background: style.bg,
        color: style.text,
        fontWeight: 700,
      }}
    >
      {lifecycleLabel(value)}
    </span>
  );
}

function hasSafeRecoveryAction(incident) {
  const type = incident.incident_type || incident.incidentType;
  const rootCause = incident.root_cause || incident.rootCause;
  if (type === 'database_bottleneck') return false;
  if (['traffic_spike', 'cpu_overload', 'memory_leak'].includes(type)) {
    return rootCause === 'payment-service';
  }
  if (type === 'network_failure') {
    const allowlisted = new Set(businessServices);
    return allowlisted.has(incident.service_name)
      || (incident.affected_services || []).some((service) => allowlisted.has(service));
  }
  return false;
}

function App() {
  const [serviceStatus, setServiceStatus] = useState([]);
  const [metricsByService, setMetricsByService] = useState({});
  const [incidents, setIncidents] = useState([]);
  const [loadStatus, setLoadStatus] = useState(null);
  const [simulationStatus, setSimulationStatus] = useState(null);
  const [monitoringHealth, setMonitoringHealth] = useState(null);
  const [loadForm, setLoadForm] = useState({
    targetService: 'payment-service',
    requestsPerSecond: 50,
    durationSeconds: 60,
    scenario: 'traffic-spike'
  });
  const [simulationDurationMs, setSimulationDurationMs] = useState(30000);
  const [recoveryActions, setRecoveryActions] = useState([]);
  const [expandedRecoveryActionId, setExpandedRecoveryActionId] = useState(null);
  const [recoveryConfig, setRecoveryConfig] = useState({
    autoRecoveryEnabled: false,
    maxActionsPerHour: 5,
    cooldownMs: 120000,
    maxActionsPerIncident: 3,
    maxActionsPerServicePerHour: 5,
    maxFailuresBeforeManual: 3,
    verificationDelayMs: 30000,
    verificationSamples: 6,
    maxServiceReplicas: 5,
    minServiceReplicas: 1
  });
  const [recoveringIncidentId, setRecoveringIncidentId] = useState(null);
  const [incidentDetail, setIncidentDetail] = useState(null);
  const [loadingIncidentDetail, setLoadingIncidentDetail] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const [dependencyGraph, setDependencyGraph] = useState({
    nodes: ['frontend', 'monitoring-backend', 'load-generator', 'user-service', 'order-service', 'payment-service', 'database', 'ml-service'],
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
  const [selectedDependency, setSelectedDependency] = useState('payment-service');
  const [selectedService, setSelectedService] = useState('payment-service');
  const [loading, setLoading] = useState(true);
  const [simulating, setSimulating] = useState(false);
  const [error, setError] = useState('');
  const [lastRefreshAt, setLastRefreshAt] = useState(null);
  const [stale, setStale] = useState(false);
  const requestInFlight = useRef(false);

  const loadDashboard = async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      setLoading(true);
      const [statusResponse, incidentsResponse] = await Promise.all([
        fetchJson(`${API_BASE}/api/services/status`),
        fetchJson(`${API_BASE}${activeOnly ? '/api/incidents/active' : '/api/incidents'}`)
      ]);
      const graphResponse = await fetchJson(`${API_BASE}/api/dependency-graph`).catch(() => null);
      const loadResponse = await fetchJson(`${API_BASE}/api/load/status`).catch(() => null);
      const [recoveryConfigResponse, recoveryActionsResponse, simulationResponse, healthResponse] = await Promise.all([
        fetchJson(`${API_BASE}/api/recovery/config`).catch(() => null),
        fetchJson(`${API_BASE}/api/recovery/actions`).catch(() => []),
        fetchJson(`${API_BASE}/api/simulations/status`).catch(() => null),
        fetchJson(`${API_BASE}/api/monitoring/health`).catch(() => null)
      ]);

      setServiceStatus(statusResponse.services || []);
      setIncidents(incidentsResponse || []);
      if (graphResponse?.nodes && graphResponse?.edges) {
        setDependencyGraph(graphResponse);
      }
      if (loadResponse) setLoadStatus(loadResponse);
      setSimulationStatus(simulationResponse);
      setMonitoringHealth(healthResponse);
      if (recoveryConfigResponse) setRecoveryConfig(recoveryConfigResponse);
      setRecoveryActions(recoveryActionsResponse || []);

      const metricsMap = {};
      for (const service of businessServices) {
        try {
          const response = await fetchJson(`${API_BASE}/api/metrics/history?service=${service}&minutes=30`);
          metricsMap[service] = response || [];
        } catch {
          metricsMap[service] = [];
        }
      }
      setMetricsByService(metricsMap);
      setError('');
      setStale(false);
      setLastRefreshAt(new Date());
    } catch (loadError) {
      setError(loadError.message || 'Unable to load dashboard data.');
      setStale(true);
    } finally {
      setLoading(false);
      requestInFlight.current = false;
    }
  };

  useEffect(() => {
    loadDashboard();
    const interval = setInterval(loadDashboard, 5000);
    return () => clearInterval(interval);
  }, [activeOnly]);

  const latestMetrics = useMemo(() => {
    const values = {};
    for (const service of businessServices) {
      const list = metricsByService[service] || [];
      values[service] = list[list.length - 1] || null;
    }
    return values;
  }, [metricsByService]);

  const selectedHistory = metricsByService[selectedService] || [];
  const selectedDependencies = dependencyGraph.edges
    .filter((edge) => edge.source === selectedDependency)
    .map((edge) => edge.target);
  const selectedDependents = dependencyGraph.edges
    .filter((edge) => edge.target === selectedDependency)
    .map((edge) => edge.source);
  const activeRecoveryStatuses = new Set([
    'pending', 'open', 'planned', 'executing', 'executed',
    'verification_pending', 'in_progress', 'partially_recovered',
    'not_recovered', 'blocked', 'skipped', 'manual_intervention_required'
  ]);
  const currentIncidentCutoff = Date.now() - 30 * 60 * 1000;
  const currentIncidents = incidents.filter((incident) => {
    const updatedAt = new Date(incident.updated_at || incident.created_at).getTime();
    return activeRecoveryStatuses.has(incident.recovery_status) && updatedAt >= currentIncidentCutoff;
  });
  const recentRecoveryActions = recoveryActions.filter((action) => {
    const createdAt = new Date(action.created_at).getTime();
    return createdAt >= currentIncidentCutoff && ![
      'skipped', 'blocked', 'manual_intervention_required', 'no_safe_action',
      'max_replicas_reached', 'requires_database_remediation', 'rate_limited', 'cooldown'
    ].includes(action.status);
  });

  const chartData = selectedHistory.map((point, index) => ({
    index,
    time: formatMetricTime(point),
    latency: Number(point.probe_latency_ms || 0),
    cpu: Number(point.cpu_percent || 0),
    memory: Number(point.memory_percent || 0),
    probeFailed: point.probe_ok === false ? 1 : 0
  }));

  const systemHealth = currentIncidents.length === 0
    && serviceStatus.filter((entry) => entry.service !== 'database').every((entry) => entry.state === 'running' && entry.health === 'healthy')
    ? 'Stable'
    : 'Attention';

  const selectedProbeFailures = selectedHistory.filter((point) => point.probe_ok === false).length;

  const triggerSimulation = async (endpoint, body = {}) => {
    try {
      setSimulating(true);
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Simulation failed.');
      await loadDashboard();
    } catch (simulationError) {
      setError(simulationError.message || 'Simulation failed.');
    } finally {
      setSimulating(false);
    }
  };

  const startTrafficLoad = async () => {
    try {
      setSimulating(true);
      const response = await fetch(`${API_BASE}/api/load/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...loadForm,
          requestsPerSecond: Number(loadForm.requestsPerSecond),
          durationSeconds: Number(loadForm.durationSeconds)
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to start load generation.');
      setLoadStatus(payload.run || payload);
      setError('');
    } catch (loadError) {
      setError(loadError.message || 'Unable to start load generation.');
    } finally {
      setSimulating(false);
    }
  };

  const stopTrafficLoad = async () => {
    try {
      setSimulating(true);
      const response = await fetch(`${API_BASE}/api/load/stop`, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to stop load generation.');
      setLoadStatus(payload.run || payload);
    } catch (loadError) {
      setError(loadError.message || 'Unable to stop load generation.');
    } finally {
      setSimulating(false);
    }
  };

  const toggleAutomaticRecovery = async (event) => {
    const autoRecoveryEnabled = event.target.checked;
    try {
      const response = await fetch(`${API_BASE}/api/recovery/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoRecoveryEnabled })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to update recovery configuration.');
      setRecoveryConfig(payload);
      setError('');
    } catch (configError) {
      setError(configError.message || 'Unable to update recovery configuration.');
    }
  };

  const recoverIncident = async (incidentId) => {
    try {
      setRecoveringIncidentId(incidentId);
      const response = await fetch(`${API_BASE}/api/incidents/${incidentId}/recover`, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || payload.error || 'Manual recovery failed.');
      await loadDashboard();
      if (incidentDetail?.id === incidentId) await openIncidentDetail(incidentId);
    } catch (recoveryError) {
      setError(recoveryError.message || 'Manual recovery failed.');
    } finally {
      setRecoveringIncidentId(null);
    }
  };

  const openIncidentDetail = async (incidentId) => {
    try {
      setLoadingIncidentDetail(true);
        const [incident, summary, timeline, auditRecords] = await Promise.all([
        fetchJson(`${API_BASE}/api/incidents/${incidentId}`),
        fetchJson(`${API_BASE}/api/incidents/${incidentId}/summary`),
        fetchJson(`${API_BASE}/api/incidents/${incidentId}/recovery-timeline`),
        fetchJson(`${API_BASE}/api/recovery/actions?incidentId=${encodeURIComponent(incidentId)}`).catch(() => [])
      ]);
      const timelineWithAudit = Array.isArray(timeline)
        ? timeline.map((entry) => ({
          ...(auditRecords.find((record) => String(record.id) === String(entry.id)) || {}),
          ...entry
        }))
        : timeline;
      setIncidentDetail({ ...incident, summary, timeline: timelineWithAudit });
      setError('');
    } catch (detailError) {
      setError(detailError.message || 'Unable to load incident details.');
    } finally {
      setLoadingIncidentDetail(false);
    }
  };

  const incidentAffectedServices = new Set(currentIncidents.flatMap((incident) => incident.affected_services || []));
  const incidentRootCauses = new Set(currentIncidents.map((incident) => incident.root_cause).filter(Boolean));
  const recoveryTargets = new Set(recentRecoveryActions.map((action) => action.target_service));

  const dependencyStatus = (node) => {
    if (incidentDetail?.root_cause === node || incidentRootCauses.has(node)) return 'critical';
    if (recoveryTargets.has(node)) return 'recovery-target';
    if (incidentAffectedServices.has(node)) return 'incident-affected';
    if (node === 'ml-service') return monitoringHealth?.mlIntegration?.available === false ? 'unavailable' : 'healthy';
    if (node === 'monitoring-backend') return monitoringHealth?.status || 'unavailable';
    if (node === 'load-generator') return loadStatus?.active ? 'healthy' : 'degraded';
    if (node === 'frontend') return 'healthy';
    const service = serviceStatus.find((entry) => entry.service === node);
    if (service?.health === 'healthy') return 'healthy';
    if (service?.state === 'unavailable' || !service) return 'unavailable';
    return 'degraded';
  };

  const dependencyColors = {
    healthy: '#16a34a',
    degraded: '#ca8a04',
    unavailable: '#dc2626',
    critical: '#dc2626',
    'incident-affected': '#ea580c',
    'recovery-target': '#2563eb'
  };

  return (
    <>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; font-family: Inter, Arial, sans-serif; background: #f8fafc; color: #0f172a; }
        .page { padding: 2rem; max-width: 1400px; margin: 0 auto; }
        .topbar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
        .title { font-size: 2rem; font-weight: 800; margin: 0; }
        .subtitle { color: #475569; margin: 0.25rem 0 0; }
        .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
        .card { background: white; border: 1px solid #e2e8f0; border-radius: 18px; padding: 1rem 1.1rem; box-shadow: 0 8px 25px rgba(15, 23, 42, 0.04); }
        .stat-label { font-size: 0.8rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; }
        .stat-value { font-size: 1.8rem; font-weight: 800; margin-top: 0.4rem; }
        .panel { background: white; border: 1px solid #e2e8f0; border-radius: 18px; padding: 1rem 1.1rem; margin-bottom: 1.5rem; }
        .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
        .button-row { display: flex; flex-wrap: wrap; gap: 0.75rem; }
        .load-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; }
        .load-stat { padding: 0.75rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; }
        .load-stat strong { display: block; margin-top: 0.25rem; font-size: 1.1rem; }
        .recovery-config { display: flex; align-items: center; gap: 0.65rem; font-weight: 700; }
        .action-btn { border: none; border-radius: 10px; padding: 0.7rem 1rem; background: #0f172a; color: white; cursor: pointer; font-weight: 700; transition: transform 180ms ease, box-shadow 180ms ease, background-color 180ms ease, color 180ms ease; }
        .action-btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 6px 14px rgba(15, 23, 42, 0.16); }
        .action-btn:active:not(:disabled) { transform: translateY(0) scale(0.98); box-shadow: 0 2px 5px rgba(15, 23, 42, 0.12); }
        .action-btn:focus-visible { outline: 3px solid #38bdf8; outline-offset: 3px; }
        .action-btn:disabled { cursor: wait; opacity: 0.65; }
        .action-btn.secondary { background: #e2e8f0; color: #0f172a; }
        @media (prefers-reduced-motion: reduce) { .action-btn { transition: none; } }
        .grid { display: grid; grid-template-columns: 2fr 1fr; gap: 1.25rem; }
        .dependency-list { display: grid; gap: 0.25rem; }
        .dependency-node { width: 100%; padding: 0.7rem 0.8rem; border: 1px solid #cbd5e1; border-radius: 8px; background: #f8fafc; color: #0f172a; text-align: left; font: inherit; font-weight: 700; cursor: pointer; transition: background-color 160ms ease, border-color 160ms ease, transform 160ms ease; }
        .dependency-node:hover { transform: translateX(2px); border-color: #0f766e; }
        .dependency-node:focus-visible { outline: 3px solid #0f766e; outline-offset: 2px; }
        .dependency-node.selected { background: #ccfbf1; border-color: #0f766e; }
        .dependency-arrow { color: #64748b; padding: 0.15rem 0.8rem; line-height: 1; }
        .dependency-node { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; }
        .node-state { width: 0.7rem; height: 0.7rem; border-radius: 50%; flex: 0 0 auto; }
        .control-row { display: flex; flex-wrap: wrap; align-items: end; gap: 0.75rem; margin-bottom: 0.9rem; }
        .control-field { display: grid; gap: 0.3rem; color: #475569; font-size: 0.85rem; font-weight: 700; }
        .control-field input, .control-field select { min-width: 130px; padding: 0.55rem; border: 1px solid #cbd5e1; border-radius: 8px; color: #0f172a; background: white; }
        .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 0.75rem; }
        .detail-item { padding: 0.75rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; overflow-wrap: anywhere; }
        .timeline-item { border-left: 3px solid #0f766e; padding: 0.25rem 0 0.75rem 0.9rem; margin: 0.5rem 0; }
        .audit-details { margin-top: 0.75rem; padding: 0.75rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; }
        .audit-group + .audit-group { margin-top: 0.8rem; }
        .audit-group h4 { margin: 0 0 0.45rem; color: #334155; }
        .audit-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 0.55rem; margin: 0; }
        .audit-field { min-width: 0; padding: 0.55rem; background: white; border: 1px solid #e2e8f0; border-radius: 8px; overflow-wrap: anywhere; }
        .audit-field dt { color: #64748b; font-size: 0.76rem; font-weight: 700; }
        .audit-field dd { margin: 0.25rem 0 0; }
        .expand-action { border: 0; padding: 0; background: transparent; color: #0369a1; font: inherit; font-weight: 700; cursor: pointer; text-align: left; }
        .expand-action:focus-visible { outline: 3px solid #38bdf8; outline-offset: 3px; }
        .recovery-detail-row td { padding: 0.75rem; background: #f8fafc; }
        @media (prefers-reduced-motion: reduce) { .dependency-node { transition: none; } }
        .service-list { display: grid; gap: 0.8rem; }
        .service-item { display: flex; justify-content: space-between; align-items: center; padding: 0.85rem 1rem; border: 1px solid #e2e8f0; border-radius: 12px; cursor: pointer; }
        .service-item.active { border-color: #38bdf8; background: #f0f9ff; }
        .meter { margin-top: 0.75rem; height: 8px; background: #e2e8f0; border-radius: 999px; overflow: hidden; }
        .meter-fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, #22c55e, #f59e0b, #ef4444); }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 0.75rem 0.5rem; border-bottom: 1px solid #e2e8f0; text-align: left; }
        th { font-size: 0.78rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; }
        .muted { color: #64748b; }
        @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
      `}</style>

      <div className="page">
        <div className="topbar">
          <div>
            <h1 className="title">AI-Powered Self-Healing Cloud Application</h1>
            <p className="subtitle">Anomaly detection, dependency-aware root cause analysis, and automated recovery.</p>
          </div>
          <StatusBadge value={systemHealth} />
        </div>

        {error && (
          <div className="panel" style={{ borderColor: '#fca5a5', background: '#fff1f2' }}>
            <strong>Connection issue:</strong> {error}
          </div>
        )}

        <div className="muted" style={{ marginBottom: '1rem' }} aria-live="polite">
          {stale ? 'Showing last known data; monitoring backend is unavailable.' : `Last refresh: ${lastRefreshAt ? lastRefreshAt.toLocaleTimeString() : 'loading...'}`}
        </div>

        <div className="cards">
          <div className="card">
            <div className="stat-label">Overall health</div>
            <div className="stat-value">{loading ? '...' : systemHealth}</div>
          </div>
          <div className="card">
            <div className="stat-label">Open incidents</div>
            <div className="stat-value">{incidents.length}</div>
          </div>
          <div className="card">
            <div className="stat-label">Payment CPU / memory</div>
            <div className="stat-value">{formatNumber(latestMetrics['payment-service']?.cpu_percent, 0)}% / {formatNumber(latestMetrics['payment-service']?.memory_percent, 0)}%</div>
          </div>
          <div className="card">
            <div className="stat-label">Payment request rate</div>
            <div className="stat-value">{formatNumber(latestMetrics['payment-service']?.requests_per_second, 1)} req/s</div>
          </div>
          <div className="card">
            <div className="stat-label">Payment error rate</div>
            <div className="stat-value">{formatNumber(latestMetrics['payment-service']?.service_error_rate, 2)}%</div>
          </div>
          <div className="card">
            <div className="stat-label">Payment probe latency</div>
            <div className="stat-value">{formatNumber(latestMetrics['payment-service']?.probe_latency_ms, 0)} ms</div>
          </div>
          <div className="card">
            <div className="stat-label">Database</div>
            <div className="stat-value">{serviceStatus.find((entry) => entry.service === 'database')?.health || 'unknown'}</div>
          </div>
          <div className="card">
            <div className="stat-label">ML integration</div>
            <div className="stat-value">{monitoringHealth?.mlIntegration?.available === false ? 'Unavailable' : monitoringHealth?.mlIntegration?.available ? 'Ready' : 'Unknown'}</div>
          </div>
          <div className="card">
            <div className="stat-label">Load generator</div>
            <div className="stat-value">{loadStatus?.active ? 'Active' : 'Stopped'}</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2 style={{ margin: 0 }}>Recovery configuration</h2>
            <StatusBadge value={recoveryConfig.autoRecoveryEnabled ? 'enabled' : 'disabled'} />
          </div>
          <label className="recovery-config">
            <input
              type="checkbox"
              checked={recoveryConfig.autoRecoveryEnabled}
              onChange={toggleAutomaticRecovery}
            />
            Enable Automatic Recovery
          </label>
          <div className="muted" style={{ marginTop: '0.5rem' }}>
            Limit: {recoveryConfig.maxActionsPerHour} automatic actions/hour · {recoveryConfig.maxActionsPerIncident} per incident · {recoveryConfig.maxActionsPerServicePerHour} per service/hour · Cooldown: {Math.round(recoveryConfig.cooldownMs / 1000)}s · Verification: {recoveryConfig.verificationDelayMs / 1000}s / {recoveryConfig.verificationSamples} samples · Replicas: {recoveryConfig.minServiceReplicas}–{recoveryConfig.maxServiceReplicas}
            <div className="muted" style={{ marginTop: '0.35rem' }}>Manual intervention after {recoveryConfig.maxFailuresBeforeManual} failed recovery attempts.</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2 style={{ margin: 0 }}>Simulation controls</h2>
            <StatusBadge value={simulationStatus?.active ? 'active' : simulating ? 'running' : 'stopped'} />
          </div>
          <div className="control-row">
            <label className="control-field">Duration (ms)
              <input type="number" min="1000" max="60000" step="1000" value={simulationDurationMs} onChange={(event) => setSimulationDurationMs(Number(event.target.value))} />
            </label>
          </div>
          <div className="button-row">
            <button className="action-btn" onClick={() => triggerSimulation('/api/simulate/traffic-spike', { durationMs: simulationDurationMs })} disabled={simulating}>Traffic spike</button>
            <button className="action-btn secondary" onClick={() => triggerSimulation('/api/simulate/database-overload', { durationMs: simulationDurationMs })} disabled={simulating}>Database overload</button>
            <button className="action-btn secondary" onClick={() => triggerSimulation('/api/simulate/memory-leak', { durationMs: simulationDurationMs })} disabled={simulating}>Memory leak</button>
            <button className="action-btn secondary" onClick={() => triggerSimulation('/api/simulate/cpu-overload', { durationMs: simulationDurationMs })} disabled={simulating}>CPU overload</button>
            <button className="action-btn secondary" onClick={() => triggerSimulation('/api/simulate/stop')} disabled={simulating}>Reset</button>
          </div>
          <div className="detail-grid" style={{ marginTop: '0.9rem' }}>
            {(simulationStatus?.services || []).flatMap((service) => (service.simulations || []).map((simulation) => (
              <div className="detail-item" key={`${service.service}-${simulation.type}`}>
                <strong>{service.service}: {simulation.type}</strong>
                <div className="muted">{service.available === false ? 'Service unavailable' : `${simulation.active ? 'Active' : 'Stopped'} · duration ${simulation.durationMs || 0} ms · cleanup ${simulation.cleanupStatus || 'unknown'}${simulation.endsAt ? ` · ends ${new Date(simulation.endsAt).toLocaleTimeString()}` : ''}`}</div>
              </div>
            )))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2 style={{ margin: 0 }}>Load Generator</h2>
            <StatusBadge value={loadStatus?.active ? 'active' : 'stopped'} />
          </div>
          <div className="muted" style={{ marginBottom: '0.8rem' }}>
            Target: {loadStatus?.targetService || 'none'} · Scenario: {loadStatus?.scenario || 'none'}
          </div>
          <div className="control-row">
            <label className="control-field">Target service
              <select value={loadForm.targetService} onChange={(event) => setLoadForm((current) => ({ ...current, targetService: event.target.value }))}>
                {[...businessServices, 'all'].map((service) => <option key={service} value={service}>{service}</option>)}
              </select>
            </label>
            <label className="control-field">Requests per second
              <input type="number" min="1" max="200" value={loadForm.requestsPerSecond} onChange={(event) => setLoadForm((current) => ({ ...current, requestsPerSecond: event.target.value }))} />
            </label>
            <label className="control-field">Duration (seconds)
              <input type="number" min="1" max="300" value={loadForm.durationSeconds} onChange={(event) => setLoadForm((current) => ({ ...current, durationSeconds: event.target.value }))} />
            </label>
            <label className="control-field">Scenario
              <select value={loadForm.scenario} onChange={(event) => setLoadForm((current) => ({ ...current, scenario: event.target.value }))}>
                <option value="normal">normal</option>
                <option value="traffic-spike">traffic-spike</option>
              </select>
            </label>
          </div>
          <div className="load-grid">
            <div className="load-stat">Requests/sec<strong>{loadStatus?.requestsPerSecond || 0}</strong></div>
            <div className="load-stat">Total requests<strong>{loadStatus?.totalRequests || 0}</strong></div>
            <div className="load-stat">Successful<strong>{loadStatus?.successfulRequests || 0}</strong></div>
            <div className="load-stat">Failed<strong>{loadStatus?.failedRequests || 0}</strong></div>
            <div className="load-stat">Avg latency<strong>{formatNumber(loadStatus?.averageLatencyMs, 0)} ms</strong></div>
            <div className="load-stat">Error rate<strong>{formatNumber(loadStatus?.errorRate, 2)}%</strong></div>
          </div>
          <div className="button-row" style={{ marginTop: '0.9rem' }}>
            <button className="action-btn" onClick={startTrafficLoad} disabled={simulating || loadStatus?.active}>Start Traffic Load</button>
            <button className="action-btn secondary" onClick={stopTrafficLoad} disabled={simulating || !loadStatus?.active}>Stop Load</button>
          </div>
        </div>

        <div className="grid">
          <div className="panel">
            <div className="panel-header">
              <h2 style={{ margin: 0 }}>Service overview</h2>
            </div>
            <div className="service-list">
              {['payment-service', 'order-service', 'user-service'].map((service) => {
                const metric = latestMetrics[service];
                const status = serviceStatus.find((item) => item.service === service);
                const health = status?.health || 'unavailable';
                const cpu = metric ? Number(metric.cpu_percent || 0) : 0;

                return (
                  <div
                    key={service}
                    className={`service-item ${selectedService === service ? 'active' : ''}`}
                    onClick={() => setSelectedService(service)}
                  >
                    <div>
                      <div style={{ fontWeight: 700 }}>{service}</div>
                      <div className="muted">Container: {status?.containers?.[0]?.id?.slice(0, 12) || 'unavailable'}</div>
                      <div className="muted">Probe: {metric?.probe_ok === false ? 'failed' : metric ? `${formatNumber(metric.probe_latency_ms, 0)} ms` : 'unavailable'}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <StatusBadge value={health} />
                      <div className="muted">{status?.state || 'unavailable'}</div>
                      <div className="meter"><div className="meter-fill" style={{ width: `${Math.min(cpu, 100)}%` }} /></div>
                      <div className="muted">CPU {formatNumber(cpu, 0)}%</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h2 style={{ margin: 0 }}>Dependency map</h2>
            </div>
            <div className="dependency-list" aria-label="Service dependency chain">
                {dependencyGraph.nodes.map((node) => {
                  const nodeStatus = dependencyStatus(node);
                return (
                  <div key={node}>
                    <button
                      type="button"
                      className={`dependency-node ${selectedDependency === node ? 'selected' : ''}`}
                      aria-pressed={selectedDependency === node}
                      onClick={() => {
                        setSelectedDependency(node);
                        if (businessServices.includes(node)) {
                          setSelectedService(node);
                        }
                      }}
                    >
                      {node}<span className="node-state" style={{ background: dependencyColors[nodeStatus] }} title={nodeStatus} />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="muted" style={{ marginTop: '0.75rem', lineHeight: 1.5 }} aria-live="polite">
              <div><strong>{selectedDependency}</strong></div>
              <div>Depends on: {selectedDependencies.length ? selectedDependencies.join(', ') : 'none'}</div>
              <div>Depended on by: {selectedDependents.length ? selectedDependents.join(', ') : 'none'}</div>
              <div style={{ marginTop: '0.35rem' }}>Status: {dependencyStatus(selectedDependency)}. Selecting a business service updates its metrics chart.</div>
              </div>
            </div>
          </div>

        <div className="panel">
          <div className="panel-header">
            <h2 style={{ margin: 0 }}>{selectedService} resilience trend</h2>
            <span className="muted">Failed probes: {selectedProbeFailures}</span>
          </div>
          <div style={{ width: '100%', height: 280 }}>
            <ResponsiveContainer>
              <LineChart data={chartData}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="5 5" />
                <XAxis dataKey="time" minTickGap={25} />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="latency" stroke="#ef4444" strokeWidth={2} name="Latency (ms)" />
                <Line type="monotone" dataKey="probeFailed" stroke="#f59e0b" strokeWidth={2} name="Probe failure (1/0)" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2 style={{ margin: 0 }}>Memory usage</h2>
          </div>
          <div style={{ width: '100%', height: 280 }}>
            <ResponsiveContainer>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="cpuFill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.1} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="5 5" />
                <XAxis dataKey="time" minTickGap={25} />
                <YAxis />
                <Tooltip />
                <Area type="monotone" dataKey="memory" stroke="#3b82f6" fill="url(#cpuFill)" name="Memory usage (%)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2 style={{ margin: 0 }}>Incident timeline</h2>
            <button className="action-btn secondary" onClick={() => setActiveOnly((current) => !current)}>
              {activeOnly ? 'Show All Incidents' : 'Active Incidents'}
            </button>
          </div>
          <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Type</th>
                <th>Root cause</th>
                <th>Risk</th>
                <th>Failure probability</th>
                <th>Anomaly score</th>
                <th>Detected by</th>
                <th>Features</th>
                <th>Created</th>
                <th>Recovery</th>
                <th>Action</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {incidents.length === 0 ? (
                <tr>
                  <td colSpan="12" className="muted">No incidents recorded yet.</td>
                </tr>
              ) : (
                incidents.slice(0, 8).map((incident) => (
                  <tr key={incident.id}>
                    <td>{incident.service_name || incident.service || 'unknown'}</td>
                    <td>{incident.incident_type || incident.incidentType || 'unknown'}</td>
                    <td>{incident.root_cause || incident.rootCause || 'unknown'}</td>
                    <td><StatusBadge value={incident.risk_level || incident.riskLevel || 'LOW'} /></td>
                    <td>{formatNumber(incident.failure_probability, 2)}</td>
                    <td>{formatNumber(incident.anomaly_score, 2)}</td>
                    <td>{Array.isArray(incident.detected_by) ? incident.detected_by.join(', ') : 'unknown'}</td>
                    <td>{Array.isArray(incident.contributing_features) ? incident.contributing_features.join(', ') : 'unknown'}</td>
                    <td>{incident.created_at ? new Date(incident.created_at).toLocaleString() : 'unknown'}</td>
                    <td><StatusBadge value={incident.recovery_status || incident.recoveryStatus || 'pending'} /></td>
                    <td>
                      {incident.action_status === 'requires_database_remediation' && (
                        <span className="muted">Database remediation required</span>
                      )}
                      {incident.manual_intervention_required && (
                        <span className="muted">Manual intervention required</span>
                      )}
                      {!incident.manual_intervention_required
                        && incident.action_status !== 'requires_database_remediation'
                        && !hasSafeRecoveryAction(incident)
                        && <span className="muted">No safe action / manual review</span>}
                      {!incident.manual_intervention_required
                        && hasSafeRecoveryAction(incident)
                        && ['pending', 'open', 'partially_recovered', 'not_recovered', 'expired'].includes(incident.recovery_status) && (
                        <button
                          className="action-btn secondary"
                          disabled={recoveringIncidentId === incident.id}
                          onClick={() => recoverIncident(incident.id)}
                        >
                          {recoveringIncidentId === incident.id ? 'Running...' : 'Recover'}
                        </button>
                      )}
                    </td>
                    <td>
                      <button
                        className="action-btn secondary"
                        disabled={loadingIncidentDetail}
                        onClick={() => openIncidentDetail(incident.id)}
                      >
                        {loadingIncidentDetail ? 'Loading...' : 'View details'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          </div>
        </div>

        {loadingIncidentDetail && <div className="panel" aria-live="polite">Loading incident details...</div>}
        {incidentDetail && (
          <section className="panel" aria-live="polite">
            <div className="panel-header">
              <div>
                <h2 style={{ margin: 0 }}>Incident #{incidentDetail.id}</h2>
                <span className="muted">{incidentDetail.service_name} · {incidentDetail.incident_type} · updated {incidentDetail.updated_at ? new Date(incidentDetail.updated_at).toLocaleString() : 'unknown'}</span>
              </div>
              <div className="button-row">
                <button className="action-btn secondary" onClick={() => openIncidentDetail(incidentDetail.id)} disabled={loadingIncidentDetail}>Refresh</button>
                <button className="action-btn secondary" onClick={() => setIncidentDetail(null)}>Close</button>
              </div>
            </div>
            <div className="detail-grid">
              <div className="detail-item"><strong>Status</strong><div><StatusBadge value={incidentDetail.recovery_status || 'pending'} /></div></div>
              <div className="detail-item"><strong>Risk level</strong><div>{incidentDetail.risk_level || 'unknown'}</div></div>
              <div className="detail-item"><strong>Anomaly score</strong><div>{formatNumber(incidentDetail.anomaly_score, 3)}</div></div>
              <div className="detail-item"><strong>Failure probability</strong><div>{formatNumber(incidentDetail.failure_probability, 3)}</div></div>
              <div className="detail-item"><strong>Classification</strong><div>{incidentDetail.incident_type || 'unknown'}</div></div>
              <div className="detail-item"><strong>Root cause</strong><div>{incidentDetail.root_cause || 'unknown'}</div></div>
              <div className="detail-item"><strong>Created</strong><div>{incidentDetail.created_at ? new Date(incidentDetail.created_at).toLocaleString() : 'unknown'}</div></div>
              <div className="detail-item"><strong>Recovery recommendation</strong><div>{incidentDetail.recoveryRecommendation?.recommendation || incidentDetail.recovery_recommendation || 'manual_intervention_required'}</div><div className="muted">{incidentDetail.recoveryRecommendation?.reason || ''}</div></div>
            </div>
            <h3>Incident evidence</h3>
            <div className="muted">{Array.isArray(incidentDetail.evidence) ? incidentDetail.evidence.map((entry, index) => <div key={index}>{typeof entry === 'string' ? entry : JSON.stringify(entry)}</div>) : JSON.stringify(incidentDetail.evidence || {})}</div>
            <div className="panel-header" style={{ marginTop: '1rem' }}>
              <h3 style={{ margin: 0 }}>Incident report · {incidentDetail.summary?.source === 'genai' ? 'GenAI' : 'local fallback'}</h3>
              <StatusBadge value={incidentDetail.summary?.recoveryResult?.status || incidentDetail.recovery_status || 'pending'} />
            </div>
            {incidentDetail.summary?.report
              ? Object.entries(incidentDetail.summary.report).map(([field, value]) => (
                <div className="detail-item" key={field} style={{ marginBottom: '0.5rem' }}>
                  <strong>{field.replace(/([A-Z])/g, ' $1')}</strong>
                  {Array.isArray(value) ? <ul>{value.map((entry, index) => <li key={index}>{entry}</li>)}</ul> : <div>{value}</div>}
                </div>
              ))
              : <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{incidentDetail.summary?.summary || 'Summary is not available yet.'}</pre>}
            <div className="button-row" style={{ marginTop: '0.75rem' }}>
              <button
                className="action-btn"
                disabled={Boolean(incidentDetail.manual_intervention_required)
                  || incidentDetail.recoveryRecommendation?.recommendation === 'database_remediation_required'
                  || !hasSafeRecoveryAction(incidentDetail)
                  || recoveringIncidentId === incidentDetail.id}
                onClick={() => recoverIncident(incidentDetail.id)}
              >
                {recoveringIncidentId === incidentDetail.id ? 'Recovering...' : 'Run manual recovery'}
              </button>
              {incidentDetail.manual_intervention_required && <span className="muted">Automated recovery is blocked; operator attention is required.</span>}
              {incidentDetail.recoveryRecommendation?.recommendation === 'database_remediation_required' && <span className="muted">Database incidents require database-level remediation.</span>}
              {!hasSafeRecoveryAction(incidentDetail) && incidentDetail.recoveryRecommendation?.recommendation !== 'database_remediation_required' && <span className="muted">No safe automated action is defined for this incident type.</span>}
            </div>
            <h3>Recovery timeline</h3>
            {incidentDetail.timeline?.length
              ? incidentDetail.timeline.map((entry) => (
                <div className="timeline-item" key={entry.id}>
                  <strong>{entry.action || entry.actionType || 'Recovery decision'} on {entry.targetService || 'unknown target'}</strong>
                  <div className="button-row" style={{ marginTop: '0.4rem' }}>
                    <StatusBadge value={entry.status || 'unknown'} />
                    <StatusBadge value={entry.recoveryStatus || 'unknown'} />
                  </div>
                  <div className="muted" style={{ marginTop: '0.4rem' }}>{formatTimestamp(entry.timestamp)} · {lifecycleLabel(entry.triggeredBy || 'unknown')}</div>
                  {hasValue(entry.reason) && <div style={{ marginTop: '0.4rem' }}>{entry.reason}</div>}
                  <details style={{ marginTop: '0.5rem' }}>
                    <summary>Full recovery audit details</summary>
                    <AuditDetails record={entry} />
                  </details>
                </div>
              ))
              : <div className="muted">No recovery action has been recorded for this incident.</div>}
          </section>
        )}

        <div className="panel">
          <div className="panel-header">
            <h2 style={{ margin: 0 }}>Recovery activity</h2>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Incident ID</th>
                  <th>Action</th>
                  <th>Target service</th>
                  <th>Replica change</th>
                  <th>Action / recovery status</th>
                  <th>Effectiveness</th>
                  <th>Triggered by</th>
                </tr>
              </thead>
              <tbody>
                {recoveryActions.length === 0 ? (
                  <tr><td colSpan="8" className="muted">No recovery actions recorded.</td></tr>
                ) : recoveryActions.slice(0, 10).map((action) => (
                  <Fragment key={action.id}>
                  <tr>
                      <td>
                        <button
                          type="button"
                          className="expand-action"
                          aria-expanded={expandedRecoveryActionId === action.id}
                          aria-controls={`recovery-audit-${action.id}`}
                          aria-label={`${expandedRecoveryActionId === action.id ? 'Collapse' : 'Expand'} audit details for recovery action ${action.id}`}
                          onClick={() => setExpandedRecoveryActionId((current) => current === action.id ? null : action.id)}
                        >
                          {formatTimestamp(action.created_at || action.timestamp)}
                          <span className="muted"> {expandedRecoveryActionId === action.id ? '−' : '+'}</span>
                        </button>
                      </td>
                      <td>{action.incident_id ?? action.incidentId ?? '—'}</td>
                      <td>{action.action_type || action.actionType || action.action || '—'}</td>
                      <td>{action.target_service || action.targetService || '—'}</td>
                      <td>
                        {action.previous_replicas != null || action.new_replicas != null
                          ? `${action.previous_replicas ?? '—'} → ${action.new_replicas ?? '—'}`
                          : '—'}
                      </td>
                      <td>
                        <div className="button-row">
                          <StatusBadge value={action.status || 'unknown'} />
                          {action.recovery_status || action.recoveryStatus
                            ? <StatusBadge value={action.recovery_status || action.recoveryStatus} />
                            : <span className="muted">Recovery: —</span>}
                        </div>
                      </td>
                      <td>{action.effectiveness_score != null && Number.isFinite(Number(action.effectiveness_score))
                        ? `${formatNumber(action.effectiveness_score, 1)}%`
                        : '—'}</td>
                      <td>{action.triggered_by || action.triggeredBy || '—'}</td>
                    </tr>
                    {expandedRecoveryActionId === action.id && (
                      <tr className="recovery-detail-row">
                        <td colSpan="8" id={`recovery-audit-${action.id}`}>
                          <AuditDetails record={action} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

export default App;
