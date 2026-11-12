'use strict';
// Unit tests for scope-geometry.js on its own: the geometry the region
// contours draw with, loaded without scope-contours.js, so it is proven to
// stand alone.
const REPO_ROOT = require('path').resolve(__dirname, '..', '..');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'public', 'scope-geometry.js'), 'utf8'), sandbox);
const G = sandbox.window.ScopeGeometry;

const O = { lat: 45.0, lon: -100.0 };
function offset(p, eastM, northM) {
  return { lat: p.lat + northM / 111320, lon: p.lon + eastM / (111320 * Math.cos(p.lat * Math.PI / 180)) };
}
// Metres east/north of O, the way the module projects.
function local(pt) {
  return [(pt[1] - O.lon) * 111320 * Math.cos(O.lat * Math.PI / 180), (pt[0] - O.lat) * 111320];
}
function metres(a, b) { const p = local(a), q = local(b); return Math.hypot(p[0] - q[0], p[1] - q[1]); }
function area(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = local(ring[j]), b = local(ring[i]);
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
const segLen = (lines) => lines.reduce((t, l) => { for (let i = 1; i < l.length; i++) t += metres(l[i - 1], l[i]); return t; }, 0);
const oct = (p, r) => G.octagon(p.lat, p.lon, r);
const plain = (r) => JSON.parse(JSON.stringify(r));

console.log('\n=== scope-geometry.js ===');

test('loads on its own and exposes its API', () => {
  assert.ok(G, 'window.ScopeGeometry not defined');
  for (const fn of ['octagon', 'tube', 'convexHull', 'linkShapes', 'outline', 'inAny', 'ringsBounds']) {
    assert.strictEqual(typeof G[fn], 'function', fn);
  }
  assert.strictEqual(G.mPerDeg, 111320);
});

test('octagon: 8 corners at the radius, flat sides to the compass points, anticlockwise', () => {
  const r = oct(O, 4000);
  assert.strictEqual(r.length, 8);
  r.forEach((p) => assert.ok(Math.abs(metres(p, [O.lat, O.lon]) - 4000) < 1, 'corner at 4 km'));
  const north = Math.max(...r.map((p) => local(p)[1])), east = Math.max(...r.map((p) => local(p)[0]));
  const apothem = 4000 * Math.cos(Math.PI / 8);
  assert.ok(Math.abs(north - apothem) < 1 && Math.abs(east - apothem) < 1, 'flat side ' + north);
  assert.strictEqual(r.filter((p) => Math.abs(local(p)[1] - north) < 1).length, 2, 'two corners on the north side');
  assert.ok(area(r) > 0, 'anticlockwise in east/north');
  assert.ok(Math.abs(area(r) - 2 * Math.SQRT2 * 4000 * 4000) < 1000, 'area of a regular octagon');
});

test('convexHull keeps the corners only, anticlockwise', () => {
  const h = plain(G.convexHull([[0, 0], [0, 2], [2, 2], [2, 0], [1, 1], [1, 0], [0, 0]]));
  assert.strictEqual(h.length, 4);
  assert.deepStrictEqual(h.map((p) => p.join(',')).sort(), ['0,0', '0,2', '2,0', '2,2']);
  assert.deepStrictEqual(plain(G.convexHull([[0, 0], [1, 1]])), []);
});

test('tube: holds both ends, is as wide as asked and no wider', () => {
  const a = O, b = offset(O, 20000, 0);
  const t = G.tube(a, b, 700);
  assert.ok(t.length >= 6 && t.length <= 10, 'corners ' + t.length);
  assert.ok(area(t) > 0, 'anticlockwise');
  assert.ok(G.inAny([t], a.lat, a.lon) && G.inAny([t], b.lat, b.lon), 'both ends inside');
  const mid = offset(O, 10000, 0);
  const inAt = (n) => { const p = offset(mid, 0, n); return G.inAny([t], p.lat, p.lon); };
  assert.ok(inAt(600) && inAt(-600), 'inside at 600 m off the line');
  assert.ok(!inAt(750) && !inAt(-750), 'outside at 750 m off the line');
  const ys = t.map((p) => local(p)[1]);
  assert.ok(Math.max(...ys) <= 700.5 && Math.min(...ys) >= -700.5, 'never wider than the half width');
});

test('tube: a diagonal one is still at least 92% of the half width either side', () => {
  const b = offset(O, 9000, 14000), t = G.tube(O, b, 1000);
  const len = Math.hypot(9000, 14000), nx = -14000 / len, ny = 9000 / len;
  const mid = offset(O, 4500, 7000);
  const inAt = (d) => { const p = offset(mid, nx * d, ny * d); return G.inAny([t], p.lat, p.lon); };
  assert.ok(inAt(900) && inAt(-900));
  assert.ok(!inAt(1010) && !inAt(-1010));
});

test('linkShapes: one octagon per member, a tube only where two linked octagons do not touch', () => {
  const far = offset(O, 20000, 0), near = offset(O, 5000, 0), lone = offset(O, 0, 30000);
  const items = [{ lat: O.lat, lon: O.lon, r: 4000 }, { lat: far.lat, lon: far.lon, r: 4000 },
    { lat: near.lat, lon: near.lon, r: 4000 }, { lat: lone.lat, lon: lone.lon, r: 4000 }];
  const polys = G.linkShapes(items, [[0, 1], [0, 2]], 700);
  assert.strictEqual(polys.length, 5, '4 octagons + 1 tube');
  assert.strictEqual(polys.filter((p) => p.length === 8).length >= 4, true);
  const mid = offset(O, 10000, 0);
  assert.ok(G.inAny(polys, mid.lat, mid.lon), 'the tube covers the midpoint of the far link');
  assert.strictEqual(G.linkShapes(items, [], 700).length, 4, 'no links, no tubes');
  assert.strictEqual(G.linkShapes(items, [[0, 3]], 700).length, 5, 'unlinked pairs get no tube, linked ones do');
});

test('linkShapes: a tube is never wider than the smaller octagon it joins', () => {
  const far = offset(O, 20000, 0);
  const polys = G.linkShapes([{ lat: O.lat, lon: O.lon, r: 500 }, { lat: far.lat, lon: far.lon, r: 4000 }], [[0, 1]], 3000);
  const p = offset(O, 10000, 600);
  assert.ok(!G.inAny(polys, p.lat, p.lon), '600 m off the line is outside a tube capped at 500 m');
});

test('linkShapes: the touch test uses the octagons\' flat sides, with each end\'s own radius', () => {
  const b = offset(O, 9000, 0);
  const it = (ra, rb) => [{ lat: O.lat, lon: O.lon, r: ra }, { lat: b.lat, lon: b.lon, r: rb }];
  assert.strictEqual(G.linkShapes(it(4000, 4000), [[0, 1]], 700).length, 3, '9 km apart, 2 x 3.7 km of flat side: tube');
  assert.strictEqual(G.linkShapes(it(4000, 6000), [[0, 1]], 700).length, 2, 'a 6 km octagon reaches: no tube');
});

test('outline: two octagons apart keep every edge, as two closed rings', () => {
  const a = oct(O, 4000), b = oct(offset(O, 20000, 0), 4000);
  const lines = G.outline([a, b]);
  assert.strictEqual(lines.length, 2);
  lines.forEach((l) => { assert.strictEqual(l.length, 9); assert.deepStrictEqual(plain(l[0]), plain(l[8])); });
  const perimeter = 2 * 8 * 2 * 4000 * Math.sin(Math.PI / 8);
  assert.ok(Math.abs(segLen(lines) - perimeter) < 1, 'whole perimeter');
});

test('outline: no part of it lies inside another shape', () => {
  const a = oct(O, 4000), b = oct(offset(O, 5000, 1000), 4000), t = G.tube(O, offset(O, 20000, 3000), 700);
  const polys = [a, b, t];
  const lines = G.outline(polys);
  assert.ok(lines.length >= 2);
  let checked = 0;
  lines.forEach((l) => {
    for (let i = 1; i < l.length; i++) {
      const mid = [(l[i - 1][0] + l[i][0]) / 2, (l[i - 1][1] + l[i][1]) / 2];
      // 5 m either side of the piece: exactly one side is inside the union.
      const p = local(l[i - 1]), q = local(l[i]), len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 20) continue;
      const nx = -(q[1] - p[1]) / len * 5, ny = (q[0] - p[0]) / len * 5;
      const m = { lat: mid[0], lon: mid[1] };
      const l1 = offset(m, nx, ny), l2 = offset(m, -nx, -ny);
      assert.notStrictEqual(G.inAny(polys, l1.lat, l1.lon), G.inAny(polys, l2.lat, l2.lon), 'piece ' + i + ' is on the union\'s edge');
      checked++;
    }
  });
  assert.ok(checked > 10);
  const whole = segLen(G.outline([a])) + segLen(G.outline([b])) + segLen(G.outline([t]));
  assert.ok(segLen(lines) < whole - 5000, 'the hidden parts are gone');
});

