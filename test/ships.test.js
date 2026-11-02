const test = require('node:test');
const assert = require('node:assert/strict');
const { plotCourse, crossingTime, lightTheLamp, LampError, shipLog, seedShips } = require('../src/ships');
const { searchBody, harbourBody } = require('../src/elastic');

test('a ship has a name, a type, a cargo and a home port', () => {
  const ship = plotCourse();
  assert.match(ship.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  assert.ok(['schooner', 'steamer', 'trawler'].includes(ship.type));
  assert.ok(ship.cargo && ship.from && ship.tonnage > 0);
});

test('fog makes the crossing slow, clear weather keeps it fast', () => {
  for (let i = 0; i < 50; i++) {
    assert.ok(crossingTime('fog') >= 900);
    assert.ok(crossingTime('clear') <= 90);
  }
});

test('a broken lamp throws a LampError with a stack trace', () => {
  assert.doesNotThrow(() => lightTheLamp('ok'));
  assert.throws(() => lightTheLamp('broken'), (err) => err instanceof LampError && err.stack.includes('turnTheLens'));
});

test('the log line uses ECS fields and links to the APM trace', () => {
  const doc = shipLog({
    ship: plotCourse(), weather: 'fog', lamp: 'ok', outcome: 'delayed', durationMs: 1234.56, status: 201,
    traceIds: { 'trace.id': 'abc', 'transaction.id': 'def' },
  });
  assert.equal(doc.trace.id, 'abc');
  assert.equal(doc.transaction.id, 'def');
  assert.equal(doc.http.response.status_code, 201);
  assert.equal(doc.log.level, 'info');
  assert.equal(doc.duration_ms, 1234.6);
  assert.match(doc.message, /late, out of the fog/);
});

test('a wreck is logged as an error with its stack trace', () => {
  const err = new LampError('lens jammed');
  const doc = shipLog({ ship: plotCourse(), weather: 'clear', lamp: 'broken', outcome: 'wrecked', durationMs: 12, status: 500, error: err });
  assert.equal(doc.log.level, 'error');
  assert.equal(doc.error.type, 'LampError');
  assert.ok(doc.error.stack_trace.includes('lens jammed'));
});

test('the seed fleet is the same on every boot (idempotent ids and ships)', () => {
  const a = seedShips(1_700_000_000_000);
  const b = seedShips(1_700_000_000_000);
  assert.equal(a.length, 48);
  assert.deepEqual(a.map((s) => s.id), b.map((s) => s.id));
  assert.deepEqual(a.map((s) => s.doc.ship.name), b.map((s) => s.doc.ship.name));
  assert.ok(a.some((s) => s.doc.outcome === 'wrecked'));
});

test('the search query is a full-text, typo-tolerant, search-as-you-type query', () => {
  const body = searchBody('gul');
  const json = JSON.stringify(body);
  assert.ok(json.includes('"bool_prefix"'));
  assert.ok(json.includes('"fuzziness":"AUTO"'));
  assert.ok(json.includes('"gul"'));
  assert.equal(body.highlight.fields['ship.name'] !== undefined, true);
});

test('the harbour query counts the last minute and the last five minutes', () => {
  const body = harbourBody();
  assert.equal(body.aggs.last_minute.filter.range['@timestamp'].gte, 'now-1m');
  assert.equal(body.aggs.last_5m.filter.range['@timestamp'].gte, 'now-5m');
});
