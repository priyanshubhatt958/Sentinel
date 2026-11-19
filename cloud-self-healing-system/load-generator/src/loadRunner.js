const { targetUrls, validateStartOptions } = require('./config');
const { sendRequest } = require('./httpClient');
const { createMetricsStore } = require('./metrics');

function createLoadRunner() {
  const metrics = createMetricsStore();
  let active = false;
  let interval = null;
  let durationTimer = null;
  let options = null;
  let targetIndex = 0;

  function targetList() {
    return options.targetService === 'all' ? Object.keys(targetUrls) : [options.targetService];
  }

  async function sendBatch() {
    if (!active) return;
    const targets = targetList();
    const requestsThisTick = Math.max(1, Math.round(options.requestsPerSecond / 10));
    const requests = Array.from({ length: requestsThisTick }, (_, index) => {
      const service = targets[(targetIndex + index) % targets.length];
      return sendRequest(service, targetUrls[service], options.scenario).then((result) => metrics.record(result));
    });
    targetIndex = (targetIndex + requestsThisTick) % targets.length;
    await Promise.all(requests);
  }

  function finish() {
    if (!active) return;
    active = false;
    clearInterval(interval);
    clearTimeout(durationTimer);
    interval = null;
    durationTimer = null;
    metrics.stop();
  }

  return {
    start(input) {
      if (active) {
        const error = new Error('A load-generation run is already active.');
        error.statusCode = 409;
        throw error;
      }
      options = validateStartOptions(input);
      active = true;
      targetIndex = 0;
      metrics.start(options);
      interval = setInterval(() => {
        sendBatch().catch((error) => console.error(`Load batch failed: ${error.message}`));
      }, 100);
      durationTimer = setTimeout(finish, options.durationSeconds * 1000);
      return metrics.snapshot();
    },
    stop() {
      if (active) finish();
      return metrics.snapshot();
    },
    status() {
      return metrics.snapshot();
    }
  };
}

module.exports = { createLoadRunner };
