import { useEffect, useMemo, useRef, useState } from 'react';
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

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '0';
  }
  return Number(value).toFixed(digits);
}

function StatusBadge({ value }) {
  const normalized = String(value || '').toLowerCase();
  const palette = {
    healthy: { bg: '#dcfce7', text: '#166534' },
    warning: { bg: '#fef3c7', text: '#92400e' },
    critical: { bg: '#fee2e2', text: '#991b1b' },
    unhealthy: { bg: '#f3f4f6', text: '#374151' },
    recovered: { bg: '#dbeafe', text: '#1d4ed8' },
    partial: { bg: '#fef3c7', text: '#a16207' }
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
        textTransform: 'capitalize'
      }}
    >
      {value || 'unknown'}
    </span>
  );
}

function App() {
  const [serviceStatus, setServiceStatus] = useState([]);
  const [metricsByService, setMetricsByService] = useState({});
  const [incidents, setIncidents] = useState([]);
  const [loadStatus, setLoadStatus] = useState(null);
  const [recoveryActions, setRecoveryActions] = useState([]);
  const [recoveryConfig, setRecoveryConfig] = useState({
    autoRecoveryEnabled: false,
    maxActionsPerHour: 5,
    verificationDelayMs: 10000,
    maxServiceReplicas: 5,
    minServiceReplicas: 2
  });
  const [recoveringIncidentId, setRecoveringIncidentId] = useState(null);
  const [activeOnly, setActiveOnly] = useState(false);
  const [dependencyGraph, setDependencyGraph] = useState({
    nodes: ['user-service', 'order-service', 'payment-service', 'database'],
    edges: [
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
      const [recoveryConfigResponse, recoveryActionsResponse] = await Promise.all([
        fetchJson(`${API_BASE}/api/recovery/config`).catch(() => null),
        fetchJson(`${API_BASE}/api/recovery/actions`).catch(() => [])
      ]);

      setServiceStatus(statusResponse.services || []);
      setIncidents(incidentsResponse || []);
      if (graphResponse?.nodes && graphResponse?.edges) {
        setDependencyGraph(graphResponse);
      }
      if (loadResponse) setLoadStatus(loadResponse);
      if (recoveryConfigResponse) setRecoveryConfig(recoveryConfigResponse);
      setRecoveryActions(recoveryActionsResponse || []);

      const metricsMap = {};
      for (const service of ['payment-service', 'order-service', 'user-service']) {
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
    for (const service of ['payment-service', 'order-service', 'user-service']) {
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

  const chartData = selectedHistory.map((point, index) => ({
    index,
    time: new Date(point.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    latency: Number(point.probe_latency_ms || 0),
    cpu: Number(point.cpu_percent || 0),
    memory: Number(point.memory_percent || 0),
    probeFailed: point.probe_ok === false ? 1 : 0
  }));

  const systemHealth = serviceStatus.filter((entry) => entry.service !== 'database').every((entry) => entry.state === 'running' && entry.health === 'healthy')
    ? 'Stable'
    : 'Attention';

  const selectedProbeFailures = selectedHistory.filter((point) => point.probe_ok === false).length;

  const triggerSimulation = async (endpoint) => {
    try {
      setSimulating(true);
      await fetch(`${API_BASE}${endpoint}`, { method: 'POST' });
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
          targetService: 'payment-service',
          requestsPerSecond: 50,
          durationSeconds: 60,
          scenario: 'traffic-spike'
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
    } catch (recoveryError) {
      setError(recoveryError.message || 'Manual recovery failed.');
    } finally {
      setRecoveringIncidentId(null);
    }
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
            <div className="stat-label">Active services</div>
            <div className="stat-value">{serviceStatus.length}</div>
          </div>
          <div className="card">
            <div className="stat-label">Risk level</div>
            <div className="stat-value">{incidents[0]?.risk_level || 'LOW'}</div>
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
            Limit: {recoveryConfig.maxActionsPerHour} actions/hour · Verification delay: {recoveryConfig.verificationDelayMs} ms · Replicas: {recoveryConfig.minServiceReplicas}–{recoveryConfig.maxServiceReplicas}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2 style={{ margin: 0 }}>Simulation controls</h2>
            <StatusBadge value={simulating ? 'running' : 'ready'} />
          </div>
          <div className="button-row">
            <button className="action-btn" onClick={() => triggerSimulation('/api/simulate/traffic-spike')} disabled={simulating}>Traffic spike</button>
            <button className="action-btn secondary" onClick={() => triggerSimulation('/api/simulate/database-overload')} disabled={simulating}>Database overload</button>
            <button className="action-btn secondary" onClick={() => triggerSimulation('/api/simulate/memory-leak')} disabled={simulating}>Memory leak</button>
            <button className="action-btn secondary" onClick={() => triggerSimulation('/api/simulate/cpu-overload')} disabled={simulating}>CPU overload</button>
            <button className="action-btn secondary" onClick={() => triggerSimulation('/api/simulate/stop')} disabled={simulating}>Reset</button>
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
              {dependencyGraph.nodes.map((node, index) => {
                const nextNode = dependencyGraph.nodes[index + 1];
                const hasNextEdge = dependencyGraph.edges.some(
                  (edge) => edge.source === node && edge.target === nextNode
                );

                return (
                  <div key={node}>
                    <button
                      type="button"
                      className={`dependency-node ${selectedDependency === node ? 'selected' : ''}`}
                      aria-pressed={selectedDependency === node}
                      onClick={() => {
                        setSelectedDependency(node);
                        if (['user-service', 'order-service', 'payment-service'].includes(node)) {
                          setSelectedService(node);
                        }
                      }}
                    >
                      {node}
                    </button>
                    {hasNextEdge && <div className="dependency-arrow" aria-hidden="true">↓</div>}
                  </div>
                );
              })}
            </div>
            <div className="muted" style={{ marginTop: '0.75rem', lineHeight: 1.5 }} aria-live="polite">
              <div><strong>{selectedDependency}</strong></div>
              <div>Depends on: {selectedDependencies.length ? selectedDependencies.join(', ') : 'none'}</div>
              <div>Depended on by: {selectedDependents.length ? selectedDependents.join(', ') : 'none'}</div>
              {selectedDependency !== 'database' && <div style={{ marginTop: '0.35rem' }}>Selecting a service also updates its metrics chart.</div>}
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
              </tr>
            </thead>
            <tbody>
              {incidents.length === 0 ? (
                <tr>
                  <td colSpan="11" className="muted">No incidents recorded yet.</td>
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
                    <td>{incident.recovery_status || incident.recoveryStatus || 'pending'}</td>
                    <td>
                      {['pending', 'open', 'in_progress', 'partially_recovered'].includes(incident.recovery_status) && (
                        <button
                          className="action-btn secondary"
                          disabled={recoveringIncidentId === incident.id}
                          onClick={() => recoverIncident(incident.id)}
                        >
                          {recoveringIncidentId === incident.id ? 'Running...' : 'Recover'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2 style={{ margin: 0 }}>Recovery activity</h2>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Incident</th>
                  <th>Action / target</th>
                  <th>Replicas</th>
                  <th>Action status</th>
                  <th>Recovery status</th>
                  <th>Before → after</th>
                  <th>Effectiveness</th>
                  <th>Triggered by</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {recoveryActions.length === 0 ? (
                  <tr><td colSpan="9" className="muted">No recovery actions recorded.</td></tr>
                ) : recoveryActions.slice(0, 10).map((action) => (
                  <tr key={action.id}>
                    <td>{action.incident_id}</td>
                    <td>{action.action_type} / {action.target_service}</td>
                    <td>{action.previous_replicas ?? '-'} → {action.new_replicas ?? '-'}</td>
                    <td>{action.status}</td>
                    <td>{action.recovery_status || 'pending'}</td>
                    <td>
                      CPU {formatNumber(action.before_metrics?.cpuUsage, 0)} → {formatNumber(action.after_metrics?.cpuUsage, 0)}%; memory {formatNumber(action.before_metrics?.memoryUsage, 0)} → {formatNumber(action.after_metrics?.memoryUsage, 0)}%; latency {formatNumber(action.before_metrics?.latencyMs, 0)} → {formatNumber(action.after_metrics?.latencyMs, 0)} ms; error {formatNumber(action.before_metrics?.errorRate, 1)} → {formatNumber(action.after_metrics?.errorRate, 1)}%
                    </td>
                    <td>{action.effectiveness_score === null ? '-' : `${formatNumber(action.effectiveness_score, 1)}%`}</td>
                    <td>{action.triggered_by || 'manual'}</td>
                    <td>{action.created_at ? new Date(action.created_at).toLocaleString() : '-'}</td>
                  </tr>
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