test('outline: a shape wholly inside another adds nothing; identical shapes do not vanish', () => {
  const big = oct(O, 6000), small = oct(offset(O, 500, 500), 1000);
  assert.ok(Math.abs(segLen(G.outline([big, small])) - segLen(G.outline([big]))) < 1);
  const twice = G.outline([oct(O, 4000), oct(O, 4000)]);
  assert.ok(segLen(twice) >= segLen(G.outline([oct(O, 4000)])) - 1, 'co-located repeaters keep their outline');
  assert.deepStrictEqual(plain(G.outline([])), []);
});

test('inAny tests each shape on its own (overlaps stay inside) and ringsBounds boxes them', () => {
  const a = oct(O, 4000), b = oct(offset(O, 3000, 0), 4000);
  const lens = offset(O, 1500, 0), out = offset(O, 0, 9000);
  const boxes = [a, b].map((r) => G.ringsBounds([r]));
  assert.ok(G.inAny([a, b], lens.lat, lens.lon, boxes), 'in both: still inside');
  assert.ok(G.inAny([a, b], lens.lat, lens.lon));
  assert.ok(!G.inAny([a, b], out.lat, out.lon, boxes));
  const box = plain(G.ringsBounds([a, b]));
  assert.ok(box[0] < O.lat && box[2] > O.lat && box[1] < O.lon && box[3] > b[0][1] - 0.1);
});

test('2,000 shapes in a row are outlined in well under 100 ms', () => {
  const polys = [];
  for (let i = 0; i < 2000; i++) polys.push(oct(offset(O, i * 3000, (i % 7) * 900), 4000));
  G.outline(polys);
  const t0 = process.hrtime.bigint();
  const lines = G.outline(polys);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`     outline of 2,000 overlapping octagons: ${ms.toFixed(1)} ms, ${lines.length} lines`);
  assert.ok(lines.length > 0);
  assert.ok(ms < 100, ms.toFixed(1) + ' ms');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
