'use strict';
// Unit tests for terrain-reach.js: path-loss reach over elevation tiles
// for the region-scope contours. Synthetic terrain stands in for the AWS
// Terrain Tiles, through the module's own tile-fetch seam.
const REPO_ROOT = require('path').resolve(__dirname, '..', '..');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  const ok = () => { passed++; console.log(`  ✅ ${name}`); };
  const bad = (e) => { failed++; console.log(`  ❌ ${name}: ${e.message}`); };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(ok, bad)); else ok();
  } catch (e) { bad(e); }
}

const SRC = fs.readFileSync(path.join(REPO_ROOT, 'public', 'terrain-reach.js'), 'utf8');
function load(extra) {
  const ctx = Object.assign({ window: {}, setTimeout, clearTimeout, Promise }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx.window.TerrainReach;
}
const TR = load();

const M_PER_DEG = 111320;
function offset(lat, lon, eastM, northM) {
  return { lat: lat + northM / M_PER_DEG, lon: lon + eastM / (M_PER_DEG * Math.cos(lat * Math.PI / 180)) };
}
// Signed metres east/north of an origin, for building terrain functions.
function local(lat0, lon0, lat, lon) {
  return { x: (lon - lon0) * M_PER_DEG * Math.cos(lat0 * Math.PI / 180), y: (lat - lat0) * M_PER_DEG };
}
const deg = (d) => d * Math.PI / 180;
const O = { lat: 45.0, lon: -100.0 };

console.log('\n=== terrain-reach.js: tiles ===');

test('exposes its API', () => {
  assert.ok(TR, 'window.TerrainReach not defined');
  for (const fn of ['tileOf', 'decodeTerrarium', 'knifeEdgeLoss', 'freeSpaceLoss', 'lossProfile', 'pathLoss', 'budgetOf', 'reachOf', 'terrainExtents', 'createTerrainProvider', 'shared']) {
    assert.strictEqual(typeof TR[fn], 'function', fn + ' not exported');
  }
  assert.strictEqual(TR.rays, 72);
});

test('tileOf matches the slippy-map tile at known coordinates', () => {
  const t12 = TR.tileOf(45.0, -100.0, 12);
  assert.strictEqual(Math.floor(t12.fx), 910);
  assert.strictEqual(Math.floor(t12.fy), 1473);
  const t11 = TR.tileOf(45.0, -100.0, 11);
  assert.strictEqual(Math.floor(t11.fx), 455);
  assert.strictEqual(Math.floor(t11.fy), 736);
});

test('decodeTerrarium turns RGBA into metres', () => {
  // 0 m = 128,0,0; 100.5 m = 128,100,128; -10 m = 127,246,0
  const rgba = new Uint8ClampedArray([128, 0, 0, 255, 128, 100, 128, 255, 127, 246, 0, 255]);
  const out = Array.from(TR.decodeTerrarium(rgba));
  assert.deepStrictEqual(out, [0, 100.5, -10]);
});

console.log('\n=== terrain-reach.js: path loss ===');

// sample(lat, lon) built from a function of metres east/north of O.
const terrain = (fn) => (lat, lon) => { const p = local(O.lat, O.lon, lat, lon); return fn(p.x, p.y); };
const flat = terrain(() => 50);
const at = (eastM, northM) => offset(O.lat, O.lon, eastM, northM);
const STEP = 120;
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, (what || '') + ' ' + a + ' vs ' + b);
// How far flat ground reaches under the 120 dB default (~16 km: free space
// alone would be ~26 km, the bulge takes the rest).
const FLAT_REACH = TR.reachOf(TR.lossProfile(flat, O.lat, O.lon, 0, 30000), 120);

test('knifeEdgeLoss follows ITU-R P.526 at its reference points', () => {
  assert.strictEqual(TR.knifeEdgeLoss(-0.78), 0);
  assert.strictEqual(TR.knifeEdgeLoss(-3), 0, 'well clear of the edge: no loss');
  close(TR.knifeEdgeLoss(0), 6.0, 0.1, 'grazing');
  close(TR.knifeEdgeLoss(1), 13.9, 0.1, 'v = 1');
  for (let v = -0.7; v < 10; v += 0.3) assert.ok(TR.knifeEdgeLoss(v + 0.3) > TR.knifeEdgeLoss(v), 'not rising at ' + v);
});

