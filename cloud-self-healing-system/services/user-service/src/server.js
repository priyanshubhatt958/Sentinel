const express = require('express');
const { createServiceDatabase } = require('../common/database');
const { createSimulationController, createTelemetry } = require('../common/telemetry');
const logger = require('../common/logger');

const app = express();
const port = Number(process.env.PORT || 8003);
const simulations = createSimulationController('user-service');
const telemetry = createTelemetry('user-service', ['/users']);
const database = createServiceDatabase(simulations);

app.use(express.json({ limit: '32kb' }));
app.use(telemetry.middleware);
app.use(simulations.middleware);

app.get('/health', async (req, res) => {
  try {
    await database.checkHealth();
    res.json({ service: 'user-service', status: 'healthy', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ service: 'user-service', status: 'unavailable', error: error.message });
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

app.post('/users', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim();
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  try {
    const result = await database.query(
      'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id, name, email, created_at',
      [name, email]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.locals.telemetryError = error.message;
    logger.error('user_persistence_failed', { message: error.message });
    res.status(503).json({ error: 'User could not be persisted' });
  }
});

app.get('/users', async (req, res) => {
  try {
    const result = await database.query('SELECT id, name, email, created_at FROM users ORDER BY created_at DESC LIMIT 500');
    res.json(result.rows);
  } catch (error) {
    res.locals.telemetryError = error.message;
    res.status(503).json({ error: 'Users unavailable' });
  }
});

app.get('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'User id must be a positive integer' });
  try {
    const result = await database.query(
      'SELECT id, name, email, created_at FROM users WHERE id = $1',
      [id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.locals.telemetryError = error.message;
    res.status(503).json({ error: 'User unavailable' });
  }
});

app.listen(port, () => {
  logger.info('user_service_started', { port });
});
