const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const endpoints = {
  user: 'http://localhost:8003',
  order: 'http://localhost:8001',
  payment: 'http://localhost:8002'
};

async function request(base, route, options) {
  const response = await fetch(`${base}${route}`, options);
  const payload = await response.json();
  return { response, payload };
}

async function waitForHealth(base) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const { response } = await request(base, '/health');
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Service did not become healthy: ${base}`);
}

async function runServiceRestartPersistenceTest() {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const userResult = await request(endpoints.user, '/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'persistence-test', email: `${unique}@sentinel.local` })
  });
  assert.equal(userResult.response.status, 201);

  const orderResult = await request(endpoints.order, '/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: userResult.payload.id, amount: 23.45 })
  });
  assert.equal(orderResult.response.status, 201);

  const paymentResult = await request(endpoints.payment, '/payments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: orderResult.payload.id, amount: 23.45, status: 'processed' })
  });
  assert.equal(paymentResult.response.status, 201);

  execFileSync('docker', ['compose', 'restart', 'user-service', 'order-service', 'payment-service'], {
    cwd: projectRoot,
    stdio: 'pipe'
  });
  await Promise.all(Object.values(endpoints).map(waitForHealth));

  for (const [service, entity] of [['user', userResult.payload], ['order', orderResult.payload], ['payment', paymentResult.payload]]) {
    const { response, payload } = await request(endpoints[service], `/${service === 'user' ? 'users' : `${service}s`}/${entity.id}`);
    assert.equal(response.status, 200);
    assert.equal(Number(payload.id), Number(entity.id));
  }

  const failedPayment = await request(endpoints.payment, '/payments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: 2147483647, amount: 1 })
  });
  assert.equal(failedPayment.response.status, 503);
}

module.exports = { runServiceRestartPersistenceTest };
