const test = require('node:test');
const assert = require('node:assert/strict');

const baseUrl = process.env.MONITORING_API_URL || 'http://localhost:5000';

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  assert.equal(response.ok, true, `${path} failed: ${JSON.stringify(body)}`);
  return body;
}

test('manual detection exposes active incidents without duplicating active service/type pairs', async () => {
  const health = await jsonRequest('/api/health');
  assert.ok(['healthy', 'degraded'].includes(health.status));
  await jsonRequest('/api/incidents/detect', { method: 'POST' });
  const active = await jsonRequest('/api/incidents/active');

  assert.ok(Array.isArray(active));
  const activePairs = active.map((incident) => `${incident.service_name}|${incident.incident_type}`);
  assert.equal(new Set(activePairs).size, activePairs.length);
});

test('latest incident detail contains automatic-detection fields when incidents exist', async () => {
  const incidents = await jsonRequest('/api/incidents');
  if (!incidents.length) return;

  const detail = await jsonRequest(`/api/incidents/${incidents[0].id}`);
  assert.ok(detail.evidence);
  assert.ok(detail.latest_metrics);
  assert.ok(detail.recovery_status);
  assert.ok(detail.recoveryRecommendation?.recommendation);
  const timeline = await jsonRequest(`/api/incidents/${incidents[0].id}/recovery-timeline`);
  assert.ok(Array.isArray(timeline));
  if (timeline.length) {
    for (const field of [
      'incidentId', 'action', 'actionType', 'targetService', 'status', 'reason',
      'decisionConfidence', 'beforeMetrics', 'afterMetrics', 'effectivenessScore',
      'samplesUsed', 'verificationWindowMs', 'cooldownUntil', 'errorDetails',
      'triggeredBy', 'createdAt', 'updatedAt'
    ]) {
      assert.ok(Object.hasOwn(timeline[0], field), `timeline entry must include ${field}`);
    }
  }
  const summary = await jsonRequest(`/api/incidents/${incidents[0].id}/summary`);
  assert.ok(summary.summary);
  assert.ok(summary.report?.executiveSummary);
});

test('recovery configuration and action history APIs expose safe defaults', async () => {
  const config = await jsonRequest('/api/recovery/config');
  assert.equal(config.autoRecoveryEnabled, false);
  assert.equal(config.maxActionsPerHour, 5);
  assert.ok(config.cooldownMs >= 1000);
  assert.ok(config.maxActionsPerIncident >= 1);
  assert.ok(config.maxActionsPerServicePerHour >= 1);
  assert.ok(config.maxFailuresBeforeManual >= 1);
  assert.equal(config.verificationDelayMs, 30000);
  assert.equal(config.verificationSamples, 6);
  assert.equal(config.maxServiceReplicas, 5);
  assert.ok(config.minServiceReplicas >= 1);
  assert.ok(config.minServiceReplicas <= config.maxServiceReplicas);

  const actions = await jsonRequest('/api/recovery/actions?incidentId=2147483647');
  assert.deepEqual(actions, []);
});

test('manual recovery route remains available and returns 404 for an unknown incident', async () => {
  const response = await fetch(`${baseUrl}/api/incidents/2147483647/recover`, { method: 'POST' });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.status, 'not_found');
});
