// Everything the app asks Elasticsearch. Each call returns the request it ran
// (method, path, body) and what came back, so the page can show it.
const { Client } = require('@elastic/elasticsearch');

const INDEX = 'lighthouse-ships';

// The Elastic Stack add-on injects ES_ADDON_HOST, ES_ADDON_USER and ES_ADDON_PASSWORD.
function createClient(env = process.env) {
  if (!env.ES_ADDON_HOST) return null;
  return new Client({
    node: `https://${env.ES_ADDON_HOST}`,
    auth: { username: env.ES_ADDON_USER, password: env.ES_ADDON_PASSWORD },
    requestTimeout: 8000,
  });
}

const MAPPINGS = {
  properties: {
    '@timestamp': { type: 'date' },
    message: { type: 'text' },
    log: { properties: { level: { type: 'keyword' } } },
    service: { properties: { name: { type: 'keyword' } } },
    ship: {
      properties: {
        // search_as_you_type: "gul" already finds "Morning Gull"
        name: { type: 'search_as_you_type', fields: { keyword: { type: 'keyword' } } },
        type: { type: 'keyword' },
        cargo: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        from: { type: 'keyword' },
        tonnage: { type: 'integer' },
      },
    },
    weather: { type: 'keyword' },
    lamp: { type: 'keyword' },
    outcome: { type: 'keyword' },
    duration_ms: { type: 'float' },
    http: { properties: { response: { properties: { status_code: { type: 'short' } } } } },
    trace: { properties: { id: { type: 'keyword' } } },
    transaction: { properties: { id: { type: 'keyword' } } },
    error: {
      properties: {
        type: { type: 'keyword' },
        message: { type: 'text' },
        stack_trace: { type: 'text', index: false },
      },
    },
  },
};

// An index created before the template exists (a write that reached Elasticsearch first) gets a
// dynamic mapping: "outcome" becomes "text" and the aggregations fail with a "fielddata" error.
// These are the fields the searches sort and aggregate on.
const EXPECTED_TYPES = { '@timestamp': 'date', outcome: 'keyword', duration_ms: 'float', 'ship.name': 'search_as_you_type' };

class MappingError extends Error {
  constructor(problems) {
    super(`The index ${INDEX} exists with the wrong mapping (${problems.join(', ')}): it was created without the index template. `
      + `Delete it (DELETE /${INDEX} in Kibana Dev Tools), the app then recreates it with the template and the seed ships.`);
    this.name = 'MappingError';
  }
}

async function checkMapping(es) {
  const res = await es.indices.getMapping({ index: INDEX });
  const root = Object.values(res)[0]?.mappings || {};
  const problems = Object.entries(EXPECTED_TYPES).flatMap(([field, expected]) => {
    const found = field.split('.').reduce((node, key) => node?.properties?.[key], root)?.type || 'missing';
    return found === expected ? [] : [`${field} is "${found}", expected "${expected}"`];
  });
  if (problems.length) throw new MappingError(problems);
}

// Single-node add-on: 1 shard, 0 replica, priority above the add-on's default
// template (see "Create an index on Elasticsearch" in the Clever Cloud doc).
// Throws while Elasticsearch does not answer yet (the caller retries), and a
// MappingError when the index already exists without the template's mapping.
async function prepareIndex(es) {
  await es.indices.putIndexTemplate({
    name: INDEX,
    index_patterns: [`${INDEX}*`],
    priority: 200,
    template: { settings: { number_of_shards: 1, number_of_replicas: 0 }, mappings: MAPPINGS },
  });
  // The Clever log drain writes daily "lighthouse-drain-YYYY-MM-DD" indices: same single-node settings.
  await es.indices.putIndexTemplate({
    name: 'lighthouse-drain',
    index_patterns: ['lighthouse-drain-*'],
    priority: 200,
    template: { settings: { number_of_shards: 1, number_of_replicas: 0 } },
  });
  if (await es.indices.exists({ index: INDEX })) await checkMapping(es);
  else await es.indices.create({ index: INDEX });
}

// The add-on is a single node, so a replica can never be assigned. The APM option creates
// data streams with 1 replica, which turns the cluster "yellow". Give them 0 replicas, through
// the "@custom" component templates Elastic provides for this, and on the existing indices.
async function singleNodeApm(es) {
  const { index_templates: templates } = await es.indices.getIndexTemplate({ name: '*apm*' });
  const hooks = new Set(templates.flatMap((t) => t.index_template.composed_of || []).filter((n) => n.endsWith('@custom')));
  for (const name of hooks) {
    if (!(await es.cluster.existsComponentTemplate({ name }))) {
      await es.cluster.putComponentTemplate({ name, template: { settings: { number_of_replicas: 0 } } });
    }
  }
  await es.indices.putSettings({
    index: 'traces-apm*,metrics-apm*,logs-apm*',
    expand_wildcards: 'all',
    allow_no_indices: true,
    settings: { number_of_replicas: 0 },
  });
  return hooks.size;
}

