const MAX_REQUESTS_PER_SECOND = 200;
const MAX_DURATION_SECONDS = 300;

const targetUrls = {
  'payment-service': process.env.PAYMENT_SERVICE_URL || 'http://payment-service:8002/payments',
  'order-service': process.env.ORDER_SERVICE_URL || 'http://order-service:8001/orders',
  'user-service': process.env.USER_SERVICE_URL || 'http://user-service:8003/users'
};

const targetServices = Object.keys(targetUrls);

function validateStartOptions(input = {}) {
  const targetService = input.targetService || 'payment-service';
  const scenario = input.scenario || 'normal';
  const requestsPerSecond = Number(input.requestsPerSecond ?? 50);
  const durationSeconds = Number(input.durationSeconds ?? 60);

  if (![...targetServices, 'all'].includes(targetService)) {
    throw new Error(`targetService must be one of: ${[...targetServices, 'all'].join(', ')}`);
  }
  if (!['normal', 'traffic-spike'].includes(scenario)) {
    throw new Error('scenario must be normal or traffic-spike');
  }
  if (!Number.isInteger(requestsPerSecond) || requestsPerSecond < 1 || requestsPerSecond > MAX_REQUESTS_PER_SECOND) {
    throw new Error(`requestsPerSecond must be an integer between 1 and ${MAX_REQUESTS_PER_SECOND}`);
  }
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error(`durationSeconds must be an integer between 1 and ${MAX_DURATION_SECONDS}`);
  }

  return { targetService, scenario, requestsPerSecond, durationSeconds };
}

module.exports = { MAX_REQUESTS_PER_SECOND, MAX_DURATION_SECONDS, targetUrls, targetServices, validateStartOptions };
