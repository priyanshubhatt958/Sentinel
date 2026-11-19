const test = require('node:test');
const assert = require('node:assert/strict');

const baseUrl = process.env.MONITORING_API_URL || 'http://localhost:5000';

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  assert.equal(response.ok, true, `${path} failed: ${JSON.stringify(body)}`);
  return body;
}

test('manual detection preserves incident count during cooldown and exposes active incidents', async () => {
  const before = await jsonRequest('/api/incidents');
  await jsonRequest('/api/incidents/detect', { method: 'POST' });
  const after = await jsonRequest('/api/incidents');
  const active = await jsonRequest('/api/incidents/active');

  assert.equal(after.length, before.length);
  assert.ok(Array.isArray(active));
});

test('latest incident detail contains automatic-detection fields when incidents exist', async () => {
  const incidents = await jsonRequest('/api/incidents');
  if (!incidents.length) return;

  const detail = await jsonRequest(`/api/incidents/${incidents[0].id}`);
  assert.ok(detail.evidence);
  assert.ok(detail.latest_metrics);
  assert.ok(detail.recovery_status);
});

test('recovery configuration and action history APIs expose safe defaults', async () => {
  const config = await jsonRequest('/api/recovery/config');
  assert.equal(config.autoRecoveryEnabled, false);
  assert.equal(config.maxActionsPerHour, 5);
  assert.equal(config.verificationDelayMs, 10000);
  assert.equal(config.maxServiceReplicas, 5);
  assert.equal(config.minServiceReplicas, 2);

  const actions = await jsonRequest('/api/recovery/actions?incidentId=2147483647');
  assert.deepEqual(actions, []);
});

test('manual recovery route remains available and returns 404 for an unknown incident', async () => {
  const response = await fetch(`${baseUrl}/api/incidents/2147483647/recover`, { method: 'POST' });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.status, 'not_found');
});
