// Route tests with an in-memory stand-in for the Elasticsearch client (no add-on needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, platform } = require('../src/server');

function fakeElastic() {
  const docs = new Map();
  return {
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
    cluster: { health: async () => ({ status: 'green' }) },
    info: async () => ({ version: { number: '9.2.3' } }),
  };
}

async function start(es) {
  const server = createApp({ es, env: {} }).listen(0);
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
