// The night scene, drawn on a canvas: sky, sea, the lighthouse and its beam,
// the ships (one per request), fog, storm and the broken lamp.
// app.js drives it with: setRate, setFog, setStorm, setLamp, launchShip, searchlight.
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const ease = (from, to, k) => from + (to - from) * clamp(k);

  const LIGHT = { docked: '#11bea9', delayed: '#ffc35a', wrecked: '#ef5560' };

  class Scene {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.t = 0;
      this.theta = 0.9;
      this.rpm = 4;
      this.targetRpm = 4;
      this.fog = 0;
      this.fogTarget = 0;
      this.storm = 0;
      this.stormTarget = 0;
      this.lamp = 1;
      this.lampBroken = false;
      this.brokenAt = -10;
      this.ships = [];
      this.sparks = [];
      this.flash = 0;
      this.bolt = null;
      this.nextBolt = 2;
      this.search = null;
      this.resize();
      new ResizeObserver(() => this.resize()).observe(canvas);
      this.last = performance.now();
      requestAnimationFrame((now) => this.frame(now));
    }

    // ---------- public API ----------
    setRate(shipsPerMinute) {
      // 3 turns a minute when the bay is empty, up to 30 in a storm of requests
      this.targetRpm = reduced ? 3 : 3 + 27 * (1 - Math.exp(-shipsPerMinute / 30));
    }
    setFog(level) { this.fogTarget = clamp(level); }
    setStorm(level) { this.stormTarget = clamp(level); }
    setLamp(ok) {
      if (!ok && !this.lampBroken) {
        this.brokenAt = this.t;
        for (let i = 0; i < 26; i++) {
          this.sparks.push({ x: this.lampX, y: this.lampY, vx: rand(-90, 90), vy: rand(-160, 20), life: rand(0.6, 1.4) });
        }
      }
      this.lampBroken = !ok;
    }
    get turnsPerMinute() { return this.rpm; }

    launchShip({ name, type = 'schooner', outcome = 'docked' }) {
      // 0 = far (near the horizon), 1 = near. Wrecks take the far lanes, where the rocks are.
      const depth = outcome === 'wrecked' ? rand(0.04, 0.34) : Math.random();
      // label a ship only if names will not pile up on each other
      const crowd = this.ships.filter((s) => !s.gone).length;
      const labelled = (crowd < 6 || outcome === 'wrecked') && this.t - (this.lastLabel || -9) > 0.9;
      if (labelled) this.lastLabel = this.t;
      this.ships.push({
        name, type, outcome, depth,
        x: -60 - Math.random() * 40,
        phase: Math.random() * TAU,
        born: this.t,
        sinking: 0,
        labelled,
      });
      this.ships.sort((a, b) => a.depth - b.depth);
      if (this.ships.length > 60) this.ships.splice(0, this.ships.length - 60);
    }

    // Fix the beam on the water where the searched ship is, for a few seconds.
    searchlight(name) {
      this.search = { name, start: this.t, until: this.t + 6 };
    }
    sightPoint() { return { x: this.w * (this.w < 700 ? 0.3 : 0.34), y: this.horizon + (this.h - this.horizon) * 0.36 }; }
    get searching() { return Boolean(this.search); }

    // ---------- layout ----------
    resize() {
      const r = this.canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.w = r.width;
      this.h = r.height;
      this.canvas.width = Math.round(r.width * this.dpr);
      this.canvas.height = Math.round(r.height * this.dpr);
      const narrow = this.w < 700;
      this.horizon = this.h * 0.6;
      this.cliffTop = this.horizon - this.h * 0.075;
      this.towerH = Math.min(this.h * (narrow ? 0.32 : 0.4), 300);
      this.lx = this.w * (narrow ? 0.8 : 0.79);
      this.rocksX = this.w * (narrow ? 0.56 : 0.64);
      this.towerW = this.towerH * 0.19;
      this.lanternH = this.towerH * 0.13;
      this.lampX = this.lx;
      this.lampY = this.cliffTop - this.towerH + this.lanternH * 0.55;
      this.stars = Array.from({ length: Math.round((this.w * this.horizon) / 4200) }, () => ({
        x: Math.random() * this.w, y: Math.random() * this.horizon * 0.95,
        r: rand(0.35, 1.25), a: rand(0.25, 0.95), p: Math.random() * TAU, s: rand(0.6, 2.2),
      }));
      this.rain = Array.from({ length: narrow ? 140 : 260 }, () => ({
        x: Math.random() * this.w, y: Math.random() * this.h, len: rand(10, 22), v: rand(700, 1100),
      }));
      this.clouds = Array.from({ length: 14 }, (_, i) => ({
        x: (i / 13) * this.w * 1.2 - this.w * 0.1, y: rand(-20, this.h * 0.22), rx: rand(120, 260), ry: rand(40, 80),
      }));
      this.buildSky();
      this.buildLand();
      this.buildFog();
    }

    layer(w, h) {
      const c = document.createElement('canvas');
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
      const ctx = c.getContext('2d');
      ctx.scale(this.dpr, this.dpr);
      return { c, ctx };
    }

    buildSky() {
      const { c, ctx } = this.layer(this.w, this.h);
      const sky = ctx.createLinearGradient(0, 0, 0, this.horizon);
      sky.addColorStop(0, '#050a1c');
      sky.addColorStop(0.55, '#0c1631');
      sky.addColorStop(1, '#1c2a4f');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, this.w, this.horizon);
      const sea = ctx.createLinearGradient(0, this.horizon, 0, this.h);
      sea.addColorStop(0, '#0f2140');
      sea.addColorStop(0.4, '#0a1730');
      sea.addColorStop(1, '#040a17');
      ctx.fillStyle = sea;
      ctx.fillRect(0, this.horizon, this.w, this.h - this.horizon);
      // a thin glow on the horizon line
      const glow = ctx.createLinearGradient(0, this.horizon - 30, 0, this.horizon + 6);
      glow.addColorStop(0, 'rgba(120,150,210,0)');
      glow.addColorStop(1, 'rgba(120,150,210,0.18)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, this.horizon - 30, this.w, 36);
      // crescent moon
      const mx = this.w * (this.w < 700 ? 0.5 : 0.6);
      const my = this.h * (this.w < 700 ? 0.3 : 0.12);
      const mr = Math.max(11, this.h * 0.024);
      const halo = ctx.createRadialGradient(mx, my, mr, mx, my, mr * 7);
      halo.addColorStop(0, 'rgba(230,226,205,0.14)');
      halo.addColorStop(1, 'rgba(230,226,205,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(mx - mr * 7, my - mr * 7, mr * 14, mr * 14);
      const moon = this.layer(mr * 3, mr * 3);
      moon.ctx.fillStyle = '#efe9d2';
      moon.ctx.beginPath(); moon.ctx.arc(mr * 1.5, mr * 1.5, mr, 0, TAU); moon.ctx.fill();
      moon.ctx.globalCompositeOperation = 'destination-out';
      moon.ctx.beginPath(); moon.ctx.arc(mr * 1.5 + mr * 0.45, mr * 1.5 - mr * 0.2, mr * 0.92, 0, TAU); moon.ctx.fill();
      ctx.drawImage(moon.c, mx - mr * 1.5, my - mr * 1.5, mr * 3, mr * 3);
      this.sky = c;
    }

    // The headland, the rocks, the tower and the keeper's cottage never move: draw them once.
    buildLand() {
      const { c, ctx } = this.layer(this.w, this.h);
      const { w, h, horizon, cliffTop, lx, towerH, towerW, rocksX, lanternH } = this;
      // headland
      ctx.fillStyle = '#060a15';
      ctx.beginPath();
      ctx.moveTo(rocksX - 30, horizon + 8);
      ctx.bezierCurveTo(rocksX, horizon - 6, rocksX + 12, cliffTop + 22, rocksX + 46, cliffTop + 10);
      ctx.lineTo(lx - towerW * 3.2, cliffTop + 2);
      ctx.lineTo(lx - towerW * 1.4, cliffTop - 2);
      ctx.lineTo(lx + towerW * 2.4, cliffTop - 1);
      ctx.quadraticCurveTo((lx + towerW * 2.4 + w) / 2, cliffTop - 10, w + 4, cliffTop - 8);
      ctx.lineTo(w + 4, horizon + 18);
      ctx.closePath();
      ctx.fill();
      // moonlit rim on the cliff edge
      ctx.strokeStyle = 'rgba(150,170,215,0.22)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(rocksX + 4, horizon - 4);
      ctx.bezierCurveTo(rocksX + 14, cliffTop + 20, rocksX + 24, cliffTop + 12, rocksX + 46, cliffTop + 10);
      ctx.lineTo(lx - towerW * 3.2, cliffTop + 2);
      ctx.stroke();
      // rocks in the water, where wrecked ships end
      ctx.fillStyle = '#070c19';
      const rocks = [[0, 0.03, 26], [0.035, 0.06, 18], [-0.03, 0.075, 14], [0.07, 0.035, 22], [0.11, 0.09, 12]];
      for (const [dx, dy, r] of rocks) {
        const x = rocksX + dx * w;
        const y = horizon + dy * h;
        ctx.beginPath();
        ctx.moveTo(x - r, y + 4);
        ctx.lineTo(x - r * 0.6, y - r * 0.55);
        ctx.lineTo(x - r * 0.1, y - r * 0.8);
        ctx.lineTo(x + r * 0.55, y - r * 0.4);
        ctx.lineTo(x + r, y + 4);
        ctx.closePath();
        ctx.fill();
      }
      // keeper's cottage
      const cx = lx - towerW * 2.3;
      const cw = towerW * 1.5;
      const ch = towerW * 0.8;
      ctx.fillStyle = '#121a30';
      ctx.fillRect(cx - cw / 2, cliffTop - ch, cw, ch);
      ctx.fillStyle = '#0a0f1e';
      ctx.beginPath();
      ctx.moveTo(cx - cw / 2 - 4, cliffTop - ch);
      ctx.lineTo(cx, cliffTop - ch - ch * 0.75);
      ctx.lineTo(cx + cw / 2 + 4, cliffTop - ch);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(cx + cw * 0.22, cliffTop - ch - ch * 0.8, cw * 0.1, ch * 0.45);
      ctx.fillStyle = '#ffcf7a';
      ctx.shadowColor = 'rgba(255,190,90,0.9)';
      ctx.shadowBlur = 10;
      ctx.fillRect(cx - cw * 0.28, cliffTop - ch * 0.68, cw * 0.18, ch * 0.32);
      ctx.shadowBlur = 0;
      // tower: tapered, white with Clever cherry bands, lit by the moon on the left
      const top = cliffTop - towerH + lanternH * 1.25;
      const bw = towerW;
      const tw = towerW * 0.66;
      const tower = new Path2D();
      tower.moveTo(lx - bw / 2, cliffTop);
      tower.lineTo(lx - tw / 2, top);
      tower.lineTo(lx + tw / 2, top);
      tower.lineTo(lx + bw / 2, cliffTop);
      tower.closePath();
      ctx.save();
      ctx.clip(tower);
      const white = ctx.createLinearGradient(lx - bw / 2, 0, lx + bw / 2, 0);
      white.addColorStop(0, '#d9dce6');
      white.addColorStop(0.45, '#aab1c4');
      white.addColorStop(1, '#4c5571');
      ctx.fillStyle = white;
      ctx.fillRect(lx - bw, top, bw * 2, towerH);
      const red = ctx.createLinearGradient(lx - bw / 2, 0, lx + bw / 2, 0);
      red.addColorStop(0, '#d8344f');
      red.addColorStop(0.5, '#a51050');
      red.addColorStop(1, '#4e0a2a');
      ctx.fillStyle = red;
      const span = cliffTop - top;
      for (const f of [0.12, 0.42, 0.72]) ctx.fillRect(lx - bw, top + span * f, bw * 2, span * 0.14);
      // small windows
      ctx.fillStyle = 'rgba(10,14,28,0.85)';
      for (const f of [0.3, 0.6, 0.88]) ctx.fillRect(lx - 2, top + span * f, 4, 7);
      ctx.restore();
      // door
      ctx.fillStyle = '#0a0f1e';
      ctx.fillRect(lx - 4, cliffTop - 12, 8, 12);
      // gallery
      ctx.fillStyle = '#0b1020';
      ctx.fillRect(lx - tw * 0.95, top - 4, tw * 1.9, 5);
      ctx.strokeStyle = 'rgba(160,175,210,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 8; i++) {
        const x = lx - tw * 0.9 + (i / 8) * tw * 1.8;
        ctx.moveTo(x, top - 4);
        ctx.lineTo(x, top - 11);
      }
      ctx.moveTo(lx - tw * 0.92, top - 11);
      ctx.lineTo(lx + tw * 0.92, top - 11);
      ctx.stroke();
      this.towerTop = top;
      this.lantern = { x: lx - tw * 0.38, y: top - 4 - lanternH, w: tw * 0.76, h: lanternH };
      this.land = c;
    }

    buildFog() {
      const fw = this.w * 2;
      const fh = this.h * 0.6;
      const { c, ctx } = this.layer(fw, fh);
      for (let i = 0; i < 46; i++) {
        const x = Math.random() * fw;
        const y = rand(0.2, 0.85) * fh;
        const r = rand(70, 210);
        for (const dx of [-fw, 0, fw]) {
          const g = ctx.createRadialGradient(x + dx, y, 0, x + dx, y, r);
          g.addColorStop(0, 'rgba(200,212,230,0.13)');
          g.addColorStop(1, 'rgba(200,212,230,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x + dx - r, y - r, r * 2, r * 2);
        }
      }
      this.fogLayer = { c, w: fw, h: fh };
    }

    // ---------- frame ----------
    frame(now) {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      if (this.w) {
        this.update(dt);
        this.draw();
      }
      requestAnimationFrame((n) => this.frame(n));
    }

    update(dt) {
      this.t += dt;
      this.rpm = ease(this.rpm, this.targetRpm, dt * 0.7);
      this.fog = ease(this.fog, this.fogTarget, dt * 0.5);
      this.storm = ease(this.storm, this.stormTarget, dt * 0.9);

      // the lamp: flickers when it breaks, then only an ember is left
      if (this.lampBroken) {
        const since = this.t - this.brokenAt;
        this.lamp = since < 1.4 ? (Math.random() > 0.45 ? 0.9 : 0.08) : 0.05;
      } else {
        this.lamp = ease(this.lamp, 1, dt * 2.5);
      }

      // the beam: free rotation, or fixed on a searched ship
      const s = this.search;
      if (s && this.t > s.until) this.search = null;
      if (this.search) {
        const target = Math.PI - 0.32; // pointing left and slightly toward us
        let d = ((target - this.theta) % TAU + TAU) % TAU;
        if (d > Math.PI) d -= TAU;
        this.theta += d * clamp(dt * 4);
      } else {
        this.theta += (this.rpm / 60) * TAU * dt;
      }

      // ships
      const narrow = this.w < 700;
      for (const ship of this.ships) {
        const scale = this.shipScale(ship);
        let speed = (narrow ? 55 : 80) * scale * (1 + this.storm * 0.4);
        if (ship.outcome === 'delayed') speed *= 0.42;
        if (reduced) speed *= 0.6;
        if (ship.outcome === 'wrecked') {
          const stopAt = this.rocksX - 26 * scale;
          if (ship.x < stopAt) ship.x = Math.min(stopAt, ship.x + speed * 1.2 * dt);
          else ship.sinking += dt;
          if (ship.sinking > 0 && !ship.flare) {
            ship.flare = { y: 0, vy: -120, life: 2.2 };
          }
          if (ship.flare) {
            ship.flare.vy += 70 * dt;
            ship.flare.y += ship.flare.vy * dt;
            ship.flare.life -= dt;
          }
          if (ship.sinking > 4.5) ship.gone = true;
        } else {
          ship.x += speed * dt;
          if (ship.x > this.w + 80) ship.gone = true;
        }
      }
      this.ships = this.ships.filter((s) => !s.gone);

      for (const p of this.sparks) {
        p.vy += 260 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt;
      }
      this.sparks = this.sparks.filter((p) => p.life > 0);

      // storm: rain and lightning
      if (this.storm > 0.05) {
        for (const d of this.rain) {
          d.y += d.v * dt;
          d.x += d.v * 0.22 * dt;
          if (d.y > this.h) { d.y = -d.len; d.x = Math.random() * this.w * 1.1 - this.w * 0.1; }
        }
      }
      this.flash = Math.max(0, this.flash - dt * 4);
      if (this.bolt) { this.bolt.life -= dt; if (this.bolt.life <= 0) this.bolt = null; }
      if (!reduced && this.storm > 0.6 && this.t > this.nextBolt) {
        this.nextBolt = this.t + rand(1.4, 3.8);
        this.flash = 1;
        let x = rand(this.w * 0.08, this.w * 0.55);
        let y = 0;
        const pts = [[x, y]];
        while (y < this.horizon - 10) { y += rand(18, 42); x += rand(-26, 26); pts.push([x, y]); }
        this.bolt = { pts, life: 0.18 };
      }
    }

    draw() {
      const ctx = this.ctx;
      const { w, h, horizon } = this;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(this.sky, 0, 0, w, h);

      // stars, hidden by clouds in a storm
      const starAlpha = 1 - this.storm * 0.9 - this.fog * 0.5;
      if (starAlpha > 0.02) {
        ctx.fillStyle = '#e8ecff';
        for (const s of this.stars) {
          ctx.globalAlpha = starAlpha * s.a * (reduced ? 1 : 0.65 + 0.35 * Math.sin(this.t * s.s + s.p));
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, TAU);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      if (this.storm > 0.02) {
        ctx.fillStyle = `rgba(6,9,22,${0.82 * this.storm})`;
        for (const c of this.clouds) {
          ctx.beginPath();
          ctx.ellipse(c.x + Math.sin(this.t * 0.1 + c.y) * 20, c.y, c.rx, c.ry, 0, 0, TAU);
          ctx.fill();
        }
        ctx.fillStyle = `rgba(6,9,22,${0.35 * this.storm})`;
        ctx.fillRect(0, 0, w, horizon);
      }

      this.drawWaves();
      this.drawReflection();

      // far ships pass behind the rocks, near ones in front
      for (const ship of this.ships) if (ship.depth < 0.22) this.drawShip(ship);
      ctx.drawImage(this.land, 0, 0, w, h);
      this.drawLantern();
      for (const ship of this.ships) if (ship.depth >= 0.22) this.drawShip(ship);
      if (this.search) this.drawSighting();

      this.drawBeams();
      this.drawFog();
      this.drawStorm();
      this.drawSparks();
    }

    drawWaves() {
      const ctx = this.ctx;
      const { w, h, horizon } = this;
      const amp = 1 + this.storm * 3.5;
      ctx.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const f = (i + 1) / 14;
        const y0 = horizon + Math.pow(f, 1.7) * (h - horizon);
        ctx.strokeStyle = `rgba(120,155,210,${0.05 + f * 0.1})`;
        ctx.beginPath();
        for (let x = -10; x <= w + 10; x += 14) {
          const y = y0 + Math.sin(x * (0.018 / (0.4 + f)) + this.t * (0.6 + f) + i * 1.7) * amp * (0.6 + f * 2.2);
          if (x === -10) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // the lamp's glitter on the water, brightest when a beam faces us
    drawReflection() {
      const ctx = this.ctx;
      const facing = Math.max(0, Math.sin(this.theta), Math.sin(this.theta + Math.PI));
      const a = this.lamp * (0.1 + 0.45 * Math.pow(facing, 3));
      if (a < 0.02) return;
      const depth = (this.h - this.horizon) * 0.95;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const column = ctx.createLinearGradient(0, this.horizon, 0, this.horizon + depth);
      column.addColorStop(0, `rgba(255,205,120,${a * 0.35})`);
      column.addColorStop(1, 'rgba(255,205,120,0)');
      ctx.fillStyle = column;
      ctx.beginPath();
      ctx.moveTo(this.lx - 6, this.horizon);
      ctx.lineTo(this.lx + 6, this.horizon);
      ctx.lineTo(this.lx + 60, this.horizon + depth);
      ctx.lineTo(this.lx - 60, this.horizon + depth);
      ctx.closePath();
      ctx.fill();
      for (let i = 0; i < 44; i++) {
        const f = i / 44;
        const y = this.horizon + 3 + f * depth;
        const half = 3 + f * 30;
        const wobble = Math.sin(this.t * 1.8 + i * 2.1) * half * 0.8;
        const flicker = 0.55 + 0.45 * Math.sin(this.t * 3.1 + i * 0.7);
        ctx.fillStyle = `rgba(255,214,140,${a * (1 - f) * 0.55 * flicker})`;
        ctx.beginPath();
        ctx.ellipse(this.lx + wobble, y, half, 0.9 + f * 1.2, 0, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    drawLantern() {
      const ctx = this.ctx;
      const L = this.lantern;
      ctx.fillStyle = '#0a0f1e';
      ctx.fillRect(L.x - 2, L.y - 2, L.w + 4, L.h + 4);
      const lit = this.lamp;
      ctx.fillStyle = `rgba(${Math.round(80 + 175 * lit)},${Math.round(60 + 150 * lit)},${Math.round(40 + 70 * lit)},1)`;
      ctx.fillRect(L.x, L.y, L.w, L.h);
      ctx.strokeStyle = '#0a0f1e';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (const f of [0.33, 0.66]) { ctx.moveTo(L.x + L.w * f, L.y); ctx.lineTo(L.x + L.w * f, L.y + L.h); }
      ctx.stroke();
      // dome, Clever cherry
      ctx.fillStyle = '#7a0c3c';
      ctx.beginPath();
      ctx.ellipse(this.lx, L.y - 1, L.w * 0.62, L.h * 0.55, 0, Math.PI, TAU);
      ctx.fill();
      ctx.fillStyle = '#0a0f1e';
      ctx.fillRect(this.lx - 1, L.y - L.h * 0.55 - 6, 2, 6);
    }

    drawBeams() {
      const ctx = this.ctx;
      if (this.lamp < 0.06) return;
      const { lampX: x0, lampY: y0, w } = this;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const veil = 1 + this.fog * 1.6;
      if (this.search) {
        // searchlight: one narrow, bright cone onto the ship we are looking for
        const p = this.sightPoint();
        const k = clamp((this.t - this.search.start) * 2);
        const g = ctx.createLinearGradient(x0, y0, p.x, p.y);
        g.addColorStop(0, `rgba(255,224,160,${0.55 * k * this.lamp})`);
        g.addColorStop(1, `rgba(255,214,140,${0.12 * k * this.lamp})`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x0, y0 - 4);
        ctx.lineTo(p.x - 70, p.y - 10);
        ctx.lineTo(p.x + 40, p.y + 14);
        ctx.lineTo(x0, y0 + 4);
        ctx.closePath();
        ctx.fill();
        const pool = ctx.createRadialGradient(p.x - 12, p.y + 4, 4, p.x - 12, p.y + 4, 90);
        pool.addColorStop(0, `rgba(255,220,150,${0.35 * k})`);
        pool.addColorStop(1, 'rgba(255,220,150,0)');
        ctx.fillStyle = pool;
        ctx.beginPath();
        ctx.ellipse(p.x - 12, p.y + 4, 100, 26, 0, 0, TAU);
        ctx.fill();
      } else {
        for (const phi of [this.theta, this.theta + Math.PI]) {
          const c = Math.cos(phi);
          const toward = Math.sin(phi); // 1 = facing us
          const dir = c >= 0 ? 1 : -1;
          const len = (dir > 0 ? w - x0 + 60 : x0 + 60) * Math.pow(Math.abs(c), 0.7);
          const spread = 10 + Math.max(0, toward) * 70 + (1 - Math.abs(c)) * 30;
          const a = this.lamp * (0.1 + 0.28 * (0.5 + 0.5 * toward)) * veil;
          const g = ctx.createLinearGradient(x0, 0, x0 + dir * len, 0);
          g.addColorStop(0, `rgba(255,222,150,${a})`);
          g.addColorStop(1, 'rgba(255,214,140,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(x0, y0 - 3);
          ctx.lineTo(x0 + dir * len, y0 - spread + len * 0.03);
          ctx.lineTo(x0 + dir * len, y0 + spread + len * 0.05);
          ctx.lineTo(x0, y0 + 3);
          ctx.closePath();
          ctx.fill();
        }
      }
      // glare at the lamp, a flash each time a beam faces us
      const facing = Math.max(0, Math.sin(this.theta), Math.sin(this.theta + Math.PI));
      const r = 22 + 150 * Math.pow(facing, 10) * (this.search ? 0.2 : 1);
      const glare = ctx.createRadialGradient(x0, y0, 0, x0, y0, r);
      glare.addColorStop(0, `rgba(255,240,205,${0.9 * this.lamp})`);
      glare.addColorStop(0.25, `rgba(255,205,120,${0.4 * this.lamp})`);
      glare.addColorStop(1, 'rgba(255,190,90,0)');
      ctx.fillStyle = glare;
      ctx.fillRect(x0 - r, y0 - r, r * 2, r * 2);
      ctx.restore();
    }

    shipScale(ship) {
      return (this.w < 700 ? 0.55 : 0.7) + ship.depth * (this.w < 700 ? 0.7 : 1.05);
    }

    shipY(ship) {
      return this.horizon + 10 + ship.depth * (this.h - this.horizon) * (this.w < 700 ? 0.42 : 0.5);
    }

    drawShip(ship) {
      const ctx = this.ctx;
      const s = this.shipScale(ship);
      const bob = Math.sin(this.t * 1.7 + ship.phase) * (1.2 + this.storm * 4) * s;
      const x = ship.x;
      const water = this.shipY(ship);
      const y = water + bob + ship.sinking * 9 * s;
      const tilt = Math.sin(this.t * 1.2 + ship.phase) * (0.025 + this.storm * 0.09) + (ship.sinking ? -Math.min(0.5, ship.sinking * 0.18) : 0);
      const fade = ship.outcome === 'delayed' ? 1 - this.fog * 0.45 : 1;
      // the running light, reflected on the water
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const glow = ctx.createRadialGradient(x, water + 2, 0, x, water + 2, 34 * s);
      glow.addColorStop(0, `${LIGHT[ship.outcome]}55`);
      glow.addColorStop(1, `${LIGHT[ship.outcome]}00`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.ellipse(x, water + 2, 34 * s, 7 * s, 0, 0, TAU);
      ctx.fill();
      ctx.restore();

      ctx.save();
      // clip at the waterline so a wreck sinks into the sea
      ctx.beginPath();
      ctx.rect(x - 90 * s, water - 120 * s, 180 * s, 120 * s + 2 + bob);
      ctx.clip();
      ctx.translate(x, y);
      ctx.rotate(tilt);
      ctx.scale(s, s);
      ctx.globalAlpha = fade;
      this.drawHull(ship.type);
      // running light
      ctx.fillStyle = LIGHT[ship.outcome];
      ctx.shadowColor = LIGHT[ship.outcome];
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(ship.type === 'steamer' ? 30 : 22, -13, 2.6, 0, TAU);
      ctx.fill();
      ctx.restore();

      if (ship.flare && ship.flare.life > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const fy = water - 40 * s + ship.flare.y;
        const g = ctx.createRadialGradient(x, fy, 0, x, fy, 26);
        g.addColorStop(0, `rgba(255,120,110,${Math.min(1, ship.flare.life)})`);
        g.addColorStop(1, 'rgba(255,80,80,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - 26, fy - 26, 52, 52);
        ctx.restore();
      }

      // name, in italics, for a few seconds after the ship appears
      const age = this.t - ship.born;
      if (ship.labelled && age < 3.4 && ship.x > 0) {
        ctx.save();
        ctx.globalAlpha = clamp(Math.min(age * 3, (3.4 - age) * 2)) * fade;
        ctx.font = `italic ${Math.round(12 + s * 6)}px "IM Fell English", Georgia, serif`;
        ctx.fillStyle = ship.outcome === 'wrecked' ? '#ffb3b8' : '#f3ead6';
        ctx.textAlign = 'center';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 6;
        ctx.fillText(ship.name, x, water - 52 * s);
        ctx.restore();
      }
    }

    drawHull(type) {
      const ctx = this.ctx;
      const hull = '#111a33';
      ctx.fillStyle = hull;
      ctx.strokeStyle = 'rgba(176,196,240,0.6)';
      ctx.lineWidth = 1.1;
      if (type === 'steamer') {
        ctx.beginPath();
        ctx.moveTo(-44, -10); ctx.lineTo(42, -10); ctx.lineTo(34, 2); ctx.lineTo(-38, 2); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#1a2445';
        ctx.fillRect(-18, -20, 30, 10);
        ctx.strokeRect(-18, -20, 30, 10);
        ctx.fillStyle = '#0b1122';
        ctx.fillRect(-6, -34, 8, 14);
        ctx.fillStyle = '#a51050';
        ctx.fillRect(-6, -31, 8, 3);
        ctx.fillStyle = 'rgba(255,207,122,0.85)';
        for (const wx of [-14, -7, 0, 7]) ctx.fillRect(wx, -17, 3, 3);
        ctx.fillStyle = 'rgba(170,185,215,0.22)';
        ctx.beginPath(); ctx.arc(-8, -42, 6, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(-17, -50, 8, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(-29, -55, 10, 0, TAU); ctx.fill();
      } else if (type === 'trawler') {
        ctx.beginPath();
        ctx.moveTo(-26, -8); ctx.lineTo(28, -12); ctx.lineTo(22, 2); ctx.lineTo(-22, 2); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#1a2445';
        ctx.fillRect(4, -22, 14, 12);
        ctx.strokeRect(4, -22, 14, 12);
        ctx.fillStyle = 'rgba(255,207,122,0.95)';
        ctx.fillRect(9, -19, 4, 3);
        ctx.strokeStyle = 'rgba(176,196,240,0.75)';
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(-8, -9); ctx.lineTo(-8, -40); ctx.lineTo(-24, -14); ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(-34, -8); ctx.quadraticCurveTo(0, -4, 36, -11); ctx.lineTo(26, 2); ctx.lineTo(-28, 2); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(176,196,240,0.8)';
        ctx.fillRect(-12, -52, 1.6, 46);
        ctx.fillRect(10, -46, 1.6, 40);
        ctx.fillStyle = 'rgba(226,231,244,0.88)';
        ctx.beginPath(); ctx.moveTo(-10, -50); ctx.lineTo(-10, -10); ctx.lineTo(8, -10); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(12, -44); ctx.lineTo(12, -10); ctx.lineTo(30, -12); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-14, -48); ctx.lineTo(-14, -12); ctx.lineTo(-30, -10); ctx.closePath(); ctx.fill();
      }
    }

    // the searched ship, lit in the searchlight
    drawSighting() {
      const ctx = this.ctx;
      const p = this.sightPoint();
      const k = clamp((this.t - this.search.start) * 1.5) * clamp((this.search.until - this.t) * 1.5);
      ctx.save();
      ctx.globalAlpha = k;
      ctx.translate(p.x - 12, p.y + Math.sin(this.t * 1.6) * 1.5);
      ctx.scale(1.05, 1.05);
      this.drawHull('schooner');
      ctx.restore();
    }

    drawFog() {
      if (this.fog < 0.02) return;
      const ctx = this.ctx;
      const F = this.fogLayer;
      const y = this.horizon - F.h * 0.55;
      ctx.save();
      ctx.globalAlpha = this.fog;
      const off1 = (this.t * 16) % F.w;
      ctx.drawImage(F.c, -off1, y, F.w, F.h);
      ctx.drawImage(F.c, -off1 + F.w, y, F.w, F.h);
      ctx.globalAlpha = this.fog * 0.8;
      const off2 = (this.t * 34 + F.w / 3) % F.w;
      ctx.drawImage(F.c, -off2, y + F.h * 0.25, F.w, F.h);
      ctx.drawImage(F.c, -off2 + F.w, y + F.h * 0.25, F.w, F.h);
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(150,166,192,${0.16 * this.fog})`;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.restore();
    }

    drawStorm() {
      const ctx = this.ctx;
      if (this.storm > 0.05 && !reduced) {
        ctx.strokeStyle = `rgba(185,205,235,${0.38 * this.storm})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const d of this.rain) {
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(d.x + d.len * 0.22, d.y + d.len);
        }
        ctx.stroke();
      }
      if (this.bolt) {
        ctx.save();
        ctx.strokeStyle = 'rgba(235,240,255,0.95)';
        ctx.shadowColor = 'rgba(170,190,255,1)';
        ctx.shadowBlur = 18;
        ctx.lineWidth = 2;
        ctx.beginPath();
        this.bolt.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        ctx.restore();
      }
      if (this.flash > 0) {
        ctx.fillStyle = `rgba(200,212,255,${this.flash * 0.3})`;
        ctx.fillRect(0, 0, this.w, this.h);
      }
    }

    drawSparks() {
      if (!this.sparks.length) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const p of this.sparks) {
        ctx.fillStyle = `rgba(255,${Math.round(160 + 60 * p.life)},90,${Math.min(1, p.life)})`;
        ctx.fillRect(p.x, p.y, 2, 2);
      }
      ctx.restore();
    }
  }

  window.LighthouseScene = Scene;
})();
