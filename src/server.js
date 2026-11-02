const apm = require('./apm'); // first line: APM instruments what is required after it
const path = require('node:path');
const express = require('express');
const elastic = require('./elastic');
const { WEATHERS, plotCourse, crossingTime, lightTheLamp, LampError, shipLog, seedShips, sleep } = require('./ships');

// The 7 platform variables shown in the "Running on Clever Cloud" panel. Nothing else is exposed.
function platform(env = process.env) {
  return {
    CC_APP_NAME: env.CC_APP_NAME || null,
    APP_ID: env.APP_ID || null,
    INSTANCE_NUMBER: env.INSTANCE_NUMBER ?? null,
    INSTANCE_TYPE: env.INSTANCE_TYPE || null,
    CC_PRETTY_INSTANCE_NAME: env.CC_PRETTY_INSTANCE_NAME || null,
    CC_COMMIT_ID: env.CC_COMMIT_ID ? env.CC_COMMIT_ID.slice(0, 7) : null,
    CC_DEPLOYMENT_ID: env.CC_DEPLOYMENT_ID || null,
  };
}

// Kibana links, built from the Kibana host the add-on injects (Kibana itself sits behind Clever Cloud SSO).
function kibanaLinks(env = process.env) {
  if (!env.ES_ADDON_KIBANA_HOST) return null;
  const base = `https://${env.ES_ADDON_KIBANA_HOST}`;
  return {
    home: base,
    discover: `${base}/app/discover`,
    apm: `${base}/app/apm/services/the-lighthouse/overview`,
    errors: `${base}/app/apm/services/the-lighthouse/transactions`,
    trace: `${base}/app/apm/link-to/trace/`,
  };
}

// A tiny per-instance speed limit, so a public URL cannot flood the index.
function harbourMaster(maxPerSecond = 40) {
  let windowStart = 0;
  let count = 0;
  return (req, res, next) => {
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; count = 0; }
    if (++count > maxPerSecond) return res.status(429).json({ error: 'The harbour is full. Try again in a second.' });
    next();
  };
}

// One JSON line per ship on stdout: a Clever Cloud log drain can ship these lines to Elasticsearch too.
function logLine(doc) {
  const { log, message, ship, outcome, weather, duration_ms: durationMs, trace } = doc;
  console.log(JSON.stringify({ level: log.level, message, ship: ship.name, outcome, weather, duration_ms: durationMs, trace_id: trace?.id }));
}

