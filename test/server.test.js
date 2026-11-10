// Route tests with an in-memory stand-in for the Elasticsearch client (no add-on needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, prepare, retryDelay, platform } = require('../src/server');

function fakeElastic() {
  const docs = new Map();
  const es = {
    docs,
    async index({ document }) {
      const id = `doc-${docs.size + 1}`;
      docs.set(id, document);
      return { _id: id, result: 'created' };
    },
    async get({ id }) {
      if (!docs.has(id)) throw Object.assign(new Error('not found'), { meta: { statusCode: 404 } });
      return { _id: id, found: true, _source: docs.get(id) };
    },
    async search({ index, query, aggs }) {
      if (index === 'lighthouse-drain-*') {
        const line = { date: '2026-11-01T10:00:00Z', message: '{"level":"info","message":"Iron Wren docked after 41 ms"}' };
        return { took: 1, hits: { total: { value: 1 }, hits: [{ _index: 'lighthouse-drain-2026-11-01', _source: line }] } };
      }
      const hits = [...docs.entries()].map(([id, d]) => ({ _id: id, _score: 1, _source: d }));
      if (aggs.ships) {
        const q = JSON.stringify(query).match(/"query":"([^"]+)"/)[1].toLowerCase();
        const found = hits.filter((h) => h._source.ship.name.toLowerCase().includes(q));
        return { took: 3, hits: { total: { value: found.length }, hits: found }, aggregations: { ships: { buckets: [] } } };
      }
      return {
        took: 2,
        hits: { total: { value: hits.length }, hits },
        aggregations: {
          last_minute: { doc_count: hits.length, p95: { values: { '95.0': 42 } } },
          last_5m: { outcomes: { buckets: [{ key: 'docked', doc_count: hits.length }] } },
        },
      };
    },
    // What the startup needs: templates, the index, its mapping and the seed fleet.
    templates: [],
    index_exists: false,
    mapping: null, // set to a dynamic mapping to play an index created without the template
    indices: {
      putIndexTemplate: async function ({ name, template }) { es.down(); es.templates.push(name); if (template.mappings) es.mapping ||= template.mappings; },
      exists: async () => es.index_exists,
      create: async () => { es.index_exists = true; },
      getMapping: async () => ({ 'lighthouse-ships': { mappings: es.mapping } }),
      getIndexTemplate: async () => ({ index_templates: [] }),
      putSettings: async () => ({}),
    },
    async bulk({ operations }) {
      const items = [];
      for (let i = 0; i < operations.length; i += 2) {
        const id = operations[i].create._id;
        items.push({ create: { _id: id, status: docs.has(id) ? 409 : 201 } });
        docs.set(id, operations[i + 1]);
      }
      return { items };
    },
    failures: 0, // the next N template calls fail like the add-on proxy before Elasticsearch is up
    down() { if (es.failures-- > 0) throw new Error('Response Error: 404'); },
    cluster: { health: async () => ({ status: 'green' }) },
    info: async () => ({ version: { number: '9.2.3' } }),
  };
  return es;
}

