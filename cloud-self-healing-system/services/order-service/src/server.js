const express = require('express');
const axios = require('axios');
const { createServiceDatabase } = require('../common/database');
const { createSimulationController, createTelemetry } = require('../common/telemetry');
const logger = require('../common/logger');

const app = express();
const port = Number(process.env.PORT || 8001);
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:8002';
const simulations = createSimulationController('order-service');
const telemetry = createTelemetry('order-service', ['/orders']);
const database = createServiceDatabase(simulations);

app.use(express.json({ limit: '32kb' }));
app.use(telemetry.middleware);
app.use(simulations.middleware);

app.get('/health', async (req, res) => {
  try {
    await database.checkHealth();
    res.json({ service: 'order-service', status: 'healthy', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ service: 'order-service', status: 'unavailable', error: error.message });
  }
});

app.get('/metrics', (req, res) => {
  res.json({ ...telemetry.snapshot(), ...database.snapshot(), simulations: simulations.getStatus() });
});

app.get('/simulate/status', (req, res) => res.json(simulations.getStatus()));

for (const type of ['traffic-spike', 'database-overload', 'memory-leak', 'cpu-overload']) {
  app.post(`/simulate/${type}`, (req, res) => {
    try {
      const simulation = simulations.start(type, req.body?.durationMs);
      if (type === 'database-overload') {
        database.runDatabaseStress().catch((error) => logger.error('database_simulation_failed', { message: error.message }));
      }
      res.status(202).json({ success: true, simulation, status: simulations.getStatus() });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message, status: simulations.getStatus() });
    }
  });
}

app.post('/simulate/stop', (req, res) => {
  res.json({ success: true, status: simulations.stopAll() });
});

app.post('/orders', async (req, res) => {
  const amount = Number(req.body?.amount);
  const rawUserId = req.body?.userId;
  const userId = rawUserId === undefined || rawUserId === null || rawUserId === '' ? null : Number(rawUserId);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a non-negative number' });
  if (userId !== null && (!Number.isInteger(userId) || userId < 1)) {
    return res.status(400).json({ error: 'userId must be a positive integer when provided' });
  }

  let order;
  try {
    const result = await database.query(
      'INSERT INTO orders (user_id, amount, status) VALUES ($1, $2, $3) RETURNING id, user_id, amount, status, created_at',
      [userId, amount, 'pending']
    );
    order = result.rows[0];
  } catch (error) {
    res.locals.telemetryError = error.message;
    logger.error('order_persistence_failed', { message: error.message });
    return res.status(503).json({ error: 'Order could not be persisted' });
  }

  try {
    await axios.post(`${PAYMENT_SERVICE_URL}/payments`, {
      orderId: order.id,
      amount: order.amount,
      status: 'processed'
    }, { timeout: 10000 });
    const result = await database.query(
      "UPDATE orders SET status = 'processed' WHERE id = $1 RETURNING id, user_id, amount, status, created_at",
      [order.id]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    res.locals.telemetryError = error.message;
    logger.error('order_payment_failed', { message: error.message });
    await database.query(
      "UPDATE orders SET status = 'payment_failed' WHERE id = $1",
      [order.id]
    ).catch((updateError) => logger.error('order_failure_status_update_failed', { message: updateError.message, orderId: order.id }));
    return res.status(502).json({ error: 'Order was stored but payment processing failed', orderId: order.id });
  }
});

app.get('/orders', async (req, res) => {
  try {
    const result = await database.query(
      'SELECT id, user_id, amount, status, created_at FROM orders ORDER BY created_at DESC LIMIT 500'
    );
    res.json(result.rows);
  } catch (error) {
    res.locals.telemetryError = error.message;
    res.status(503).json({ error: 'Orders unavailable' });
  }
});

app.get('/orders/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Order id must be a positive integer' });
  try {
    const result = await database.query(
      'SELECT id, user_id, amount, status, created_at FROM orders WHERE id = $1',
      [id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.locals.telemetryError = error.message;
    res.status(503).json({ error: 'Order unavailable' });
  }
});

app.listen(port, () => {
  logger.info('order_service_started', { port });
});