test('freeSpaceLoss: 91.6 dB at 1 km on 910 MHz, 6 dB more per doubling', () => {
  close(TR.freeSpaceLoss(1000), 91.6, 0.05, '1 km');
  close(TR.freeSpaceLoss(2000) - TR.freeSpaceLoss(1000), 6.02, 0.01, 'doubling');
});

test('over flat ground close in, the loss is free space', () => {
  const L = TR.lossProfile(flat, O.lat, O.lon, deg(90), 10000);
  assert.strictEqual(L.length, Math.floor(10000 / STEP) + 1);
  assert.strictEqual(L[0], 0);
  for (const k of [2, 10]) close(L[k], TR.freeSpaceLoss(k * STEP), 0.01, 'step ' + k);
});

test('over flat ground further out, the earth\'s bulge adds loss, growing with distance', () => {
  // 10 m masts: the bulge enters the first Fresnel zone a few km out
  // (v > -0.78), and the masts lose sight of each other at ~26 km (v > 0,
  // 6 dB and more).
  const L = TR.lossProfile(flat, O.lat, O.lon, deg(90), 30000);
  const extra = (d) => { const k = Math.round(d / STEP); return L[k] - TR.freeSpaceLoss(k * STEP); };
  assert.ok(extra(5000) > 0 && extra(5000) < 2, '5 km: ' + extra(5000));
  assert.ok(extra(15000) > extra(5000) && extra(30000) > extra(15000), 'not growing');
  assert.ok(extra(30000) > 6, 'over the horizon: ' + extra(30000));
});

// A 150 m ridge, 300 m wide, running north-south 2 km west of O.
const ridgeWest = terrain((x) => (x < -1850 && x > -2150 ? 150 : 50));

test('loss jumps behind a ridge, and the other side is untouched', () => {
  const west = TR.lossProfile(ridgeWest, O.lat, O.lon, deg(270), 6000);
  const east = TR.lossProfile(ridgeWest, O.lat, O.lon, deg(90), 6000);
  const k = Math.round(3000 / STEP);
  assert.ok(west[k] - TR.freeSpaceLoss(k * STEP) > 20, 'behind the ridge ' + west[k]);
  close(east[k], TR.freeSpaceLoss(k * STEP), 0.01, 'east');
  close(west[Math.round(1200 / STEP)], TR.freeSpaceLoss(1200), 0.01, 'before the ridge');
});

test('pathLoss of one link agrees with the ray profile at the same spot', () => {
  const L = TR.lossProfile(ridgeWest, O.lat, O.lon, deg(270), 6000);
  close(TR.pathLoss(ridgeWest, O, at(-4800, 0)), L[40], 1, '4.8 km west');
  close(TR.pathLoss(flat, O, at(0, 3000)), TR.freeSpaceLoss(3000), 0.01, 'flat');
});

test('a taller antenna loses less behind the same ridge', () => {
  const low = TR.pathLoss(ridgeWest, O, at(-4800, 0), 10), high = TR.pathLoss(ridgeWest, O, at(-4800, 0), 150);
  assert.ok(high < low - 10, 'low ' + low + ' high ' + high);
});

test('missing terrain adds no diffraction loss', () => {
  const L = TR.lossProfile(() => NaN, O.lat, O.lon, deg(0), 9000);
  for (const k of [5, 50, 75]) close(L[k], TR.freeSpaceLoss(k * STEP), 0.01, 'step ' + k);
});

test('reachOf is the farthest step within budget, the shadows before it included', () => {
  const L = Float32Array.from([0, 90, 130, 95, 140, 141]);
  assert.strictEqual(TR.reachOf(L, 100), 3 * STEP);
  assert.strictEqual(TR.reachOf(L, 89), 0);
  assert.strictEqual(TR.reachOf(L, 200), 5 * STEP);
});

test('a hilltop past a valley is reached, the valley before it drawn as reached', () => {
  // The ridge 2 km west, then a 300 m plateau from 9 km on.
  const t = terrain((x) => (x < -1850 && x > -2150 ? 150 : (x < -9000 && x > -11000 ? 300 : 50)));
  const L = TR.lossProfile(t, O.lat, O.lon, deg(270), 14000);
  const top = Math.round(10000 / STEP), valley = Math.round(5000 / STEP);
  const budget = L[top] + 1;
  assert.ok(L[valley] > budget, 'test premise: the valley is out of budget (' + L[valley] + ' > ' + budget + ')');
  assert.ok(TR.reachOf(L, budget) >= 10000, 'reach ' + TR.reachOf(L, budget));
});

