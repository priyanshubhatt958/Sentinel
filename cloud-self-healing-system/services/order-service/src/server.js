const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');
const { randomUUID } = require('crypto');

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8001);
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:8002';

const metrics = {
  service: 'order-service',
  cpuUsage: 35,
  memoryUsage: 45,
  requestRate: 120,
  latencyMs: 130,
  errorRate: 0.2,
  dbConnections: 12,
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
    metrics.cpuUsage = Math.max(20, Math.min(55, metrics.cpuUsage + (Math.random() - 0.5) * 8));
    metrics.memoryUsage = Math.max(30, Math.min(60, metrics.memoryUsage + (Math.random() - 0.5) * 6));
    metrics.requestRate = Math.max(70, Math.min(200, metrics.requestRate + (Math.random() - 0.5) * 30));
    metrics.latencyMs = Math.max(80, Math.min(180, metrics.latencyMs + (Math.random() - 0.5) * 20));
    metrics.errorRate = Math.max(0.05, Math.min(0.8, metrics.errorRate + (Math.random() - 0.5) * 0.3));
    metrics.dbConnections = Math.max(8, Math.min(25, metrics.dbConnections + (Math.random() - 0.5) * 6));
    metrics.status = 'healthy';
  }
}

setInterval(() => {
  applyNormalVariation();
}, 3000);

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ service: 'order-service', status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/metrics', (req, res) => {
  res.json(syncMetrics());
});

app.post('/simulate/traffic-spike', (req, res) => {
  metrics.cpuUsage = 88;
  metrics.memoryUsage = 60;
  metrics.requestRate = 4200;
  metrics.latencyMs = 2000;
  metrics.errorRate = 6.4;
  metrics.dbConnections = 75;
  metrics.status = 'warning';
  metrics.failureMode = 'traffic_spike';
  res.json({ service: 'order-service', status: 'simulated_traffic_spike', metrics: syncMetrics() });
});

app.post('/simulate/database-overload', (req, res) => {
  metrics.dbConnections = 96;
  metrics.latencyMs = 1800;
  metrics.errorRate = 5.1;
  metrics.cpuUsage = 78;
  metrics.status = 'warning';
  metrics.failureMode = 'database_overload';
  res.json({ service: 'order-service', status: 'simulated_database_overload', metrics: syncMetrics() });
});

app.post('/simulate/memory-leak', (req, res) => {
  metrics.memoryUsage = 90;
  metrics.cpuUsage = 62;
  metrics.latencyMs = 900;
  metrics.status = 'warning';
  metrics.failureMode = 'memory_leak';
  res.json({ service: 'order-service', status: 'simulated_memory_leak', metrics: syncMetrics() });
});

app.post('/simulate/cpu-overload', (req, res) => {
  metrics.cpuUsage = 92;
  metrics.latencyMs = 1700;
  metrics.errorRate = 3.5;
  metrics.status = 'warning';
  metrics.failureMode = 'cpu_overload';
  res.json({ service: 'order-service', status: 'simulated_cpu_overload', metrics: syncMetrics() });
});

app.post('/simulate/stop', (req, res) => {
  metrics.cpuUsage = 32;
  metrics.memoryUsage = 44;
  metrics.requestRate = 110;
  metrics.latencyMs = 130;
  metrics.errorRate = 0.2;
  metrics.dbConnections = 12;
  metrics.status = 'healthy';
  metrics.failureMode = 'normal';
  res.json({ service: 'order-service', status: 'reset_to_normal', metrics: syncMetrics() });
});

const orders = new Map();

app.post('/orders', async (req, res) => {
  const order = {
    id: randomUUID(),
    ...req.body,
    createdAt: new Date().toISOString()
  };

  try {
    await axios.post(`${PAYMENT_SERVICE_URL}/payments`, {
      orderId: order.id,
      amount: req.body.amount || 100,
      status: 'processed'
    }, { timeout: 10000 });
  } catch (error) {
    console.warn('Order service could not reach payment service:', error.message);
  }

  orders.set(order.id, order);
  res.status(201).json(order);
});

app.get('/orders', (req, res) => {
  res.json(Array.from(orders.values()));
});

app.get('/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

app.listen(port, () => {
  console.log(`Order Service running on port ${port}`);
});
