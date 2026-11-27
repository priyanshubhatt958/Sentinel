const express = require('express');
const { createLoadRunner } = require('./loadRunner');
const healthRoutes = require('./routes/healthRoutes');
const { createLoadRoutes } = require('./routes/loadRoutes');
const logger = require('./logger');

const app = express();
const port = Number(process.env.PORT || 8004);
const runner = createLoadRunner();

app.use(express.json({ limit: '16kb' }));
app.use(healthRoutes);
app.use(createLoadRoutes(runner));

app.listen(port, () => {
  logger.info('load_generator_started', { port });
});