test('budgetOf: the 90th percentile of the loss to the nodes that heard it', () => {
  const links = [at(1000, 0), at(0, 2000), at(-3000, 0), at(0, -4000)];
  const losses = links.map((b) => TR.pathLoss(flat, O, b)).sort((x, y) => x - y);
  const p90 = losses[2] + (losses[3] - losses[2]) * 0.7;
  const b = TR.budgetOf(flat, O, 10, links);
  close(b.db, p90, 1e-9, 'budget');
  assert.deepStrictEqual([b.source, b.links], ['links', 4]);
});

test('budgetOf: fewer than two usable links give the 120 dB default', () => {
  const one = TR.budgetOf(flat, O, 10, [at(1000, 0)]), none = TR.budgetOf(flat, O, 10, []);
  assert.deepStrictEqual([one.db, one.source, one.links], [120, 'default', 1]);
  assert.deepStrictEqual([none.db, none.source, none.links], [120, 'default', 0]);
  // A link beyond 40 km is not profiled (its tiles are not fetched).
  assert.strictEqual(TR.budgetOf(flat, O, 10, [at(1000, 0), at(45000, 0)]).source, 'default');
});

test('terrainExtents walks 72 rays; the ridge side is short, the open side long', () => {
  const ext = TR.terrainExtents(ridgeWest, O.lat, O.lon, 14000, 10, 105);
  assert.strictEqual(ext.length, 72);
  assert.ok(ext[54] < 2400, 'west ' + ext[54]);        // 270° = ray 54
  assert.ok(ext[18] > 4000, 'east ' + ext[18]);         // 90° = ray 18: free space to 105 dB is ~4.5 km
});

console.log('\n=== terrain-reach.js: heights and settings ===');

test('a receiver lower to the ground loses more: the reach is drawn for receiverHeightM', () => {
  const k = Math.round(10000 / STEP);
  const at10 = TR.lossProfile(flat, O.lat, O.lon, deg(90), 12000, 10)[k];
  const at2 = TR.lossProfile(flat, O.lat, O.lon, deg(90), 12000, 10, 2)[k];
  // The earth's bulge reaches further into a low receiver's Fresnel zone.
  assert.ok(at2 > at10 + 1, '2 m ' + at2 + ' vs 10 m ' + at10);
  assert.strictEqual(TR.lossProfile(flat, O.lat, O.lon, deg(90), 12000, 10, 10)[k], at10, 'the default is 10 m');
});

test('pathLoss takes the listener\'s height: one on a mast behind the ridge loses less', () => {
  const b = at(-4800, 0);
  const low = TR.pathLoss(ridgeWest, O, b, 10), high = TR.pathLoss(ridgeWest, O, b, 10, 150);
  assert.ok(high < low - 5, 'listener at 10 m ' + low + ', at 150 m ' + high);
  assert.strictEqual(TR.pathLoss(ridgeWest, O, b, 10, 10), low, 'the default is 10 m');
});

test('budgetOf uses each listener\'s own height when it has one', () => {
  // Three listeners behind the ridge, one of them on a 150 m mast.
  const plain = [at(-4800, 0), at(-4800, 1000), at(-4800, -1000)];
  const tall = plain.map((b, i) => (i === 0 ? Object.assign({ antennaM: 150 }, b) : b));
  const p = TR.budgetOf(ridgeWest, O, 10, plain, { pct: 1 }).db, t = TR.budgetOf(ridgeWest, O, 10, tall, { pct: 0 }).db;
  assert.ok(t < TR.budgetOf(ridgeWest, O, 10, plain, { pct: 0 }).db - 5, 'tall listener ' + t);
  assert.ok(p >= TR.budgetOf(ridgeWest, O, 10, tall, { pct: 1 }).db, 'never raised');
});

test('budgetOf: the percentile and the default are settings', () => {
  const links = [at(1000, 0), at(0, 2000), at(-3000, 0), at(0, -4000)];
  const losses = links.map((b) => TR.pathLoss(flat, O, b)).sort((x, y) => x - y);
  close(TR.budgetOf(flat, O, 10, links, { pct: 0.5 }).db, (losses[1] + losses[2]) / 2, 1e-9, 'median');
  close(TR.budgetOf(flat, O, 10, links, { pct: 1 }).db, losses[3], 1e-9, 'max');
  const one = TR.budgetOf(flat, O, 10, [at(1000, 0)], { defaultDb: 110 });
  assert.deepStrictEqual([one.db, one.source], [110, 'default']);
});

