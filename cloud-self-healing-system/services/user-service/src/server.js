const express = require('express');
const dotenv = require('dotenv');
const { randomUUID } = require('crypto');

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8003);

const metrics = {
  service: 'user-service',
  cpuUsage: 30,
  memoryUsage: 40,
  requestRate: 100,
  latencyMs: 100,
  errorRate: 0.1,
  dbConnections: 8,
  status: 'healthy',
  failureMode: 'normal',
  timestamp: new Date().toISOString()
};

function syncMetrics() {
  metrics.timestamp = new Date().toISOString();
  return { ...metrics, timestamp: metrics.timestamp };
}

function applyNormalVariation() {
  if (metrics.failureMode === 'normal') {
    metrics.cpuUsage = Math.max(20, Math.min(50, metrics.cpuUsage + (Math.random() - 0.5) * 6));
    metrics.memoryUsage = Math.max(25, Math.min(55, metrics.memoryUsage + (Math.random() - 0.5) * 5));
    metrics.requestRate = Math.max(60, Math.min(180, metrics.requestRate + (Math.random() - 0.5) * 25));
    metrics.latencyMs = Math.max(70, Math.min(150, metrics.latencyMs + (Math.random() - 0.5) * 20));
    metrics.errorRate = Math.max(0.05, Math.min(0.5, metrics.errorRate + (Math.random() - 0.5) * 0.2));
    metrics.dbConnections = Math.max(5, Math.min(20, metrics.dbConnections + (Math.random() - 0.5) * 5));
    metrics.status = 'healthy';
  }
}

setInterval(() => {
  applyNormalVariation();
}, 3000);

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ service: 'user-service', status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/metrics', (req, res) => {
  res.json(syncMetrics());
});

app.post('/simulate/traffic-spike', (req, res) => {
  metrics.cpuUsage = 74;
  metrics.memoryUsage = 58;
  metrics.requestRate = 2800;
  metrics.latencyMs = 1200;
  metrics.errorRate = 2.6;
  metrics.dbConnections = 48;
  metrics.status = 'warning';
  metrics.failureMode = 'traffic_spike';
  res.json({ service: 'user-service', status: 'simulated_traffic_spike', metrics: syncMetrics() });
});

app.post('/simulate/database-overload', (req, res) => {
  metrics.dbConnections = 90;
  metrics.latencyMs = 1400;
  metrics.errorRate = 4.2;
  metrics.cpuUsage = 68;
  metrics.status = 'warning';
  metrics.failureMode = 'database_overload';
  res.json({ service: 'user-service', status: 'simulated_database_overload', metrics: syncMetrics() });
});

app.post('/simulate/memory-leak', (req, res) => {
  metrics.memoryUsage = 88;
  metrics.cpuUsage = 54;
  metrics.latencyMs = 700;
  metrics.status = 'warning';
  metrics.failureMode = 'memory_leak';
  res.json({ service: 'user-service', status: 'simulated_memory_leak', metrics: syncMetrics() });
});

app.post('/simulate/cpu-overload', (req, res) => {
  metrics.cpuUsage = 90;
  metrics.latencyMs = 1500;
  metrics.errorRate = 3.0;
  metrics.status = 'warning';
  metrics.failureMode = 'cpu_overload';
  res.json({ service: 'user-service', status: 'simulated_cpu_overload', metrics: syncMetrics() });
});

app.post('/simulate/stop', (req, res) => {
  metrics.cpuUsage = 30;
  metrics.memoryUsage = 40;
  metrics.requestRate = 100;
  metrics.latencyMs = 100;
  metrics.errorRate = 0.1;
  metrics.dbConnections = 8;
  metrics.status = 'healthy';
  metrics.failureMode = 'normal';
  res.json({ service: 'user-service', status: 'reset_to_normal', metrics: syncMetrics() });
});

const users = new Map();

app.post('/users', (req, res) => {
  const user = {
    id: randomUUID(),
    ...req.body,
    createdAt: new Date().toISOString()
  };
  users.set(user.id, user);
  res.status(201).json(user);
});

app.get('/users', (req, res) => {
  res.json(Array.from(users.values()));
});

app.get('/users/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.listen(port, () => {
  console.log(`User Service running on port ${port}`);
});
