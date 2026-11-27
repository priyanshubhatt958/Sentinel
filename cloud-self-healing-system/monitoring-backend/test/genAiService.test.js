const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildIncidentSummaryResult,
  REPORT_FIELDS
} = require('../src/services/genAiService');

test('builds a complete local incident report from persisted incident data', async () => {
  const previousEnabled = process.env.GENAI_ENABLED;
  const previousKey = process.env.GENAI_API_KEY;
  process.env.GENAI_ENABLED = 'false';
  delete process.env.GENAI_API_KEY;

  try {
    const result = await buildIncidentSummaryResult({
      id: 17,
      service_name: 'payment-service',
      incident_type: 'traffic_spike',
      root_cause: 'payment-service',
      risk_level: 'HIGH',
      failure_probability: 0.81,
      evidence: ['Observed request rate: 120/sec'],
      recoveryAction: { action: 'scale_service', target: 'payment-service' },
      recoveryResult: { status: 'partially_recovered', effectivenessScore: 55 }
    });

    assert.equal(result.source, 'fallback');
    assert.deepEqual(Object.keys(result.report), REPORT_FIELDS);
    assert.match(result.report.executiveSummary, /payment-service/);
    assert.match(result.report.recoveryResult, /55\/100/);
    assert.match(result.summary, /Recommended next steps/);
    assert.match(result.summary, /Observed request rate/);
  } finally {
    if (previousEnabled === undefined) delete process.env.GENAI_ENABLED;
    else process.env.GENAI_ENABLED = previousEnabled;
    if (previousKey === undefined) delete process.env.GENAI_API_KEY;
    else process.env.GENAI_API_KEY = previousKey;
  }
});