test('reachOf rule "first" stops at the first spot over budget; "farthest" (the default) reaches past it', () => {
  const L = Float32Array.from([0, 90, 130, 95, 140]);
  assert.strictEqual(TR.reachOf(L, 100, 'first'), 1 * STEP);
  assert.strictEqual(TR.reachOf(L, 100, 'farthest'), 3 * STEP);
  assert.strictEqual(TR.reachOf(L, 100), 3 * STEP);
  assert.strictEqual(TR.reachOf(L, 200, 'first'), 4 * STEP);
});

test('with rule "first" the hilltop past a valley is not reached', () => {
  const t = terrain((x) => (x < -1850 && x > -2150 ? 150 : (x < -9000 && x > -11000 ? 300 : 50)));
  const L = TR.lossProfile(t, O.lat, O.lon, deg(270), 14000);
  const budget = L[Math.round(10000 / STEP)] + 1;
  const ext = TR.terrainExtents(t, O.lat, O.lon, 14000, 10, budget, { rule: 'first' });
  assert.ok(ext[54] < 3000, 'west ' + ext[54]);
  assert.ok(TR.terrainExtents(t, O.lat, O.lon, 14000, 10, budget)[54] >= 10000, 'farthest still reaches it');
});

console.log('\n=== terrain-reach.js: provider ===');

// Fake tile fetcher: renders a terrain function into z11 tiles, as the
// browser fetcher would decode them.
function tileFetcher(fn, opts) {
  opts = opts || {};
  const calls = [];
  const fetchTile = (z, x, y) => {
    calls.push(z + '/' + x + '/' + y);
    if (opts.fail) return Promise.reject(new Error('503'));
    const n = Math.pow(2, z), arr = new Float32Array(65536);
    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        const lon = (x + (px + 0.5) / 256) / n * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + (py + 0.5) / 256) / n))) * 180 / Math.PI;
        const p = local(O.lat, O.lon, lat, lon);
        arr[py * 256 + px] = fn(p.x, p.y);
      }
    }
    return Promise.resolve(arr);
  };
  return { fetchTile, calls };
}
function memStore(initial, quota) {
  const s = Object.assign({}, initial || {});
  const size = () => Object.keys(s).reduce((n, k) => n + k.length + s[k].length, 0);
  return {
    s, size,
    getItem: k => (k in s ? s[k] : null),
    // Like a browser: a write that would take the store over its quota throws.
    setItem: (k, v) => {
      v = String(v);
      if (quota && size() - (k in s ? k.length + s[k].length : 0) + k.length + v.length > quota) {
        const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
      }
      s[k] = v;
    },
    removeItem: k => { delete s[k]; },
  };
}
const STORE = 'meshcore-terrain-reach-v3';
// A repeater with many partners: the cache key carries the partner list, so
// an entry is about the size a busy repeater's is (~1 KB).
const busy = (i) => ({ pk: 'n' + i, lat: O.lat + i * 0.001, lon: O.lon, R: 1000,
  links: Array.from({ length: 16 }, (_, k) => at(800 + k * 50, 600 + i)) });
const immediate = () => Promise.resolve();

test('the provider fetches only the tiles around the repeater and reports progress', () => {
  const f = tileFetcher((x) => (x < -1850 && x > -2150 ? 150 : 50));
  const p = TR.createTerrainProvider({ fetchTile: f.fetchTile, storage: memStore(), yieldFn: immediate });
  const seen = [];
  return p.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 6000 }], (pk, ext) => seen.push(pk)).then(res => {
    assert.deepStrictEqual(seen, ['a']);
    const ext = res.get('a');
    // No links: the 120 dB default; east is open ground.
    assert.ok(FLAT_REACH > 12000 && FLAT_REACH < 20000, 'flat reach ' + FLAT_REACH);
    assert.ok(ext[54] < 2400 && Math.abs(ext[18] - FLAT_REACH) <= STEP, 'west ' + ext[54] + ' east ' + ext[18]);
    // The 30 km box round it: 5 x 5 z11 tiles at 45°N, give or take a row.
    assert.ok(f.calls.length >= 16 && f.calls.length <= 36, f.calls.length + ' tiles fetched');
    assert.ok(f.calls.every(c => c.startsWith('11/')), f.calls.join(' '));
    assert.strictEqual(p.status(), 'ok');
  });
});

