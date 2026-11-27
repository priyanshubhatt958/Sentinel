const { targetUrls, validateStartOptions } = require('./config');
const { sendRequest } = require('./httpClient');
const { createMetricsStore } = require('./metrics');
const logger = require('./logger');

function createLoadRunner({ requestSender = sendRequest, now = Date.now } = {}) {
  const metrics = createMetricsStore({ now });
  let active = false;
  let requestTimer = null;
  let durationTimer = null;
  let options = null;
  let targetIndex = 0;
  let runStartedAt = null;
  let nextRequestAt = null;
  let runController = null;

  function targetList() {
    return options.targetService === 'all' ? Object.keys(targetUrls) : [options.targetService];
  }

  function scheduleRequest() {
    if (!active) return;
    const targetTime = nextRequestAt;
    requestTimer = setTimeout(() => {
      if (!active) return;
      const targets = targetList();
      const service = targets[targetIndex % targets.length];
      targetIndex += 1;
      requestSender(service, targetUrls[service], options.scenario, { signal: runController.signal })
        .then((result) => metrics.record(result))
        .catch((error) => logger.error('load_request_failed', { service, message: error.message }));
      nextRequestAt = Math.max(targetTime, now()) + (1000 / options.requestsPerSecond);
      scheduleRequest();
    }, Math.max(0, targetTime - now()));
  }

  function finish() {
    if (!active) return;
    active = false;
    clearTimeout(requestTimer);
    clearTimeout(durationTimer);
    requestTimer = null;
    durationTimer = null;
    if (runController && !runController.signal.aborted) runController.abort();
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
      runStartedAt = now();
      nextRequestAt = runStartedAt;
      runController = new AbortController();
      metrics.start(options);
      scheduleRequest();
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
