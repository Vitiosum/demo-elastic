// Ships are requests. This file invents them and simulates the weather they meet.

const FIRST = ['Morning', 'Iron', 'Northern', 'Silver', 'Saint', 'Grey', 'Brave', 'Quiet', 'Wild', 'Little',
  'Old', 'Amber', 'Salt', 'Blue', 'Lucky', 'Midnight', 'Copper', 'Gentle', 'Swift', 'Lantern'];
const SECOND = ['Gull', 'Wren', 'Petrel', 'Mariner', 'Heron', 'Anchor', 'Tern', 'Compass', 'Pilot', 'Puffin',
  'Selkie', 'Kestrel', 'Albatross', 'Cormorant', 'Otter', 'Star', 'Brendan', 'Lark', 'Shearwater', 'Swallow'];
const TYPES = ['schooner', 'steamer', 'trawler'];
const CARGO = ['tea', 'timber', 'wool', 'salt cod', 'copper ore', 'oranges', 'coal', 'mail', 'spices', 'slate',
  'cider', 'oysters'];
const PORTS = ['Brest', 'Saint-Malo', 'Lorient', 'Cherbourg', 'La Rochelle', 'Nantes', 'Bordeaux', 'Le Havre',
  'Roscoff', 'Concarneau', 'Douarnenez', 'Paimpol'];

const WEATHERS = ['clear', 'fog', 'storm'];

const pick = (list, rnd = Math.random) => list[Math.floor(rnd() * list.length)];
const between = (min, max, rnd = Math.random) => Math.round(min + rnd() * (max - min));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function plotCourse(rnd = Math.random) {
  return {
    name: `${pick(FIRST, rnd)} ${pick(SECOND, rnd)}`,
    type: pick(TYPES, rnd),
    cargo: pick(CARGO, rnd),
    from: pick(PORTS, rnd),
    tonnage: between(80, 2400, rnd),
  };
}

// How long the crossing takes, in ms of real server time.
function crossingTime(weather, rnd = Math.random) {
  if (weather === 'fog') return between(900, 2600, rnd); // the slow responses
  if (weather === 'storm') return between(40, 380, rnd);
  return between(10, 90, rnd);
}

class LampError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LampError';
  }
}

// A broken lamp throws from a few frames deep, so APM shows a real stack trace.
function lightTheLamp(lamp) {
  if (lamp === 'broken') turnTheLens();
}
function turnTheLens() {
  throw new LampError('Fresnel lens jammed: the lamp is dark and ships cannot see the rocks');
}

// The structured log line we keep in Elasticsearch for every ship (ECS field names).
function shipLog({ ship, weather, lamp, outcome, durationMs, status, traceIds = {}, error, at = new Date() }) {
  const verb = { docked: 'docked', delayed: 'docked late, out of the fog,', wrecked: 'was wrecked on the rocks' }[outcome];
  const doc = {
    '@timestamp': at.toISOString(),
    message: `${ship.name} ${verb} after ${Math.round(durationMs)} ms`,
    log: { level: outcome === 'wrecked' ? 'error' : 'info' },
    service: { name: 'the-lighthouse' },
    ship,
    weather,
    lamp,
    outcome,
    duration_ms: Math.round(durationMs * 10) / 10,
    http: { response: { status_code: status } },
  };
  if (traceIds['trace.id']) doc.trace = { id: traceIds['trace.id'] };
  if (traceIds['transaction.id']) doc.transaction = { id: traceIds['transaction.id'] };
  if (error) doc.error = { type: error.name, message: error.message, stack_trace: error.stack };
  return doc;
}

// 48 ships from the last hours, so the harbour log is never empty on first visit.
function seedShips(now = Date.now()) {
  let state = 7; // tiny deterministic random: same seed fleet on every boot
  const rnd = () => ((state = (state * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: 48 }, (_, i) => {
    const weather = i % 9 === 4 ? 'fog' : i % 13 === 6 ? 'storm' : 'clear';
    const lamp = i % 17 === 11 ? 'broken' : 'ok';
    const outcome = lamp === 'broken' ? 'wrecked' : weather === 'fog' ? 'delayed' : 'docked';
    const durationMs = crossingTime(weather, rnd);
    const doc = shipLog({
      ship: plotCourse(rnd), weather, lamp, outcome, durationMs,
      status: outcome === 'wrecked' ? 500 : 200,
      at: new Date(now - (48 - i) * 7 * 60 * 1000),
      error: lamp === 'broken' ? new LampError('Fresnel lens jammed: the lamp is dark and ships cannot see the rocks') : undefined,
    });
    return { id: `seed-${String(i + 1).padStart(2, '0')}`, doc };
  });
}

module.exports = { WEATHERS, plotCourse, crossingTime, lightTheLamp, LampError, shipLog, seedShips, sleep };
