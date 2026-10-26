'use strict';
// Unit tests for scope-geometry.js on its own: the geometry the region
// contours draw with, loaded without scope-contours.js, so it is proven to
// stand alone. Reach shapes are built by hand here. The fuller geometry
// cases (lobes, notches, the 15 km gap) run through the overlay's own
// suite, test-scope-contours.js.
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
function offset(lat, lon, eastM, northM) {
  return { lat: lat + northM / 111320, lon: lon + eastM / (111320 * Math.cos(lat * Math.PI / 180)) };
}
function metres(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// A reach shape as scope-contours.js shapeFor makes one: a plain circle.
function circle(p, R) {
  const ext = new Float64Array(G.sectors).fill(R);
  return { lat: p.lat, lon: p.lon, ext, maxExt: R, minExt: R, uniform: true };
}
const plain = (r) => JSON.parse(JSON.stringify(r));

console.log('\n=== scope-geometry.js ===');

test('loads on its own and exposes its API', () => {
  assert.ok(G, 'window.ScopeGeometry not defined');
  for (const fn of ['reachAt', 'shapeEdge', 'hullOfEdges', 'convexHull', 'scopeHull', 'roundOut', 'contourShapes', 'wrapShapes', 'ringsBounds', 'inRings']) {
    assert.strictEqual(typeof G[fn], 'function', fn + ' not exported');
  }
  assert.strictEqual(G.sectors, 72);
  assert.ok(Math.abs(G.sectorRad - 2 * Math.PI / 72) < 1e-12);
  assert.strictEqual(G.wrapGapM, 15000);
});

test('reachAt interpolates between the two nearest sectors', () => {
  const ext = new Float64Array(72).fill(1000);
  ext[0] = 2000;
  const s = { lat: 0, lon: 0, ext, maxExt: 2000, minExt: 1000, uniform: false };
  assert.strictEqual(G.reachAt(s, 0), 2000);
  assert.ok(Math.abs(G.reachAt(s, G.sectorRad / 2) - 1500) < 1e-9);
  assert.strictEqual(G.reachAt(circle(O, 700), 1.234), 700);
});

test('convexHull keeps the corners only', () => {
  const ring = plain(G.convexHull([[0, 0], [0, 1], [1, 1], [1, 0], [0.5, 0.5], [0, 0.5]]));
  assert.strictEqual(ring.length, 4);
  assert.deepStrictEqual(ring.map(p => p.join(',')).sort(), ['0,0', '0,1', '1,0', '1,1']);
});

test('scopeHull of one circle, grown by a margin, is a circle that much wider', () => {
  const rings = G.scopeHull([circle(O, 3000)], 2000);
  assert.strictEqual(rings.length, 1);
  rings[0].forEach(p => {
    const d = metres([O.lat, O.lon], p);
    assert.ok(Math.abs(d - 5000) < 5000 * 0.004, 'vertex at ' + d.toFixed(0) + ' m');
  });
});

test('wrapShapes joins circles closer than the gap and leaves farther ones apart', () => {
  const near = [circle(O, 1000), circle(offset(O.lat, O.lon, 8000, 0), 1000)];
  assert.strictEqual(G.wrapShapes(near, 15000).length, 1, 'two circles 8 km apart should be one area');
  const far = [circle(O, 1000), circle(offset(O.lat, O.lon, 40000, 0), 1000)];
  assert.strictEqual(G.wrapShapes(far, 15000).length, 2, 'two circles 40 km apart should stay apart');
  assert.strictEqual(G.wrapShapes([], 15000).length, 0);
});

test('inRings is even-odd (a hole is outside) and ringsBounds boxes the rings', () => {
  const outer = [[0, 0], [0, 10], [10, 10], [10, 0]];
  const hole = [[4, 4], [4, 6], [6, 6], [6, 4]];
  assert.strictEqual(G.inRings([outer, hole], 2, 2), true);
  assert.strictEqual(G.inRings([outer, hole], 5, 5), false);
  assert.strictEqual(G.inRings([outer, hole], 12, 5), false);
  assert.deepStrictEqual(plain(G.ringsBounds([outer, hole])), [0, 0, 10, 10]);
  const boxes = [outer, hole].map(r => G.ringsBounds([r]));
  assert.strictEqual(G.inRings([outer, hole], 2, 2, boxes), true, 'the boxes change no answer');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
