const express = require('express');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { randomUUID } = require('crypto');

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8002);

const metrics = {
  service: 'payment-service',
  cpuUsage: 42,
  memoryUsage: 55,
  requestRate: 120,
  latencyMs: 180,
  errorRate: 0.4,
  dbConnections: 35,
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
    metrics.cpuUsage = Math.max(25, Math.min(60, metrics.cpuUsage + (Math.random() - 0.5) * 8));
    metrics.memoryUsage = Math.max(35, Math.min(70, metrics.memoryUsage + (Math.random() - 0.5) * 6));
    metrics.requestRate = Math.max(80, Math.min(250, metrics.requestRate + (Math.random() - 0.5) * 40));
    metrics.latencyMs = Math.max(90, Math.min(220, metrics.latencyMs + (Math.random() - 0.5) * 30));
    metrics.errorRate = Math.max(0.1, Math.min(1.5, metrics.errorRate + (Math.random() - 0.5) * 0.5));
    metrics.dbConnections = Math.max(10, Math.min(40, metrics.dbConnections + (Math.random() - 0.5) * 8));
    metrics.status = 'healthy';
  }
}

setInterval(() => {
  applyNormalVariation();
}, 3000);

app.use(express.json());

const dbClient = new Client({
  host: process.env.DATABASE_HOST || 'database',
  port: Number(process.env.DATABASE_PORT || 5432),
  database: process.env.DATABASE_NAME || 'cloud_self_healing',
  user: process.env.DATABASE_USER || 'cloud_user',
  password: process.env.DATABASE_PASSWORD || 'cloud_password'
});

async function connectDb() {
  try {
    await dbClient.connect();
    console.log('Payment Service connected to PostgreSQL');
  } catch (error) {
    console.error('Database connection failed:', error.message);
  }
}

connectDb();

app.get('/health', (req, res) => {
  res.json({ service: 'payment-service', status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/metrics', (req, res) => {
  res.json(syncMetrics());
});

app.post('/simulate/traffic-spike', (req, res) => {
  metrics.cpuUsage = 94;
  metrics.memoryUsage = 68;
  metrics.requestRate = 5000;
  metrics.latencyMs = 2800;
  metrics.errorRate = 8.2;
  metrics.dbConnections = 95;
  metrics.status = 'critical';
  metrics.failureMode = 'traffic_spike';
  res.json({ service: 'payment-service', status: 'simulated_traffic_spike', metrics: syncMetrics() });
});

app.post('/simulate/database-overload', (req, res) => {
  metrics.dbConnections = 98;
  metrics.latencyMs = 2400;
  metrics.errorRate = 7.5;
  metrics.cpuUsage = 88;
  metrics.status = 'critical';
  metrics.failureMode = 'database_overload';
  res.json({ service: 'payment-service', status: 'simulated_database_overload', metrics: syncMetrics() });
});

app.post('/simulate/memory-leak', (req, res) => {
  metrics.memoryUsage = 92;
  metrics.cpuUsage = 60;
  metrics.latencyMs = 900;
  metrics.status = 'warning';
  metrics.failureMode = 'memory_leak';
  res.json({ service: 'payment-service', status: 'simulated_memory_leak', metrics: syncMetrics() });
});

app.post('/simulate/cpu-overload', (req, res) => {
  metrics.cpuUsage = 96;
  metrics.latencyMs = 1900;
  metrics.errorRate = 4.5;
  metrics.status = 'warning';
  metrics.failureMode = 'cpu_overload';
  res.json({ service: 'payment-service', status: 'simulated_cpu_overload', metrics: syncMetrics() });
});

app.post('/simulate/stop', (req, res) => {
  metrics.cpuUsage = 42;
  metrics.memoryUsage = 55;
  metrics.requestRate = 120;
  metrics.latencyMs = 180;
  metrics.errorRate = 0.4;
  metrics.dbConnections = 35;
  metrics.status = 'healthy';
  metrics.failureMode = 'normal';
  res.json({ service: 'payment-service', status: 'reset_to_normal', metrics: syncMetrics() });
});

const payments = new Map();

app.post('/payments', async (req, res) => {
  const payment = {
    id: randomUUID(),
    ...req.body,
    createdAt: new Date().toISOString()
  };
  payments.set(payment.id, payment);

  try {
    const result = await dbClient.query(
      'INSERT INTO payments (id, amount, status, created_at) VALUES ($1, $2, $3, NOW())',
      [payment.id, payment.amount || 0, payment.status || 'pending']
    );
    if (result) {
      payment.dbInserted = true;
    }
  } catch (error) {
    console.error('Insert payment failed:', error.message);
  }

  res.status(201).json(payment);
});

app.get('/payments', (req, res) => {
  res.json(Array.from(payments.values()));
});

app.get('/payments/:id', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  res.json(payment);
});

app.listen(port, () => {
  console.log(`Payment Service running on port ${port}`);
});
