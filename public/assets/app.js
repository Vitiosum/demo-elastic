// The control room: levers, harbour traffic, search, logbook and dials.
(function () {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const scene = new window.LighthouseScene($('#scene'));

  const LEVERS = {
    fog: { seconds: 15, idle: 'Slow replies for 15 s', on: (s) => `Fog on the bay, ${s} s left` },
    storm: { seconds: 10, idle: 'A burst of 32 ships', on: (s) => `Storm, ${s} s left` },
    lamp: { seconds: 12, idle: 'Break it: errors with stack traces for 12 s', on: (s) => `Lamp dark, ${s} s left` },
  };
  const state = {
    kibana: null,
    until: { fog: 0, storm: 0, lamp: 0 },
    lastTouch: Date.now(),
    inFlight: 0,
    harbour: null,
    error: null,
  };
  const ASLEEP_AFTER = 10 * 60 * 1000;

  // ---------- small helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const active = (lever) => state.until[lever] > Date.now();
  const clock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
  const ago = (iso) => {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
  };
  const OUTCOME = { docked: 'docked', delayed: 'late', wrecked: 'wrecked' };
  const outcome = (o) => `<span class="outcome outcome--${esc(o)}">${OUTCOME[o] || esc(o)}</span>`;
  const nameHtml = (highlighted) => esc(highlighted).replace(/\[/g, '<mark>').replace(/\]/g, '</mark>');

  async function api(path, options) {
    const res = await fetch(path, options);
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  // JSON, compact where it fits on a line, then coloured token by token.
  function compact(value, indent = '') {
    const flat = JSON.stringify(value);
    if (value === null || typeof value !== 'object' || flat.length <= 62) return flat;
    const next = `${indent}  `;
    if (Array.isArray(value)) return `[\n${value.map((v) => next + compact(v, next)).join(',\n')}\n${indent}]`;
    const lines = Object.entries(value).map(([k, v]) => `${next}${JSON.stringify(k)}: ${compact(v, next)}`);
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  function jsonHtml(value) {
    const src = compact(value);
    const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
    let out = '';
    let last = 0;
    for (const m of src.matchAll(re)) {
      out += esc(src.slice(last, m.index));
      if (m[1]) out += m[2] ? `<span class="j-key">${esc(m[1])}</span>${m[2]}` : `<span class="j-str">${esc(m[1])}</span>`;
      else if (m[3]) out += `<span class="j-num">${m[3]}</span>`;
      else out += `<span class="j-lit">${m[4]}</span>`;
      last = m.index + m[0].length;
    }
    return out + esc(src.slice(last));
  }

  // ---------- status line under the title ----------
  function narrate() {
    const el = $('#status');
    const h = state.harbour;
    const rpm = Math.round(scene.turnsPerMinute);
    let text;
    if (state.error) text = state.error;
    else if (active('lamp')) text = 'The lamp is broken: ships hit the rocks and the app answers <b>HTTP 500</b>. Each wreck goes to APM with its stack trace.';
    else if (active('storm')) text = 'Storm: a burst of ships hits the harbour at once. Watch the beam speed up.';
    else if (active('fog')) text = 'Fog on the bay: replies take <b>0.9 to 2.6 s</b>. APM shows the time spent in a <b>Hold in the fog</b> span.';
    else if (scene.searching) text = 'The beam is fixed on the ship you searched for.';
    else if (Date.now() - state.lastTouch > ASLEEP_AFTER) text = 'The harbour is quiet. Pull a lever or search the log to wake it up.';
    else if (h) text = `Clear night. <b>${h.shipsPerMinute}</b> ship${h.shipsPerMinute === 1 ? '' : 's'} in the last minute, so the beam turns <b>${rpm}</b> times a minute.`;
    else text = 'Lighting the lamp…';
    el.innerHTML = text;
    el.classList.toggle('is-alarm', Boolean(state.error) || active('lamp'));
  }

  // ---------- ships ----------
  function weather() {
    if (active('storm')) return 'storm';
    if (active('fog')) return 'fog';
    return 'clear';
  }

  async function sendShip(forced) {
    state.inFlight += 1;
    const payload = { weather: forced || weather(), lamp: active('lamp') ? 'broken' : 'ok' };
    try {
      const { ok, status, body } = await api('/api/ships', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (body.ship) {
        scene.launchShip({ name: body.ship.ship.name, type: body.ship.ship.type, outcome: body.ship.outcome });
        addToTape(body);
        state.error = null;
      } else if (!ok) {
        if (status === 429) state.error = 'The harbour is full for a second (HTTP 429).';
        else if (body.setup) state.error = esc(body.error); // index template and seed ships not in place yet
        else state.error = `No ship could sail: ${esc(body.error || `HTTP ${status}`)}`;
      }
    } catch (err) {
      state.error = 'The harbour does not answer. Is the app running?';
    } finally {
      state.inFlight -= 1;
    }
  }

  // Background traffic: one ship every ~2.6 s, faster while a lever is pulled.
  function traffic() {
    const awake = Date.now() - state.lastTouch < ASLEEP_AFTER;
    if (!document.hidden && awake && state.inFlight < 6) sendShip();
    const busy = active('fog') || active('lamp');
    setTimeout(traffic, (busy ? 1300 : 2600) + Math.random() * 600);
  }

  async function stormBurst(count = 32, crew = 4) {
    let left = count;
    const sailor = async () => {
      while (left > 0 && active('storm')) {
        left -= 1;
        await sendShip('storm');
        await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
      }
    };
    await Promise.all(Array.from({ length: crew }, sailor));
  }

  // ---------- levers ----------
  function pull(lever) {
    state.lastTouch = Date.now();
    if (active(lever)) { state.until[lever] = 0; refreshLevers(); return; } // pull again to release
    state.until[lever] = Date.now() + LEVERS[lever].seconds * 1000;
    if (lever === 'storm') stormBurst();
    if (lever === 'lamp') sendShip();
    if (lever === 'fog') { sendShip(); sendShip(); }
    refreshLevers();
  }

  function refreshLevers() {
    for (const [name, cfg] of Object.entries(LEVERS)) {
      const btn = document.querySelector(`.lever[data-lever="${name}"]`);
      const left = Math.ceil((state.until[name] - Date.now()) / 1000);
      const on = left > 0;
      btn.setAttribute('aria-pressed', String(on));
      btn.querySelector('.lever__cap').textContent = on ? cfg.on(left) : cfg.idle;
    }
    const h = state.harbour;
    const p95Fog = h && h.p95 ? Math.max(0, Math.min(1, (h.p95 - 400) / 1600)) : 0;
    scene.setFog(active('fog') ? 0.85 : p95Fog * 0.6);
    scene.setStorm(active('storm') ? 1 : 0);
    scene.setLamp(!active('lamp'));
    narrate();
  }

  document.querySelectorAll('.lever').forEach((btn) => btn.addEventListener('click', () => pull(btn.dataset.lever)));
  setInterval(refreshLevers, 500);

  // ---------- dials ----------
  const DIALS = [
    { key: 'spm', label: 'Ships in the last minute', max: 80, unit: '' },
    { key: 'p95', label: 'Slowest 5 %, last minute', max: 3000, unit: 'ms' },
    { key: 'wrecks', label: 'Wrecks, last 5 minutes', max: 20, unit: '', alarm: 1 },
  ];
  function dialSvg() {
    const ticks = Array.from({ length: 11 }, (_, i) => {
      const a = (-120 + i * 24) * (Math.PI / 180);
      const r1 = i % 5 === 0 ? 46 : 50;
      return `<line x1="${70 + Math.sin(a) * r1}" y1="${70 - Math.cos(a) * r1}" x2="${70 + Math.sin(a) * 56}" y2="${70 - Math.cos(a) * 56}" stroke="#c9a35b" stroke-width="${i % 5 === 0 ? 2 : 1}" stroke-linecap="round"/>`;
    }).join('');
    return `<svg viewBox="0 0 140 140" aria-hidden="true">
      <circle cx="70" cy="70" r="68" fill="url(#g-brass)"/>
      <circle cx="70" cy="70" r="61" fill="url(#g-dial)" stroke="#3a2a10" stroke-width="1.5"/>
      <path d="M 26.7 95 A 50 50 0 0 1 22 52" fill="none" stroke="rgba(17,190,169,.6)" stroke-width="3"/>
      <path d="M 113.3 95 A 50 50 0 0 0 118 52" fill="none" stroke="rgba(239,85,96,.65)" stroke-width="3"/>
      ${ticks}
      <text class="dial__num" x="70" y="108" text-anchor="middle">–</text>
      <g class="dial__needle" style="transform: rotate(-120deg)">
        <path d="M70 76 L67.6 68 L70 24 L72.4 68 Z" fill="#ffd27f"/>
      </g>
      <circle cx="70" cy="70" r="6.5" fill="url(#g-brass)"/>
    </svg>`;
  }
  $('#dials').innerHTML = DIALS.map((d) => `
    <div class="dial" data-dial="${d.key}">
      ${dialSvg()}
      <div class="dial__label">${d.label}${d.unit ? ` (${d.unit})` : ''}</div>
    </div>`).join('');

  function setDial(key, value) {
    const d = DIALS.find((x) => x.key === key);
    const el = document.querySelector(`[data-dial="${key}"]`);
    const angle = -120 + 240 * Math.min(1, (value || 0) / d.max);
    el.querySelector('.dial__needle').style.transform = `rotate(${angle}deg)`;
    el.querySelector('.dial__num').textContent = value === null ? '–' : String(value);
    el.classList.toggle('dial--alarm', Boolean(d.alarm && value >= d.alarm));
  }

  // ---------- harbour: one search with aggregations, every 4 s ----------
  async function pollHarbour() {
    if (!document.hidden) {
      try {
        const { ok, body } = await api('/api/harbour');
        if (ok) {
          state.harbour = body;
          renderHarbour(body);
        } else {
          $('#ledger').innerHTML = '';
          $('#ledger-foot').textContent = body.error || 'Elasticsearch is not reachable.';
        }
      } catch { /* the status line already says the app is unreachable */ }
    }
    setTimeout(pollHarbour, 4000);
  }

  function renderHarbour(h) {
    setDial('spm', h.shipsPerMinute);
    setDial('p95', h.p95);
    setDial('wrecks', h.last5m.wrecked);
    scene.setRate(h.shipsPerMinute);
    $('#harbour-query').innerHTML = `<span class="req__method">${h.op.method}</span> ${esc(h.op.path)}   <span class="j-num">took ${h.took} ms</span>\n\n${jsonHtml(h.op.body)}`;
    $('#ledger').innerHTML = h.latest.map((s) => `
      <li>
        <span class="ledger__time">${clock(s['@timestamp'])}</span>
        <button class="ledger__name" type="button" data-name="${esc(s.ship.name)}">${esc(s.ship.name)}</button>
        <span class="ledger__ms">${Math.round(s.duration_ms)} ms</span>
        <span class="ledger__meta">${outcome(s.outcome)}<span>${esc(s.ship.type)} from ${esc(s.ship.from)}, ${esc(s.ship.cargo)}</span></span>
      </li>`).join('');
    $('#ledger-foot').innerHTML = `<b>${h.total.toLocaleString('en-GB')}</b> ships in <code>lighthouse-ships</code>. Read with one search every 4 s, took ${h.took} ms.`;
    renderTry(h.latest);
    if (!$('#search-card').dataset.done && h.latest.length) {
      // first visit: run one real search so the logbook is never empty
      const word = h.latest[0].ship.name.split(' ').pop().toLowerCase();
      search(word, { quiet: true });
    }
    refreshLevers();
  }

  $('#ledger').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-name]');
    if (btn) { $('#q').value = btn.dataset.name; search(btn.dataset.name); }
  });

  // ---------- search ----------
  function renderTry(latest) {
    const words = [...new Set(latest.map((s) => s.ship.name.split(' ').pop().toLowerCase()))].slice(0, 3);
    const chips = [...words, 'oranges'].map((w) => `<button class="hail__chip" type="button" data-q="${esc(w)}">${esc(w)}</button>`).join('');
    $('#try').innerHTML = `Try ${chips}`;
  }
  $('#try').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-q]');
    if (chip) { $('#q').value = chip.dataset.q; search(chip.dataset.q); }
  });

  let searchSeq = 0;
  async function search(q, { quiet = false } = {}) {
    q = q.trim();
    if (!q) return;
    if (!quiet) state.lastTouch = Date.now();
    const seq = ++searchSeq;
    const { ok, body } = await api(`/api/ships/search?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq) return;
    const card = $('#search-card');
    card.dataset.done = '1';
    if (!ok) {
      card.innerHTML = `<p class="deck__empty">${esc(body.error || 'The search failed.')}</p>`;
      return;
    }
    renderSearch(q, body);
    if (!quiet && body.total) showSighting(body);
  }

  function renderSearch(q, r) {
    const k = state.kibana;
    const hits = r.hits.map((h) => `
      <li class="hit">
        <span class="hit__name">${nameHtml(h.highlight || h.ship.name)}</span>
        <span class="hit__meta">${outcome(h.outcome)} · ${esc(h.ship.type)} from ${esc(h.ship.from)} with ${esc(h.ship.cargo)} · ${ago(h['@timestamp'])}</span>
        <span class="hit__side">${Math.round(h.duration_ms)} ms<br>${k && h.trace ? `<a href="${esc(k.trace + h.trace.id)}" target="_blank" rel="noopener">trace ↗</a>` : `score ${h.score?.toFixed(2) ?? '–'}`}</span>
      </li>`).join('');
    $('#search-card').innerHTML = `
      <div class="req"><span class="req__method">${r.op.method}</span><span class="req__path">${esc(r.op.path)}</span>
        <span class="req__meta">took <b>${r.took} ms</b> · <b>${r.total}</b> hit${r.total === 1 ? '' : 's'}</span></div>
      <pre class="query" aria-label="Elasticsearch query">${jsonHtml(r.op.body)}</pre>
      ${r.total ? `<ul class="hits">${hits}</ul>` : `<p class="deck__empty" style="margin-top:14px">No ship matches “${esc(q)}”. Try one of the names in the harbour log.</p>`}
      ${k ? `<div class="links"><a href="${esc(k.discover)}" target="_blank" rel="noopener">Open Discover in Kibana ↗</a><a href="${esc(k.apm)}" target="_blank" rel="noopener">Open APM ↗</a></div>` : ''}`;
  }

  function showSighting(r) {
    const name = r.hits[0].ship.name;
    scene.searchlight(name);
    const p = scene.sightPoint();
    const el = $('#sighting');
    el.innerHTML = `${esc(name)}<small>${r.total} match${r.total === 1 ? '' : 'es'} in the log · took ${r.took} ms</small>`;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y - 62}px`;
    el.hidden = false;
    clearTimeout(showSighting.timer);
    showSighting.timer = setTimeout(() => { el.hidden = true; }, 5800);
  }

  let typing;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(typing);
    const q = e.target.value;
    if (q.trim().length >= 2) typing = setTimeout(() => search(q), 380);
  });
  $('#hail').addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(typing);
    search($('#q').value);
  });

  // ---------- the tape: documents written to the index ----------
  function addToTape({ es, ship }) {
    if (!es) return;
    $('#tape-empty').hidden = true;
    const li = document.createElement('li');
    li.className = 'is-new';
    li.innerHTML = `<details>
      <summary>
        <span class="tape__req"><span class="req__method">${es.method}</span>${esc(es.path)}</span>
        <span class="tape__res">${esc(es.result)} · ${es.ms} ms</span>
        <span class="tape__ship"><i>${esc(ship.ship.name)}</i>${outcome(ship.outcome)}<span>HTTP ${ship.http.response.status_code} after ${Math.round(ship.duration_ms)} ms</span></span>
      </summary>
      <pre class="query">${jsonHtml(es.body)}</pre>
    </details>`;
    const tape = $('#tape');
    tape.prepend(li);
    while (tape.children.length > 6) tape.lastElementChild.remove();
  }

  // ---------- platform panel and Kibana links ----------
  const PLATFORM_LABELS = {
    CC_APP_NAME: 'Application', APP_ID: 'App ID', INSTANCE_NUMBER: 'Instance number', INSTANCE_TYPE: 'Instance type',
    CC_PRETTY_INSTANCE_NAME: 'Instance name', CC_COMMIT_ID: 'Commit', CC_DEPLOYMENT_ID: 'Deployment',
  };
  async function loadState() {
    const { ok, body } = await api('/api/state');
    if (!ok) return;
    state.kibana = body.kibana;
    $('#platform').innerHTML = Object.entries(body.platform).map(([k, v]) => `
      <div><dt>${PLATFORM_LABELS[k]}</dt><dd class="${v === null ? 'is-empty' : ''}">${v === null ? 'not set' : esc(v)}</dd></div>`).join('');
    if (!body.platform.CC_APP_NAME) $('#live-text').textContent = 'Running locally';
    for (const [id, key] of [['#k-discover', 'discover'], ['#k-apm', 'apm'], ['#k-errors', 'errors']]) {
      if (body.kibana) $(id).href = body.kibana[key];
    }
    $('#chart-note').hidden = Boolean(body.kibana);
    const health = await api('/health/deep');
    const es = health.body.elasticsearch;
    // Until the index template and the seed ships are in place, say so and look again.
    const pending = body.setup && body.setup.phase !== 'ready' ? body.setup.phase : null;
    const PENDING = { preparing: 'Elasticsearch: preparing the index', 'bad-mapping': 'Elasticsearch: wrong index mapping' };
    $('#es-text').textContent = pending ? PENDING[pending] : es ? `Elasticsearch ${es.version} · ${es.cluster}` : 'Elasticsearch offline';
    $('#es-pill').className = `cc-pill ${health.ok && !pending ? 'cc-pill--ok' : 'cc-pill--muted'}`;
    if (pending) setTimeout(loadState, 5000);
    if (es) $('#stack-pill').textContent = `Node.js 24 · Elasticsearch ${es.version} · APM · Kibana`;
  }

  // ---------- the log drain: stdout lines that Clever Cloud shipped to Elasticsearch ----------
  async function pollDrain() {
    try {
      const { ok, body } = await api('/api/drain');
      const el = $('#drain');
      if (ok && body.total) {
        el.innerHTML = `<b>${body.total.toLocaleString('en-GB')}</b> lines drained so far. Latest, in <code>${esc(body.last.index)}</code>:<code class="drain__line">${esc(body.last.message)}</code>`;
      } else if (ok) {
        el.textContent = 'No drained line yet: create the drain (see the README) and they will appear here.';
      }
    } catch { /* keep the last value */ }
    setTimeout(pollDrain, 20000);
  }

  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { state.lastTouch = Date.now(); }, { passive: true }));

  loadState();
  pollHarbour();
  pollDrain();
  setTimeout(traffic, 900);
  refreshLevers();
})();
