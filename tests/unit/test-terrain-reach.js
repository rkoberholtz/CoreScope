'use strict';
// Unit tests for terrain-reach.js: line-of-sight reach over elevation tiles
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
const O = { lat: 40.0, lon: -75.3 };

console.log('\n=== terrain-reach.js: tiles ===');

test('exposes its API', () => {
  assert.ok(TR, 'window.TerrainReach not defined');
  for (const fn of ['tileOf', 'decodeTerrarium', 'rayCut', 'terrainExtents', 'createTerrainProvider', 'shared']) {
    assert.strictEqual(typeof TR[fn], 'function', fn + ' not exported');
  }
  assert.strictEqual(TR.rays, 72);
});

test('tileOf matches the slippy-map tile at known coordinates', () => {
  const t12 = TR.tileOf(40.0, -75.3, 12);
  assert.strictEqual(Math.floor(t12.fx), 1191);
  assert.strictEqual(Math.floor(t12.fy), 1550);
  const t11 = TR.tileOf(40.0, -75.3, 11);
  assert.strictEqual(Math.floor(t11.fx), 595);
  assert.strictEqual(Math.floor(t11.fy), 775);
});

test('decodeTerrarium turns RGBA into metres', () => {
  // 0 m = 128,0,0; 100.5 m = 128,100,128; -10 m = 127,246,0
  const rgba = new Uint8ClampedArray([128, 0, 0, 255, 128, 100, 128, 255, 127, 246, 0, 255]);
  const out = Array.from(TR.decodeTerrarium(rgba));
  assert.deepStrictEqual(out, [0, 100.5, -10]);
});

console.log('\n=== terrain-reach.js: line of sight ===');

// sample(lat, lon) built from a function of metres east/north of O.
const terrain = (fn) => (lat, lon) => { const p = local(O.lat, O.lon, lat, lon); return fn(p.x, p.y); };
const flat = terrain(() => 50);

test('flat ground reaches the full radius', () => {
  const cut = TR.rayCut(flat, O.lat, O.lon, deg(90), 14000);
  assert.strictEqual(cut, 14000);
});

test('flat ground is cut by the curve of the earth where the analytic model says', () => {
  // Heights relative to the antenna: ground g(x) = -10 - x^2/2kR, receiver at
  // D sits 2 m above it, line slope s = (g(D) + 2) / D. The bulge pokes
  // above the line by at most -10 + s^2 kR / 2, so the receiver is in view
  // while that is <= 10 m: s^2 <= 2 (10 + 10) / kR. Solving
  // D^2/2kR + 8 = sqrt(40/kR) D gives D = 32.7 km (k = 4/3). Without the
  // tolerance it would be the textbook 18.9 km radio horizon.
  const kR = 4 / 3 * 6371008.8;
  const a = 1 / (2 * kR), b = -Math.sqrt(40 / kR), c = 8;
  const expected = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  const cut = TR.rayCut(flat, O.lat, O.lon, deg(90), 40000);
  assert.ok(Math.abs(cut - expected) < 700, 'cut at ' + cut + ', analytic ' + Math.round(expected));
});

// A 150 m ridge, 300 m wide, running north-south 2 km west of O.
const ridgeWest = terrain((x) => (x < -1850 && x > -2150 ? 150 : 50));

test('a ridge cuts the ray just past it', () => {
  const cut = TR.rayCut(ridgeWest, O.lat, O.lon, deg(270), 14000);
  assert.ok(cut > 1800 && cut < 2400, 'cut at ' + cut);
});

test('the same ridge does not touch the other side', () => {
  assert.strictEqual(TR.rayCut(ridgeWest, O.lat, O.lon, deg(90), 14000), 14000);
});

test('a valley behind the ridge stays cut, even where land rises again far off (first shadow)', () => {
  const t = terrain((x) => (x < -1850 && x > -2150 ? 150 : (x < -9000 ? 400 : 50)));
  const cut = TR.rayCut(t, O.lat, O.lon, deg(270), 14000);
  assert.ok(cut < 2400, 'cut at ' + cut);
});

test('ground falling away gives the full radius', () => {
  const down = terrain((x, y) => 100 + y / 200);   // falls 5 m per km to the south
  assert.strictEqual(TR.rayCut(down, O.lat, O.lon, deg(180), 14000), 14000);
});

test('a small bump near the repeater does not end the ray', () => {
  // 15 m bump 1 km out: receivers just behind it are shadowed for a few
  // hundred metres, but well short of the 600 m a shadow must last.
  const bump = terrain((x) => (x > 950 && x < 1050 ? 65 : 50));
  assert.strictEqual(TR.rayCut(bump, O.lat, O.lon, deg(90), 14000), 14000);
});

test('missing terrain leaves the ray at the radius', () => {
  assert.strictEqual(TR.rayCut(() => NaN, O.lat, O.lon, deg(0), 9000), 9000);
});

test('terrainExtents walks 72 rays', () => {
  const ext = TR.terrainExtents(ridgeWest, O.lat, O.lon, 14000);
  assert.strictEqual(ext.length, 72);
  assert.ok(ext[54] < 2400, 'west ' + ext[54]);       // 270° = ray 54
  assert.strictEqual(ext[18], 14000);                   // 90° = ray 18
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
function memStore(initial) {
  const s = Object.assign({}, initial || {});
  return { s, getItem: k => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); } };
}
const immediate = () => Promise.resolve();