test('the provider uses an operator height, calibrates the budget on links, and says which', () => {
  const f = tileFetcher((x) => (x < -1850 && x > -2150 ? 150 : 50));
  const p = TR.createTerrainProvider({ fetchTile: f.fetchTile, storage: memStore(), yieldFn: immediate });
  const meta = {};
  const links = [at(0, 6000), at(5000, 0), at(0, -3000)];
  return p.extentsFor([
    { pk: 'set', lat: O.lat, lon: O.lon, R: 6000, antennaM: 200 },
    { pk: 'links', lat: O.lat, lon: O.lon, R: 6000, links },
    { pk: 'none', lat: O.lat, lon: O.lon, R: 6000 },
  ], (pk, ext, m) => { meta[pk] = Object.assign({ west: ext[54], east: ext[18] }, m); }).then(() => {
    assert.deepStrictEqual([meta.set.antennaM, meta.set.source, meta.set.budgetSource], [200, 'set', 'default']);
    assert.ok(meta.set.west > meta.none.west + 5000, 'a 200 m mast sees past the ridge: ' + meta.set.west);
    assert.deepStrictEqual([meta.links.antennaM, meta.links.source, meta.links.budgetSource], [10, 'default', 'links']);
    // None of the three links crosses the ridge: open ground, free space.
    close(meta.links.budget, TR.budgetOf(() => 50, O, 10, links).db, 0.05, 'budget from the three links');
    // Heard 3, 5 and 6 km out over open ground: the 90th percentile lies
    // between the 5 and 6 km losses, so the open east ray ends between them.
    assert.ok(meta.links.east > 5000 && meta.links.east < 6000, 'east ' + meta.links.east);
    assert.deepStrictEqual([meta.none.budget, meta.none.budgetSource], [120, 'default']);
  });
});

test('the budget survives a reload with the cached result', () => {
  const store = memStore();
  const mk = () => TR.createTerrainProvider({ fetchTile: tileFetcher(() => 50).fetchTile, storage: store, yieldFn: immediate });
  const item = { pk: 'a', lat: O.lat, lon: O.lon, R: 2000, links: [at(3000, 0), at(0, 2000)] };
  let first = null;
  return mk().extentsFor([item], (pk, ext, m) => { first = m; }).then(() => {
    let meta = null;
    const p2 = mk();
    return p2.extentsFor([item], (pk, ext, m) => { meta = m; }).then(() => {
      assert.strictEqual(p2.stats().computed, 0, 'recomputed after reload');
      assert.deepStrictEqual([meta.antennaM, meta.source, meta.budgetSource], [10, 'default', 'links']);
      close(meta.budget, first.budget, 0.05, 'budget');
    });
  });
});

test('a link added or lost re-calibrates the budget', () => {
  const p = TR.createTerrainProvider({ fetchTile: tileFetcher(() => 50).fetchTile, storage: memStore(), yieldFn: immediate });
  const base = { pk: 'a', lat: O.lat, lon: O.lon, R: 2000 };
  return p.extentsFor([Object.assign({ links: [at(3000, 0)] }, base)])
    .then(() => p.extentsFor([Object.assign({ links: [at(3000, 0), at(0, 3000)] }, base)]))
    .then(() => assert.strictEqual(p.stats().computed, 2));
});

test('setParams: each setting changes the reach, invalid ones are ignored, and a change computes afresh', () => {
  const f = tileFetcher((x) => (x < -1850 && x > -2150 ? 150 : 50));
  const p = TR.createTerrainProvider({ fetchTile: f.fetchTile, storage: memStore(), yieldFn: immediate });
  const links = [at(0, 6000), at(5000, 0), at(0, -3000)];
  const it = { pk: 'a', lat: O.lat, lon: O.lon, R: 6000, links };
  const run = () => p.extentsFor([it]).then((m) => Array.from(m.get('a')));
  let base;
  return run().then((e) => {
    base = e;
    p.setParams({ budgetPercentile: 50 });
    return run();
  }).then((e) => {
    assert.ok(e[18] < base[18], 'a lower percentile shrinks the open side: ' + e[18] + ' vs ' + base[18]);
    p.setParams({ receiverHeightM: 2 });
    return run();
  }).then((e) => {
    assert.ok(e[18] < base[18], 'a 2 m receiver shrinks the open side: ' + e[18] + ' vs ' + base[18]);
    p.setParams({ maxReachKm: 3, defaultBudgetDb: 200 });
    return p.extentsFor([{ pk: 'b', lat: O.lat, lon: O.lon, R: 6000 }]);
  }).then((m) => {
    assert.ok(Array.from(m.get('b')).every((v) => v <= 3000), 'capped at 3 km: ' + Math.max(...m.get('b')));
    p.setParams({ budgetPercentile: 5, reachRule: 'longest', maxReachKm: -1, receiverHeightM: 0 });
    const q = p.params();
    assert.deepStrictEqual([q.budgetPct, q.reachRule, q.maxReachM, q.receiverM], [0.9, 'farthest', 30000, 10], 'invalid settings keep the defaults');
    return run();
  }).then((e) => {
    assert.deepStrictEqual(e, base, 'back to the defaults, the first result again');
    // One entry per repeater: each change of settings computed it afresh.
    assert.strictEqual(p.stats().computed, 5, 'computed ' + p.stats().computed);
  });
});

