// Elastic APM must start before anything else is required, so that it can
// instrument Express and the Elasticsearch client. The Elastic Stack add-on
// (APM option) injects ES_ADDON_APM_HOST and ES_ADDON_APM_AUTH_TOKEN.
const apm = require('elastic-apm-node');

const apmHost = process.env.ES_ADDON_APM_HOST;

module.exports = apm.start({
  active: Boolean(apmHost),
  serviceName: 'the-lighthouse',
  serviceVersion: (process.env.CC_COMMIT_ID || 'local').slice(0, 7),
  environment: process.env.CC_APP_NAME ? 'clever-cloud' : 'local',
  ...(apmHost && { serverUrl: `https://${apmHost}`, secretToken: process.env.ES_ADDON_APM_AUTH_TOKEN }),
  // Keep APM about ships: no health checks, polling or static files.
  transactionIgnoreUrls: ['/', '/health', '/health/*', '/api/harbour', '/api/state', '/api/drain', '/assets/*'],
  captureBody: 'off',
  centralConfig: false,
  logLevel: 'warn',
});
