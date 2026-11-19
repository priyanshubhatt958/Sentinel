const express = require('express');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ service: 'load-generator', status: 'healthy', timestamp: new Date().toISOString() });
});

module.exports = router;
