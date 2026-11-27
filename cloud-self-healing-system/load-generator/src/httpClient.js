function requestBody(service, scenario) {
  const suffix = `${scenario}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (service === 'payment-service') return { amount: 100, status: 'processed' };
  if (service === 'order-service') return { customerName: 'load-generator', amount: 100, scenario: suffix };
  return { name: 'load-generator-user', email: `${suffix}@sentinel.local` };
}

async function sendRequest(service, url, scenario, options = {}) {
  const { timeoutMs = 5000, signal } = options;
  const started = process.hrtime.bigint();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromRun = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abortFromRun, { once: true });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody(service, scenario)),
      signal: controller.signal
    });
    return {
      ok: response.ok,
      statusCode: response.status,
      latencyMs: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(2)),
      error: response.ok ? null : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(2)),
      error: error.name === 'AbortError' ? 'Request timed out' : error.message
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromRun);
  }
}

module.exports = { sendRequest };