test('the provider fetches only the tiles around the repeater and reports progress', () => {
  const f = tileFetcher((x) => (x < -1850 && x > -2150 ? 150 : 50));
  const p = TR.createTerrainProvider({ fetchTile: f.fetchTile, storage: memStore(), yieldFn: immediate });
  const seen = [];
  return p.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 6000 }], (pk, ext) => seen.push(pk)).then(res => {
    assert.deepStrictEqual(seen, ['a']);
    const ext = res.get('a');
    assert.ok(ext[54] < 2400 && ext[18] === 6000, 'west ' + ext[54] + ' east ' + ext[18]);
    assert.ok(f.calls.length >= 1 && f.calls.length <= 4, 'tiles fetched: ' + f.calls.join(' '));
    assert.ok(f.calls.every(c => c.startsWith('11/')), f.calls.join(' '));
    assert.strictEqual(p.status(), 'ok');
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
  return p.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 3000 }]).then(() => {
    assert.ok(store.s['meshcore-terrain-reach-v1'], 'not persisted');
    const f2 = tileFetcher(() => 50);
    const p2 = TR.createTerrainProvider({ fetchTile: f2.fetchTile, storage: store, yieldFn: immediate });
    return p2.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 3000 }]).then(res => {
      assert.strictEqual(f2.calls.length, 0, 'fetched again: ' + f2.calls.join(' '));
      assert.strictEqual(res.get('a')[0], 3000);
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
      assert.strictEqual(res.get('a')[0], 4000);
    });
});

test('the persisted cache is capped, oldest entries dropped first', () => {
  const store = memStore();
  const p = TR.createTerrainProvider({ fetchTile: tileFetcher(() => 50).fetchTile, storage: store, yieldFn: immediate, maxEntries: 3 });
  const list = [0, 1, 2, 3, 4].map(i => ({ pk: 'n' + i, lat: O.lat, lon: O.lon, R: 1000 }));
  return p.extentsFor(list).then(() => {
    const saved = JSON.parse(store.s['meshcore-terrain-reach-v1']);
    const keys = Object.keys(saved.data);
    assert.strictEqual(keys.length, 3);
    assert.ok(keys.every(k => /^n[234]@/.test(k)), keys.join(' '));
  });
});

test('broken storage never breaks the provider', () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  const p = TR.createTerrainProvider({ fetchTile: tileFetcher(() => 50).fetchTile, storage: bad, yieldFn: immediate });
  return p.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 1000 }]).then(res => assert.strictEqual(res.get('a')[0], 1000));
});

test('when tiles fail, reach falls back to the radius and status says so; nothing is persisted', () => {
  const store = memStore();
  const p = TR.createTerrainProvider({ fetchTile: tileFetcher(() => 50, { fail: true }).fetchTile, storage: store, yieldFn: immediate });
  return p.extentsFor([{ pk: 'a', lat: O.lat, lon: O.lon, R: 5000 }]).then(res => {
    assert.ok(Array.from(res.get('a')).every(v => v === 5000));
    assert.strictEqual(p.status(), 'unavailable');
    assert.ok(!store.s['meshcore-terrain-reach-v1'] || !/a@/.test(store.s['meshcore-terrain-reach-v1']), 'fallback persisted');
  });
});

test('the tile cache holds at most 64 tiles', () => {
  const f = tileFetcher(() => 50);
  const p = TR.createTerrainProvider({ fetchTile: f.fetchTile, storage: memStore(), yieldFn: immediate });
  // 100 repeaters, each on its own tile.
  const list = [];
  for (let i = 0; i < 100; i++) list.push({ pk: 'r' + i, lat: 40 + Math.floor(i / 10) * 0.2, lon: -75 + (i % 10) * 0.2, R: 1000 });
  return p.extentsFor(list).then(() => assert.ok(p.stats().tiles <= 64, 'tiles held ' + p.stats().tiles));
});

test('shared() is one provider per page', () => {
  assert.strictEqual(TR.shared(), TR.shared());
});

console.log('\n=== terrain-reach.js: performance ===');

test('72 rays to 14 km over real-looking terrain: median under budget', () => {
  // Rolling hills: ~30 m relief, a few km across.
  const hills = terrain((x, y) => 80 + 15 * Math.sin(x / 1700) + 15 * Math.cos(y / 2300) + 5 * Math.sin((x + y) / 600));
  for (let w = 0; w < 3; w++) TR.terrainExtents(hills, O.lat, O.lon, 14000);
  const times = [];
  for (let r = 0; r < 5; r++) {
    const t0 = process.hrtime.bigint();
    TR.terrainExtents(hills, O.lat + r * 0.01, O.lon, 14000);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  console.log('     (median ' + times[2].toFixed(2) + ' ms per repeater (target 5 ms))');
  // Headroom over the target for slower CI runners.
  assert.ok(times[2] < 10, 'median ' + times[2].toFixed(2) + ' ms');
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
