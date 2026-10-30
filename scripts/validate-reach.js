#!/usr/bin/env node
/*
 * scripts/validate-reach.js — how well do the region contours' reach shapes
 * match where repeaters are really heard?
 *
 * Hold-out check against a running instance's own data. Every directed
 * reception in the neighbor graph (a listener heard a transmitter, from
 * heard_by_source / heard_by_target) is hidden in turn, the transmitter's
 * reach is rebuilt from what is left, exactly as the overlay builds it, and
 * the listener is checked against it. The hit rate alone means little, since
 * a bigger shape always catches more, so each model is set against a plain
 * circle of the same mean area round every repeater: "skill" is how many
 * points better the model does, "circle needs" how much more area the circle
 * would need to catch as many.
 *
 * Read-only: GET requests to the instance, and elevation tiles from the
 * terrain source it is configured with.
 *
 *   node scripts/validate-reach.js [BASE_URL] [--local]
 *
 * BASE_URL defaults to http://localhost:3000. --local evaluates this
 * checkout's public/terrain-reach.js, scope-geometry.js and
 * scope-contours.js in the page instead of the instance's own, so a model
 * change can be checked on live data before it is deployed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const BASE = (args.find((a) => !a.startsWith('--')) || 'http://localhost:3000').replace(/\/$/, '');
const LOCAL = args.includes('--local');
const MODULES = ['terrain-reach.js', 'scope-geometry.js', 'scope-contours.js'];

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(BASE + '/#/home', { waitUntil: 'load' });
    await page.waitForFunction(() => window.ScopeContours && window.TerrainReach);
    if (LOCAL) {
      for (const f of MODULES) {
        await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8') });
      }
    }
    const r = await page.evaluate(holdOut);
    report(r);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });

// Runs in the page. Returns one row per held-out reception.
async function holdOut() {
  const SC = window.ScopeContours, TR = window.TerrainReach, N = SC.sectors;
  const FLOOR = 1000;
  const get = async (u) => { const res = await fetch(u); if (!res.ok) throw new Error(u + ': ' + res.status); return res.json(); };
  const nodes = (await get('/api/nodes?limit=100000')).nodes || [];
  const edges = (await get('/api/analytics/neighbor-graph')).edges || [];
  const cfg = await get('/api/config/map').catch(() => ({}));
  const heights = cfg.antennaHeights || {};
  const terrain = TR.createTerrainProvider({ storage: null, yieldFn: () => Promise.resolve() });
  terrain.setSource(cfg.terrainTiles || null);

  const pos = new Map();
  nodes.forEach((n) => {
    const lat = Number(n.lat), lon = Number(n.lon);
    if (isFinite(lat) && isFinite(lon) && (lat || lon)) pos.set(n.public_key, [lat, lon]);
  });
  const heightOf = (pk) => {
    let best = '', m = 0;
    Object.keys(heights).forEach((k) => { if (k.length > best.length && pk.toLowerCase().indexOf(k.toLowerCase()) === 0) { best = k; m = heights[k]; } });
    return m;
  };
  const geo = (a, b) => {
    const cos = Math.cos((a[0] + b[0]) / 2 * Math.PI / 180);
    const dx = (b[1] - a[1]) * 111320 * cos, dy = (b[0] - a[0]) * 111320;
    return { d: Math.hypot(dx, dy), brg: Math.atan2(dx, dy) };
  };
  // Reach along a bearing, between the two nearest rays, as the outline is drawn.
  const along = (ext, brg) => {
    const f = ((brg % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI) * N;
    const i = Math.floor(f) % N, j = (i + 1) % N, t = f - Math.floor(f);
    return ext[i] * (1 - t) + ext[j] * t;
  };
  const areaOf = (ext, margin) => { let s = 0; for (let i = 0; i < N; i++) s += 0.5 * (ext[i] + margin) ** 2 * 2 * Math.PI / N; return s; };

  const recs = [];
  edges.forEach((e, ei) => {
    if (e.ambiguous || e.source === e.target) return;
    const a = pos.get(e.source), b = pos.get(e.target);
    if (!a || !b) return;
    if (e.heard_by_target > 0) recs.push(Object.assign({ ei, side: 'heard_by_target', tx: e.source }, geo(a, b)));
    if (e.heard_by_source > 0) recs.push(Object.assign({ ei, side: 'heard_by_source', tx: e.target }, geo(b, a)));
  });

  const rows = [];
  for (let k = 0; k < recs.length; k++) {
    const r = recs[k];
    if (r.d < 100) continue; // co-located: says nothing about reach
    const held = edges.map((e, i) => (i === r.ei ? Object.assign({}, e, { [r.side]: 0 }) : e));
    const lr = SC.linkReach(nodes, held);
    const R = lr.radius.get(r.tx) || FLOOR;
    const p = pos.get(r.tx), h = heightOf(r.tx);
    const it = { pk: r.tx + '#' + k, lat: p[0], lon: p[1], R, links: lr.partners.get(r.tx) || [] };
    if (h) it.antennaM = h;
    const t = (await terrain.extentsFor([it])).get(it.pk) || null;
    const radius = SC.reachFor(R, null, null, FLOOR), model = SC.reachFor(R, t, null, FLOOR);
    rows.push({ d: r.d, radius: along(radius, r.brg), model: along(model, r.brg), areaRadius: areaOf(radius, 2000), areaModel: areaOf(model, 2000) });
  }
  return { rows, receptions: recs.length, terrain: terrain.status(), base: location.origin };
}

function report({ rows, receptions, terrain, base }) {
  const MARGIN = 2000, n = rows.length;
  const ds = rows.map((x) => x.d).sort((a, b) => a - b);
  const pct = (v) => (100 * v).toFixed(0) + '%';
  // Area of a circle round every repeater that catches the same share.
  const circleAreaFor = (rate) => {
    const r = ds[Math.max(0, Math.min(n - 1, Math.ceil(rate * n) - 1))];
    return Math.PI * Math.max(r, MARGIN) ** 2;
  };
  console.log(`${base}: ${receptions} directed receptions, ${n} held out (both ends placed, >100 m apart); terrain ${terrain}`);
  console.log('"inside": within the reach plus the 2 km margin; link lobes left out, since each is a known reception\n');
  console.log('model'.padEnd(34) + 'inside'.padStart(7) + 'mean km²'.padStart(10) + 'same-area circle'.padStart(18) + 'skill'.padStart(7) + 'circle needs'.padStart(14));
  for (const [key, label] of [['radius', 'distance radius only'], ['model', 'overlay reach (terrain if on)']]) {
    const inside = rows.filter((x) => x.d <= x[key] + MARGIN).length / n;
    const meanA = rows.reduce((s, x) => s + x[key === 'radius' ? 'areaRadius' : 'areaModel'], 0) / n;
    const r0 = Math.sqrt(meanA / Math.PI), circle = rows.filter((x) => x.d <= r0).length / n;
    const skill = 100 * (inside - circle), more = 100 * (circleAreaFor(inside) / meanA - 1);
    console.log(label.padEnd(34) + pct(inside).padStart(7) + (meanA / 1e6).toFixed(0).padStart(10) + pct(circle).padStart(18) +
      ((skill >= 0 ? '+' : '') + skill.toFixed(0)).padStart(7) + ((more >= 0 ? '+' : '') + more.toFixed(0) + '%').padStart(14));
  }
}