// Idempotent: fixed ids + "create" means a second boot changes nothing.
async function seed(es, ships) {
  const operations = ships.flatMap(({ id, doc }) => [{ create: { _index: INDEX, _id: id } }, doc]);
  const res = await es.bulk({ operations, refresh: 'wait_for' });
  // 201 = created, 409 = already there. Anything else means the seed is not in place.
  const failed = res.items.find((item) => ![201, 409].includes(item.create.status));
  if (failed) throw new Error(`seed ship ${failed.create._id} refused (HTTP ${failed.create.status})`);
  return res.items.filter((item) => item.create.status === 201).length;
}

async function timed(fn) {
  const started = performance.now();
  const result = await fn();
  return { result, ms: Math.round((performance.now() - started) * 10) / 10 };
}

async function indexShip(es, doc) {
  const { result, ms } = await timed(() => es.index({ index: INDEX, document: doc }));
  return {
    id: result._id,
    op: { kind: 'index', method: 'POST', path: `/${INDEX}/_doc`, body: doc, ms, result: result.result, id: result._id },
  };
}

async function getShip(es, id) {
  const { result, ms } = await timed(() => es.get({ index: INDEX, id }));
  return {
    doc: { id: result._id, ...result._source },
    op: { kind: 'get', method: 'GET', path: `/${INDEX}/_doc/${id}`, ms, result: result.found ? 'found' : 'not_found' },
  };
}

function searchBody(q) {
  return {
    size: 8,
    query: {
      bool: {
        should: [
          { multi_match: { query: q, type: 'bool_prefix', fields: ['ship.name', 'ship.name._2gram', 'ship.name._3gram'], boost: 3 } },
          { match: { 'ship.name': { query: q, fuzziness: 'AUTO', boost: 2 } } },
          { multi_match: { query: q, fields: ['message', 'ship.cargo'] } },
        ],
        minimum_should_match: 1,
      },
    },
    sort: ['_score', { '@timestamp': 'desc' }],
    highlight: { pre_tags: ['['], post_tags: [']'], fields: { 'ship.name': {} } },
    aggs: { ships: { terms: { field: 'ship.name.keyword', size: 5 } } },
  };
}

async function searchShips(es, q) {
  const body = searchBody(q);
  const { result, ms } = await timed(() => es.search({ index: INDEX, ...body }));
  return {
    took: result.took,
    total: result.hits.total.value,
    hits: result.hits.hits.map((h) => ({ id: h._id, score: h._score, highlight: h.highlight?.['ship.name']?.[0], ...h._source })),
    names: result.aggregations.ships.buckets.map((b) => ({ name: b.key, sightings: b.doc_count })),
    op: { kind: 'search', method: 'GET', path: `/${INDEX}/_search`, body, ms, took: result.took, result: `${result.hits.total.value} hits` },
  };
}

// One request feeds the lamp room: the latest ships plus three aggregations.
function harbourBody() {
  return {
    size: 12,
    sort: [{ '@timestamp': 'desc' }],
    _source: ['@timestamp', 'ship', 'outcome', 'weather', 'duration_ms', 'trace.id', 'http.response.status_code'],
    track_total_hits: true,
    aggs: {
      last_minute: {
        filter: { range: { '@timestamp': { gte: 'now-1m' } } },
        aggs: { p95: { percentiles: { field: 'duration_ms', percents: [95] } } },
      },
      last_5m: {
        filter: { range: { '@timestamp': { gte: 'now-5m' } } },
        aggs: { outcomes: { terms: { field: 'outcome' } } },
      },
    },
  };
}

async function harbour(es) {
  const body = harbourBody();
  const { result, ms } = await timed(() => es.search({ index: INDEX, ...body }));
  const minute = result.aggregations.last_minute;
  const outcomes = Object.fromEntries(result.aggregations.last_5m.outcomes.buckets.map((b) => [b.key, b.doc_count]));
  return {
    took: result.took,
    total: result.hits.total.value,
    shipsPerMinute: minute.doc_count,
    p95: minute.doc_count ? Math.round(minute.p95.values['95.0']) : null,
    last5m: { docked: outcomes.docked || 0, delayed: outcomes.delayed || 0, wrecked: outcomes.wrecked || 0 },
    latest: result.hits.hits.map((h) => ({ id: h._id, ...h._source })),
    op: { kind: 'aggregation', method: 'GET', path: `/${INDEX}/_search`, body, ms, took: result.took },
  };
}

// The app's stdout, shipped by a Clever Cloud log drain into daily "lighthouse-drain-*" indices.
async function drained(es) {
  const body = { size: 1, sort: [{ date: { order: 'desc', unmapped_type: 'date' } }], _source: ['date', 'message'], track_total_hits: true };
  const { result } = await timed(() => es.search({ index: 'lighthouse-drain-*', allow_no_indices: true, ignore_unavailable: true, ...body }));
  const last = result.hits.hits[0];
  return {
    total: result.hits.total.value,
    last: last ? { index: last._index, date: last._source.date, message: last._source.message } : null,
    took: result.took,
  };
}

async function deepHealth(es) {
  const { result, ms } = await timed(() => es.cluster.health());
  const info = await es.info();
  return { cluster: result.status, version: info.version.number, ms };
}

module.exports = { INDEX, MappingError, createClient, prepareIndex, singleNodeApm, seed, indexShip, getShip, searchShips, searchBody, harbour, harbourBody, drained, deepHealth };
