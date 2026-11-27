const test = require('node:test');
const assert = require('node:assert/strict');

const { client } = require('../src/config/db');
const { buildRealMetrics } = require('../src/services/incidentDetector');
const { toMlPayload } = require('../src/services/mlService');

test('uses current load-generator rate when service sample records zero requests per second', async () => {
  const originalQuery = client.query;
  client.query = async (sql) => {
    if (sql.includes("service_name = 'load-generator'")) {
      return {
        rows: [{
          load_target_service: 'payment-service',
          load_current_requests_per_second: 120,
          load_active: true,
          load_total_requests: 600
        }]
      };
    }
    return { rows: [{ failures: 0 }] };
  };

  try {
    const metrics = await buildRealMetrics({
      service_name: 'payment-service',
      requests_per_second: 0,
      requests_last_minute: 600,
      total_requests: 600,
      successful_requests: 600,
      failed_requests: 0
    });
    const payload = toMlPayload('payment-service', metrics);

    assert.equal(metrics.requestRate, 120);
    assert.equal(metrics.loadMetrics.currentRequestsPerSecond, 120);
    assert.equal(payload.requestRate, 120);
    assert.equal(payload.requestsPerSecond, 120);
  } finally {
    client.query = originalQuery;
  }
});