function createApp({ es, ready = Promise.resolve(), env = process.env } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2kb' }));
  app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets'), { maxAge: '1h' }));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // Routes that need the add-on wait until the index template exists.
  const needsElastic = async (req, res, next) => {
    if (!es) return res.status(503).json({ error: 'Elasticsearch is not configured: link the Elastic Stack add-on.' });
    await ready;
    next();
  };

  // Health: /health never touches the add-on, /health/deep asks the cluster.
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/health/deep', async (req, res) => {
    if (!es) return res.status(503).json({ status: 'unconfigured', elasticsearch: null });
    try {
      const health = await elastic.deepHealth(es);
      res.status(health.cluster === 'red' ? 503 : 200).json({ status: health.cluster === 'red' ? 'down' : 'ok', elasticsearch: health });
    } catch (err) {
      res.status(503).json({ status: 'down', error: err.message });
    }
  });

  app.get('/api/state', (req, res) => {
    res.json({ platform: platform(env), kibana: kibanaLinks(env), elastic: Boolean(es), apm: apm.isStarted() && Boolean(env.ES_ADDON_APM_HOST), index: elastic.INDEX });
  });

  // A ship asks for passage. Weather and lamp come from the levers of the control room.
  app.post('/api/ships', harbourMaster(), needsElastic, async (req, res, next) => {
    const weather = WEATHERS.includes(req.body?.weather) ? req.body.weather : 'clear';
    const lamp = req.body?.lamp === 'broken' ? 'broken' : 'ok';
    const started = performance.now();
    const ship = plotCourse();
    apm.setLabel('ship', ship.name);
    apm.setLabel('weather', weather);
    const log = (outcome, status, error) => shipLog({
      ship, weather, lamp, outcome, status, error, durationMs: performance.now() - started, traceIds: apm.currentTraceIds,
    });
    try {
      const span = apm.startSpan(weather === 'fog' ? 'Hold in the fog' : 'Cross the bay', 'voyage');
      await sleep(crossingTime(weather));
      span?.end();
      lightTheLamp(lamp); // throws a LampError when the lamp lever is pulled
      const doc = log(weather === 'fog' ? 'delayed' : 'docked', 201);
      apm.setLabel('outcome', doc.outcome);
      const { id, op } = await elastic.indexShip(es, doc);
      logLine(doc);
      res.status(201).json({ id, ship: doc, es: op });
    } catch (err) {
      if (!(err instanceof LampError)) return next(err);
      // A wreck: the error and its stack trace go to APM, the wreck goes to the log (level "error").
      apm.captureError(err);
      apm.setLabel('outcome', 'wrecked');
      apm.setLabel('lamp_error', err.message);
      const doc = log('wrecked', 500, err);
      const { id, op } = await elastic.indexShip(es, doc);
      logLine(doc);
      res.status(500).json({ error: err.message, id, ship: doc, es: op });
    }
  });

  app.get('/api/ships/search', needsElastic, async (req, res, next) => {
    const q = String(req.query.q || '').trim().slice(0, 64);
    if (!q) return res.status(400).json({ error: 'Give a ship name to search for, for example "gull".' });
    try {
      res.json(await elastic.searchShips(es, q));
    } catch (err) { next(err); }
  });

  app.get('/api/ships/:id', needsElastic, async (req, res, next) => {
    try {
      res.json(await elastic.getShip(es, req.params.id));
    } catch (err) {
      if (err.meta?.statusCode === 404) return res.status(404).json({ error: 'No ship with this id in the log.' });
      next(err);
    }
  });

  app.get('/api/harbour', needsElastic, async (req, res, next) => {
    try {
      res.json(await elastic.harbour(es));
    } catch (err) { next(err); }
  });

  app.get('/api/drain', needsElastic, async (req, res, next) => {
    try {
      res.json(await elastic.drained(es));
    } catch (err) { next(err); }
  });

  // Elasticsearch unreachable or refusing: say so (APM records the error too).
  app.use((err, req, res, next) => {
    console.error(JSON.stringify({ level: 'error', message: err.message }));
    res.status(502).json({ error: `Elasticsearch did not answer: ${err.message}` });
  });

  return app;
}

// Listen first (the health check must answer fast), then prepare the index and the seed fleet.
async function prepare(es) {
  try {
    await elastic.prepareIndex(es);
    const created = await elastic.seed(es, seedShips());
    console.log(JSON.stringify({ level: 'info', message: `index ${elastic.INDEX} ready, ${created} seed ships added` }));
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: `Elasticsearch setup failed: ${err.message}` }));
  }
  try {
    const hooks = await elastic.singleNodeApm(es);
    console.log(JSON.stringify({ level: 'info', message: `APM data streams set to 0 replica (${hooks} @custom templates checked)` }));
  } catch (err) {
    console.error(JSON.stringify({ level: 'warn', message: `APM replica settings not changed: ${err.message}` }));
  }
}

function main() {
  const es = elastic.createClient();
  if (!es) console.warn('ES_ADDON_HOST is not set: the lighthouse runs without Elasticsearch.');
  const ready = es ? prepare(es) : Promise.resolve();
  const port = Number(process.env.PORT) || 8080;
  createApp({ es, ready }).listen(port, '0.0.0.0', () => console.log(`The lighthouse is lit on port ${port}`));
}

if (require.main === module) main();

module.exports = { createApp, platform, kibanaLinks };