async function start(es, setup) {
  const server = createApp({ es, setup, env: {} }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

test('/health answers without Elasticsearch, /health/deep says it is missing', async (t) => {
  const app = await start(null);
  t.after(app.close);
  assert.equal((await fetch(`${app.base}/health`)).status, 200);
  const deep = await fetch(`${app.base}/health/deep`);
  assert.equal(deep.status, 503);
  assert.equal((await deep.json()).status, 'unconfigured');
  assert.equal((await fetch(`${app.base}/`)).status, 200);
});

test('/health/deep reports the cluster', async (t) => {
  const app = await start(fakeElastic());
  t.after(app.close);
  const res = await fetch(`${app.base}/health/deep`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).elasticsearch.version, '9.2.3');
});

test('a ship is written to the index, read back and found by name', async (t) => {
  const es = fakeElastic();
  const app = await start(es);
  t.after(app.close);
  const res = await fetch(`${app.base}/api/ships`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"weather":"clear"}' });
  assert.equal(res.status, 201);
  const sailed = await res.json();
  assert.equal(sailed.es.method, 'POST');
  assert.equal(sailed.es.path, '/lighthouse-ships/_doc');
  assert.equal(sailed.ship.outcome, 'docked');

  const read = await (await fetch(`${app.base}/api/ships/${sailed.id}`)).json();
  assert.equal(read.doc.ship.name, sailed.ship.ship.name);

  const word = sailed.ship.ship.name.split(' ')[1];
  const found = await (await fetch(`${app.base}/api/ships/search?q=${word}`)).json();
  assert.ok(found.total >= 1);
  assert.ok(found.op.body.query.bool.should.length === 3);
});

test('a broken lamp answers 500 and logs the wreck with its stack trace', async (t) => {
  const es = fakeElastic();
  const app = await start(es);
  t.after(app.close);
  const res = await fetch(`${app.base}/api/ships`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"lamp":"broken"}' });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /Fresnel lens jammed/);
  const doc = es.docs.get(body.id);
  assert.equal(doc.outcome, 'wrecked');
  assert.equal(doc.log.level, 'error');
  assert.ok(doc.error.stack_trace.includes('LampError'));
});

test('the harbour returns dials and the latest ships', async (t) => {
  const es = fakeElastic();
  const app = await start(es);
  t.after(app.close);
  await fetch(`${app.base}/api/ships`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const h = await (await fetch(`${app.base}/api/harbour`)).json();
  assert.equal(h.shipsPerMinute, 1);
  assert.equal(h.p95, 42);
  assert.equal(h.latest.length, 1);
});

test('an empty search is refused, and without the add-on the API says what to do', async (t) => {
  const withEs = await start(fakeElastic());
  t.after(withEs.close);
  assert.equal((await fetch(`${withEs.base}/api/ships/search?q=`)).status, 400);
  const without = await start(null);
  t.after(without.close);
  const res = await fetch(`${without.base}/api/harbour`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /link the Elastic Stack add-on/);
});

test('the drain route reads the lines Clever Cloud shipped to Elasticsearch', async (t) => {
  const app = await start(fakeElastic());
  t.after(app.close);
  const d = await (await fetch(`${app.base}/api/drain`)).json();
  assert.equal(d.total, 1);
  assert.equal(d.last.index, 'lighthouse-drain-2026-11-01');
  assert.match(d.last.message, /Iron Wren/);
});

test('the platform panel only exposes the 7 allowed variables', () => {
  const p = platform({ CC_APP_NAME: 'demo', CC_COMMIT_ID: '0123456789abcdef', ES_ADDON_PASSWORD: 'secret', APP_ID: 'app_x' });
  assert.deepEqual(Object.keys(p), ['CC_APP_NAME', 'APP_ID', 'INSTANCE_NUMBER', 'INSTANCE_TYPE', 'CC_PRETTY_INSTANCE_NAME', 'CC_COMMIT_ID', 'CC_DEPLOYMENT_ID']);
  assert.equal(p.CC_COMMIT_ID, '0123456');
  assert.ok(!JSON.stringify(p).includes('secret'));
});

const post = (base) => fetch(`${base}/api/ships`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const quiet = (t) => { t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {}); };

test('while Elasticsearch is not up, the app answers, refuses writes with 503 and retries with a growing delay', async (t) => {
  quiet(t);
  const es = fakeElastic();
  es.failures = 3;
  const setup = { phase: 'preparing', attempts: 0, error: null };
  const app = await start(es, setup);
  t.after(app.close);

  // Each wait is held until the test releases it, so the "preparing" state can be observed.
  const waits = [];
  const wait = (ms) => new Promise((release) => waits.push({ ms, release }));
  const done = prepare(es, setup, wait);
  while (waits.length < 1) await new Promise((r) => setImmediate(r));

  assert.equal((await fetch(`${app.base}/`)).status, 200);
  assert.deepEqual(await (await fetch(`${app.base}/health`)).json(), { status: 'ok', setup: 'preparing' });
  const refused = await post(app.base);
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /getting ready/);
  assert.equal((await fetch(`${app.base}/api/harbour`)).status, 503);
  assert.equal(es.docs.size, 0, 'nothing is written before the template exists');
  assert.equal((await (await fetch(`${app.base}/api/state`)).json()).setup.phase, 'preparing');

  for (let i = 0; i < 3; i += 1) {
    while (waits.length <= i) await new Promise((r) => setImmediate(r));
    waits[i].release();
  }
  await done;
  assert.deepEqual(waits.map((w) => w.ms), [1000, 2000, 4000]);
  assert.equal(setup.phase, 'ready');
  assert.deepEqual(es.templates, ['lighthouse-ships', 'lighthouse-drain']);
  assert.equal(es.docs.size, 48);
  assert.equal((await post(app.base)).status, 201);
  assert.equal((await (await fetch(`${app.base}/api/harbour`)).json()).total, 49);
});

test('the retry delay doubles and stops at 30 s', () => {
  assert.deepEqual([1, 2, 3, 5, 6, 7, 40].map((n) => retryDelay(n)), [1000, 2000, 4000, 16000, 30000, 30000, 30000]);
});

test('an index created without the template is reported, then accepted once it is deleted', async (t) => {
  quiet(t);
  const es = fakeElastic();
  es.index_exists = true;
  es.mapping = { properties: { '@timestamp': { type: 'date' }, outcome: { type: 'text' }, duration_ms: { type: 'float' }, ship: { properties: { name: { type: 'text' } } } } };
  const setup = { phase: 'preparing', attempts: 0, error: null };
  const app = await start(es, setup);
  t.after(app.close);

  const waits = [];
  const done = prepare(es, setup, (ms) => new Promise((release) => waits.push({ ms, release })));
  while (waits.length < 1) await new Promise((r) => setImmediate(r));

  assert.equal(setup.phase, 'bad-mapping');
  const res = await fetch(`${app.base}/api/harbour`);
  assert.equal(res.status, 503);
  const { error } = await res.json();
  assert.match(error, /wrong mapping \(outcome is "text", expected "keyword", ship\.name is "text", expected "search_as_you_type"\)/);
  assert.match(error, /DELETE \/lighthouse-ships/);
  assert.equal((await post(app.base)).status, 503);
  assert.equal(es.docs.size, 0);

  // The index is deleted by hand: the next attempt recreates it from the template, no restart.
  es.index_exists = false;
  es.mapping = null;
  waits[0].release();
  await done;
  assert.equal(setup.phase, 'ready');
  assert.equal(es.docs.size, 48);
});

test('a second start adds no seed ship', async (t) => {
  quiet(t);
  const es = fakeElastic();
  for (let boot = 0; boot < 2; boot += 1) await prepare(es, { phase: 'preparing', attempts: 0, error: null }, async () => {});
  assert.equal(es.docs.size, 48);
});