test('two requests for the same tile share one fetch', () => {
  const f = tileFetcher(() => 50);
  const p = TR.createTerrainProvider({ fetchTile: f.fetchTile, storage: memStore(), yieldFn: immediate });
  return Promise.all([
    p.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 2000 }]),
    p.extentsFor([{ pk: 'b', lat: O.lat + 0.001, lon: O.lon, R: 2000 }]),
  ]).then(() => {
    assert.strictEqual(new Set(f.calls).size, f.calls.length, 'duplicate fetches: ' + f.calls.join(' '));
  });
});

test('results are cached, persisted, and reused after a reload without fetching', () => {
  const store = memStore();
  const f = tileFetcher(() => 50);
  const p = TR.createTerrainProvider({ fetchTile: f.fetchTile, storage: store, yieldFn: immediate });
  return p.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 3000 }]).then(first => {
    assert.ok(store.s[STORE], 'not persisted');
    const f2 = tileFetcher(() => 50);
    const p2 = TR.createTerrainProvider({ fetchTile: f2.fetchTile, storage: store, yieldFn: immediate });
    return p2.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 3000 }]).then(res => {
      assert.strictEqual(f2.calls.length, 0, 'fetched again: ' + f2.calls.join(' '));
      // Persisted to the nearest 10 m.
      close(res.get('a')[0], first.get('a')[0], 5, 'reach after reload');
    });
  });
});

test('a moved repeater or a new radius is computed afresh', () => {
  const store = memStore();
  const f = tileFetcher(() => 50);
  const p = TR.createTerrainProvider({ fetchTile: f.fetchTile, storage: store, yieldFn: immediate });
  let computed = 0;
  return p.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 3000 }], () => computed++)
    .then(() => p.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 3000 }], () => computed++))
    .then(() => p.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 4000 }], () => computed++))
    .then(() => p.extentsFor([{ pk: 'a', lat: O.lat + 0.01, lon: O.lon, R: 4000 }], () => computed++))
    .then(res => {
      assert.strictEqual(p.stats().computed, 3, 'computed ' + p.stats().computed);
      close(res.get('a')[0], FLAT_REACH, STEP, 'flat');
    });
});

test('the persisted cache is capped, oldest entries dropped first', () => {
  const store = memStore();
  const p = TR.createTerrainProvider({ fetchTile: tileFetcher(() => 50).fetchTile, storage: store, yieldFn: immediate, maxEntries: 3 });
  const list = [0, 1, 2, 3, 4].map(i => ({ pk: 'n' + i, lat: O.lat, lon: O.lon, R: 1000 }));
  return p.extentsFor(list).then(() => {
    const saved = JSON.parse(store.s[STORE]);
    const keys = Object.keys(saved.data);
    assert.strictEqual(keys.length, 3);
    assert.ok(keys.every(k => /^n[234]@/.test(k)), keys.join(' '));
  });
});

test('the persisted cache stays under its size limit, newest entries kept', () => {
  const store = memStore();
  const p = TR.createTerrainProvider({ fetchTile: tileFetcher(() => 50).fetchTile, storage: store, yieldFn: immediate, maxChars: 8000 });
  const list = Array.from({ length: 30 }, (_, i) => busy(i));
  return p.extentsFor(list).then(() => {
    const raw = store.s[STORE];
    assert.ok(raw.length <= 8000, 'persisted ' + raw.length + ' chars');
    const keys = Object.keys(JSON.parse(raw).data);
    assert.ok(keys.length >= 3 && keys.length < 30, keys.length + ' entries');
    assert.ok(keys.some(k => k.startsWith('n29@')), 'newest entry dropped');
    assert.ok(!keys.some(k => k.startsWith('n0@')), 'oldest entry kept');
  });
});

