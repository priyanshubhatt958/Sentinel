const express = require('express');

function createLoadRoutes(runner) {
  const router = express.Router();

  router.get('/metrics', (req, res) => {
    res.json(runner.status());
  });

  router.get('/status', (req, res) => {
    res.json(runner.status());
  });

  router.post('/start', (req, res) => {
    try {
      res.status(201).json({ success: true, run: runner.start(req.body) });
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
  });

  router.post('/stop', (req, res) => {
    res.json({ success: true, run: runner.stop() });
  });

  return router;
}

module.exports = { createLoadRoutes };
