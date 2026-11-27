import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
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
    healthy: { bg: 'var(--badge-healthy-bg)', text: 'var(--badge-healthy-text)' },
    warning: { bg: 'var(--badge-warning-bg)', text: 'var(--badge-warning-text)' },
    critical: { bg: 'var(--badge-critical-bg)', text: 'var(--badge-critical-text)' },
    unhealthy: { bg: 'var(--badge-neutral-bg)', text: 'var(--badge-neutral-text)' },
    recovered: { bg: 'var(--badge-info-bg)', text: 'var(--badge-info-text)' },
    partial: { bg: 'var(--badge-warning-bg)', text: 'var(--badge-warning-text)' },
    stable: { bg: 'var(--badge-healthy-bg)', text: 'var(--badge-healthy-text)' },
    attention: { bg: 'var(--badge-warning-bg)', text: 'var(--badge-warning-text)' },
    enabled: { bg: 'var(--badge-healthy-bg)', text: 'var(--badge-healthy-text)' },
    disabled: { bg: 'var(--badge-neutral-bg)', text: 'var(--badge-neutral-text)' },
    running: { bg: 'var(--badge-info-bg)', text: 'var(--badge-info-text)' },
    ready: { bg: 'var(--badge-healthy-bg)', text: 'var(--badge-healthy-text)' },
    active: { bg: 'var(--badge-info-bg)', text: 'var(--badge-info-text)' },
    stopped: { bg: 'var(--badge-neutral-bg)', text: 'var(--badge-neutral-text)' }
  };

  const style = palette[normalized] || { bg: 'var(--badge-neutral-bg)', text: 'var(--badge-neutral-text)' };

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