test('the default limits keep the cache well inside a browser\'s localStorage', () => {
  // ~5 MB per site is shared with every other CoreScope setting.
  assert.ok(TR.limits.maxEntries <= 500, 'maxEntries ' + TR.limits.maxEntries);
  assert.ok(TR.limits.maxChars <= 600000, 'maxChars ' + TR.limits.maxChars);
});

test('a repeater keeps only its newest result: one whose links changed does not pile up', () => {
  const store = memStore();
  const p = TR.createTerrainProvider({ fetchTile: tileFetcher(() => 50).fetchTile, storage: store, yieldFn: immediate });
  const base = { pk: 'a', lat: O.lat, lon: O.lon, R: 2000 };
  return p.extentsFor([Object.assign({ links: [at(3000, 0)] }, base)])
    .then(() => p.extentsFor([Object.assign({ links: [at(3000, 0), at(0, 3000)] }, base)]))
    .then(() => p.extentsFor([Object.assign({}, base, { R: 2500 })]))
    .then(() => {
      const keys = Object.keys(JSON.parse(store.s[STORE]).data);
      assert.deepStrictEqual(keys.map(k => k.split('@')[0]), ['a'], keys.join(' '));
      assert.ok(keys[0].includes('|2500|'), keys[0]);
    });
});

test('a full localStorage: the cache shrinks or steps aside, the provider never throws', () => {
  // Other settings already take most of the quota.
  const store = memStore({ 'meshcore-settings': 'x'.repeat(9000) }, 12000);
  const p = TR.createTerrainProvider({ fetchTile: tileFetcher(() => 50).fetchTile, storage: store, yieldFn: immediate });
  return p.extentsFor(Array.from({ length: 20 }, (_, i) => busy(i))).then(res => {
    assert.strictEqual(res.size, 20);
    assert.ok(store.size() <= 12000, 'store over quota: ' + store.size());
    assert.strictEqual(store.s['meshcore-settings'].length, 9000, 'another setting was touched');
  });
});

test('terrain can be turned off: nothing is fetched, nothing is answered, status says off', () => {
  const f = tileFetcher(() => 50);
  const p = TR.createTerrainProvider({ fetchTile: f.fetchTile, storage: memStore(), yieldFn: immediate });
  p.setSource({ disabled: true });
  let progress = 0;
  return p.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 3000 }], () => progress++).then(res => {
    assert.strictEqual(f.calls.length, 0, 'fetched: ' + f.calls.join(' '));
    assert.strictEqual(res.size, 0);
    assert.strictEqual(progress, 0);
    assert.strictEqual(p.status(), 'off');
  });
});

