const express = require('express');
const { createServiceDatabase } = require('../common/database');
const { createSimulationController, createTelemetry } = require('../common/telemetry');
const logger = require('../common/logger');

const app = express();
const port = Number(process.env.PORT || 8002);
const simulations = createSimulationController('payment-service');
const telemetry = createTelemetry('payment-service', ['/payments']);
const database = createServiceDatabase(simulations);

app.use(express.json({ limit: '32kb' }));
app.use(telemetry.middleware);
app.use(simulations.middleware);

app.get('/health', async (req, res) => {
  try {
    await database.checkHealth();
    res.json({ service: 'payment-service', status: 'healthy', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ service: 'payment-service', status: 'unavailable', error: error.message });
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

app.post('/payments', async (req, res) => {
  const amount = Number(req.body?.amount);
  const rawOrderId = req.body?.orderId;
  const orderId = rawOrderId === undefined || rawOrderId === null || rawOrderId === '' ? null : Number(rawOrderId);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a non-negative number' });
  if (orderId !== null && (!Number.isInteger(orderId) || orderId < 1)) {
    return res.status(400).json({ error: 'orderId must be a positive integer when provided' });
  }

  try {
    const result = await database.query(
      'INSERT INTO payments (order_id, amount, status) VALUES ($1, $2, $3) RETURNING id, order_id, amount, status, created_at',
      [orderId, amount, req.body.status || 'pending']
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.locals.telemetryError = error.message;
    logger.error('payment_persistence_failed', { message: error.message });
    res.status(503).json({ error: 'Payment could not be persisted' });
  }
});

app.get('/payments', async (req, res) => {
  try {
    const result = await database.query('SELECT id, order_id, amount, status, created_at FROM payments ORDER BY created_at DESC LIMIT 500');
    res.json(result.rows);
  } catch (error) {
    res.locals.telemetryError = error.message;
    res.status(503).json({ error: 'Payments unavailable' });
  }
});

app.get('/payments/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Payment id must be a positive integer' });
  try {
    const result = await database.query(
      'SELECT id, order_id, amount, status, created_at FROM payments WHERE id = $1',
      [id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Payment not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.locals.telemetryError = error.message;
    res.status(503).json({ error: 'Payment unavailable' });
  }
});

app.listen(port, () => {
  logger.info('payment_service_started', { port });
});