function TabIcon({ name }) {
  const icons = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    monitoring: <><path d="M3 12h4l2.5-6 5 12 2.5-6H21" /></>,
    analytics: <><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></>,
    incidents: <><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.7 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" /></>,
    recovery: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>
  };

  return (
    <svg className="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icons[name]}
    </svg>
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
  const [activeTab, setActiveTab] = useState('overview');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState(() => window.localStorage.getItem('sentinel-theme') || 'dark');
  const requestInFlight = useRef(false);

  useEffect(() => {
    const activeTheme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = activeTheme;
    window.localStorage.setItem('sentinel-theme', activeTheme);
  }, [theme]);

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
  const viewHeadings = {
    overview: ['Control Center', 'A live overview of service health and resilience.'],
    monitoring: ['System Monitoring', 'Inspect services, dependencies, and traffic controls.'],
    analytics: ['Performance Analytics', 'Explore recent latency, probe, and memory trends.'],
    incidents: ['Incident Timeline', 'Review detected issues and coordinate recovery.'],
    recovery: ['Recovery Activity', 'Track automated and manual remediation actions.']
  };
  const [pageTitle, pageSubtitle] = viewHeadings[activeTab];

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
      <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <aside className="sidebar">
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {sidebarCollapsed ? (
                <><path d="m9 18 6-6-6-6" /></>
              ) : (
                <><path d="m15 18-6-6 6-6" /></>
              )}
            </svg>
          </button>
          <div className="sidebar-brand">
            <div className="brand-mark" aria-hidden="true">S</div>
            <div>
              <strong>Sentinel</strong>
              <span>Resilience OS</span>
            </div>
          </div>

          <nav className="tab-list" aria-label="Control center views">
            {[
              ['overview', 'Overview'],
              ['monitoring', 'Monitoring'],
              ['analytics', 'Analytics'],
              ['incidents', 'Incidents'],
              ['recovery', 'Recovery']
            ].map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                className={`tab-button ${activeTab === tab ? 'active' : ''}`}
                title={sidebarCollapsed ? label : undefined}
                aria-current={activeTab === tab ? 'page' : undefined}
                onClick={() => setActiveTab(tab)}
              >
                <TabIcon name={tab} />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-status">
            <span className="sidebar-status-dot" />
            <div>
              <strong>{systemHealth}</strong>
              <span>System status</span>
            </div>
          </div>
        </aside>

        <main className="page">
        <div className="topbar">
          <div>
            <h1 className="title">{pageTitle}</h1>
            <p className="subtitle">{pageSubtitle}</p>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="theme-toggle"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {theme === 'dark' ? (
                  <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>
                ) : (
                  <><path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" /></>
                )}
              </svg>
              <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
            <StatusBadge value={systemHealth} />
          </div>
        </div>

        {error && (
          <div className="panel" style={{ borderColor: 'rgba(248, 113, 113, 0.4)', background: 'rgba(127, 29, 29, 0.18)', color: '#fecaca' }}>
            <strong>Connection issue:</strong> {error}
          </div>
        )}

        <div className={`muted refresh-status ${stale ? 'stale' : ''}`} style={{ marginBottom: '1rem' }} aria-live="polite">
          {stale ? 'Showing last known data; monitoring backend is unavailable.' : `Last refresh: ${lastRefreshAt ? lastRefreshAt.toLocaleTimeString() : 'loading...'}`}
        </div>

        {activeTab === 'overview' && (
          <div className="tab-content">
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
        <div className="overview-grid">
          <section className="panel overview-panel">
            <div className="panel-header">
              <div>
                <h2 style={{ margin: 0 }}>Service health</h2>
                <p className="overview-caption">Current state across monitored components</p>
              </div>
              <span className="overview-count">{serviceStatus.length} tracked</span>
            </div>
            <div className="overview-services">
              {serviceStatus.length === 0 ? (
                <p className="muted overview-empty">Service status is not available yet.</p>
              ) : serviceStatus.map((service) => {
                const metric = latestMetrics[service.service];
                const health = service.health || 'unavailable';
                return (
                  <div className="overview-service" key={service.service}>
                    <span className={`service-indicator ${String(health).toLowerCase()}`} aria-hidden="true" />
                    <div className="overview-service-name">
                      <strong>{service.service}</strong>
                      <span>{service.state || 'unknown'}{metric ? ` · CPU ${formatNumber(metric.cpu_percent, 0)}%` : ''}</span>
                    </div>
                    <StatusBadge value={health} />
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel overview-panel incident-highlight">
            <div className="panel-header">
              <div>
                <h2 style={{ margin: 0 }}>Latest incident</h2>
                <p className="overview-caption">Most recently detected event</p>
              </div>
              {incidents[0] && <StatusBadge value={incidents[0].risk_level || incidents[0].riskLevel || 'LOW'} />}
            </div>
            {incidents[0] ? (
              <div className="incident-summary">
                <span className="incident-service">{incidents[0].service_name || incidents[0].service || 'Unknown service'}</span>
                <strong>{incidents[0].incident_type || incidents[0].incidentType || 'Incident detected'}</strong>
                <p>{incidents[0].root_cause || incidents[0].rootCause || 'Root cause analysis is pending.'}</p>
                <span className="incident-time">
                  {incidents[0].created_at ? new Date(incidents[0].created_at).toLocaleString() : 'Time unavailable'}
                </span>
              </div>
            ) : (
              <div className="incident-clear">
                <span className="incident-clear-mark" aria-hidden="true">✓</span>
                <div>
                  <strong>No incidents recorded</strong>
                  <span>The system has no recent events to report.</span>
                </div>
              </div>
            )}
          </section>
        </div>
          </div>
        )}

        {activeTab === 'monitoring' && (
          <div className="tab-content">
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
          </div>
        )}

        {activeTab === 'analytics' && (
          <div className="tab-content">
        <div className="panel">
          <div className="panel-header">
            <h2 style={{ margin: 0 }}>{selectedService} resilience trend</h2>
            <span className="muted">Failed probes: {selectedProbeFailures}</span>
          </div>
          <div style={{ width: '100%', height: 280 }}>
            <ResponsiveContainer>
              <LineChart data={chartData}>
                <CartesianGrid stroke="rgba(148, 163, 184, 0.14)" strokeDasharray="5 5" />
                <XAxis dataKey="time" minTickGap={25} />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="latency" stroke="#60a5fa" strokeWidth={2.5} dot={false} name="Latency (ms)" />
                <Line type="monotone" dataKey="probeFailed" stroke="#c084fc" strokeWidth={2} dot={false} name="Probe failure (1/0)" />
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
                    <stop offset="5%" stopColor="#5eead4" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#5eead4" stopOpacity={0.1} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(148, 163, 184, 0.14)" strokeDasharray="5 5" />
                <XAxis dataKey="time" minTickGap={25} />
                <YAxis />
                <Tooltip />
                <Area type="monotone" dataKey="memory" stroke="#5eead4" fill="url(#cpuFill)" name="Memory usage (%)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
          </div>
        )}

        {activeTab === 'incidents' && (
          <div className="tab-content">
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
          </div>
        )}

        {activeTab === 'recovery' && (
          <div className="tab-content">
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
        )}
        </main>
      </div>
    </>
  );
}

export default App;