test('another tile source: its URL template is filled in, and its results are kept apart', () => {
  assert.strictEqual(TR.tileUrl(null, 11, 470, 755), 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/11/470/755.png');
  assert.strictEqual(TR.tileUrl('https://t.example.org/dem/{z}/{x}/{y}.png', 11, 470, 755), 'https://t.example.org/dem/11/470/755.png');
  const store = memStore();
  const f = tileFetcher(() => 50);
  const p = TR.createTerrainProvider({ fetchTile: f.fetchTile, storage: store, yieldFn: immediate });
  const it = { pk: 'a', lat: O.lat, lon: O.lon, R: 3000 };
  return p.extentsFor([it]).then(() => {
    p.setSource({ url: 'https://t.example.org/dem/{z}/{x}/{y}.png' });
    return p.extentsFor([it]);
  }).then(() => {
    assert.strictEqual(p.stats().computed, 2, 'a result from the other source was reused');
    p.setSource(null);
    assert.strictEqual(p.status(), 'ok');
  });
});

// Tiles are cached by position; the source must be part of what they are
// cached under, or a new source draws with the old one's elevation.
test('changing the tile source never reuses the previous source\'s tiles', () => {
  const B = 'https://t.example.org/dem/{z}/{x}/{y}.png';
  const urls = [];
  const flat = tileFetcher(() => 50).fetchTile;
  const fetchTile = (z, x, y, url) => { urls.push(url || 'default'); return flat(z, x, y); };
  const p = TR.createTerrainProvider({ fetchTile, storage: memStore(), yieldFn: immediate });
  const it = { pk: 'a', lat: O.lat, lon: O.lon, R: 3000 };
  return p.extentsFor([it]).then(() => {
    const first = urls.length;
    assert.ok(first > 0 && urls.every(u => u === 'default'));
    p.setSource({ url: B });
    return p.extentsFor([it]).then(() => {
      const after = urls.slice(first);
      assert.strictEqual(after.length, first, 'every tile fetched again: ' + after.join(' '));
      assert.ok(after.every(u => u === B), 'from the new source: ' + after.join(' '));
    });
  });
});

test('a tile still on its way from the previous source is not kept for the new one', () => {
  const B = 'https://t.example.org/dem/{z}/{x}/{y}.png';
  const flat = tileFetcher(() => 50).fetchTile;
  const held = [], urls = [];
  const fetchTile = (z, x, y, url) => {
    urls.push(url || 'default');
    if (!url) return new Promise(r => held.push(() => r(flat(z, x, y))));
    return flat(z, x, y);
  };
  const p = TR.createTerrainProvider({ fetchTile, storage: memStore(), yieldFn: immediate });
  const it = { pk: 'a', lat: O.lat, lon: O.lon, R: 3000 };
  const old = p.extentsFor([it]);
  const started = () => held.length ? Promise.resolve() : new Promise(r => setTimeout(r, 0)).then(started);
  return started().then(() => {
    assert.ok(urls.every(u => u === 'default'), 'test premise: the old source\'s fetch is in flight');
    p.setSource({ url: B });
    held.forEach(f => f());
    return old;
  }).then(() => {
    const before = urls.length;
    return p.extentsFor([Object.assign({}, it, { pk: 'b' })]).then(() => {
      const after = urls.slice(before);
      assert.ok(after.length > 0 && after.every(u => u === B), 'fetched from the new source: ' + after.join(' '));
    });
  });
});

test('broken storage never breaks the provider', () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  const p = TR.createTerrainProvider({ fetchTile: tileFetcher(() => 50).fetchTile, storage: bad, yieldFn: immediate });
  return p.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 1000 }]).then(res => close(res.get('a')[0], FLAT_REACH, STEP, 'flat'));
});

test('when tiles fail, reach falls back to the radius and status says so; nothing is persisted', () => {
  const store = memStore();
  const p = TR.createTerrainProvider({ fetchTile: tileFetcher(() => 50, { fail: true }).fetchTile, storage: store, yieldFn: immediate });
  return p.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 5000 }]).then(res => {
    assert.ok(Array.from(res.get('a')).every(v => v === 5000));
    assert.strictEqual(p.status(), 'unavailable');
    assert.ok(!store.s[STORE] || !/a@/.test(store.s[STORE]), 'fallback persisted');
  });
});

test('the tile cache holds at most 64 tiles', () => {
  const f = tileFetcher(() => 50);
  const p = TR.createTerrainProvider({ fetchTile: f.fetchTile, storage: memStore(), yieldFn: immediate });
  // 12 repeaters far apart, each with ~25 tiles of its own.
  const list = [];
  for (let i = 0; i < 12; i++) list.push({ pk: 'r' + i, lat: 45 + Math.floor(i / 4) * 0.8, lon: -100 + (i % 4) * 0.8, R: 1000 });
  return p.extentsFor(list).then(() => assert.ok(p.stats().tiles <= 64, 'tiles held ' + p.stats().tiles));
});

test('shared() is one provider per page', () => {
  assert.strictEqual(TR.shared(), TR.shared());
});

console.log('\n=== terrain-reach.js: performance ===');

test('72 rays to 30 km over real-looking terrain: median under budget', () => {
  // Rolling hills: ~30 m relief, a few km across.
  const hills = terrain((x, y) => 80 + 15 * Math.sin(x / 1700) + 15 * Math.cos(y / 2300) + 5 * Math.sin((x + y) / 600));
  for (let w = 0; w < 2; w++) TR.terrainExtents(hills, O.lat, O.lon, 30000, 10, 120);
  const times = [];
  for (let r = 0; r < 5; r++) {
    const t0 = process.hrtime.bigint();
    TR.terrainExtents(hills, O.lat + r * 0.01, O.lon, 30000, 10, 120);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  console.log('     (median ' + times[2].toFixed(2) + ' ms per repeater (target 25 ms))');
  // Headroom over the target for slower CI runners.
  assert.ok(times[2] < 50, 'median ' + times[2].toFixed(2) + ' ms');
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
