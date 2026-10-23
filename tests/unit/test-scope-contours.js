'use strict';
// Unit tests for scope-contours.js: the region-scope reach overlay on the map
// and live pages. Loads the browser IIFE in a vm sandbox, the same way
// test-map-estimated.js does, and drives the overlay with a recording Leaflet
// stub and a fake clock.
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

const escSrc = fs.readFileSync(path.join(REPO_ROOT, 'public', 'app.js'), 'utf8').match(/function escapeHtml\(s\) \{[\s\S]*?\n\}/);
assert.ok(escSrc, 'escapeHtml not found in app.js');
const sandbox = { window: {}, setTimeout, clearTimeout, URLSearchParams, escapeHtml: vm.runInNewContext('(' + escSrc[0].replace(/^function escapeHtml/, 'function') + ')') };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'public', 'scope-contours.js'), 'utf8'), sandbox);
const SC = sandbox.window.ScopeContours;

// Metres between two lat/lon pairs (haversine), independent of the module's
// own projection so the radius checks are not the module grading itself.
function metres(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Offset a point by metres east/north.
function offset(lat, lon, eastM, northM) {
  return { lat: lat + northM / 111320, lon: lon + eastM / (111320 * Math.cos(lat * Math.PI / 180)) };
}

console.log('\n=== scope-contours.js: contour geometry ===');

test('exposes its API', () => {
  assert.ok(SC, 'window.ScopeContours not defined');
  for (const fn of ['normRegion', 'nodeRegionEvidence', 'groupNodesByScope', 'contourRings', 'colorIndex', 'createPulser', 'createOverlay']) {
    assert.strictEqual(typeof SC[fn], 'function', fn + ' not exported');
  }
});

test('no points, or no usable radius, gives no rings', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(SC.contourRings([], 8000))), []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(SC.contourRings([{ lat: 40.7, lon: -74 }], 0))), []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(SC.contourRings([{ lat: NaN, lon: -74 }, { lat: 'x', lon: 3 }, null], 8000))), []);
});

test('one point gives one ring at the radius, within 5%', () => {
  const c = [40.7, -74.0];
  const rings = SC.contourRings([{ lat: c[0], lon: c[1] }], 8000);
  assert.strictEqual(rings.length, 1);
  assert.ok(rings[0].length >= 16, 'ring too coarse: ' + rings[0].length + ' points');
  for (const p of rings[0]) {
    const d = metres(c, p);
    assert.ok(Math.abs(d - 8000) <= 400, 'ring point ' + Math.round(d) + ' m from the node');
  }
});

test('two far-apart points give two rings', () => {
  const a = offset(40.7, -74.0, 0, 0), b = offset(40.7, -74.0, 100000, 0);
  assert.strictEqual(SC.contourRings([a, b], 8000).length, 2);
});

test('two close points merge into one ring', () => {
  const a = offset(40.7, -74.0, 0, 0), b = offset(40.7, -74.0, 5000, 0);
  const rings = SC.contourRings([a, b], 8000);
  assert.strictEqual(rings.length, 1);
  // The merged outline reaches past both nodes.
  const lons = rings[0].map(p => p[1]);
  assert.ok(Math.min(...lons) < a.lon && Math.max(...lons) > b.lon);
});

// A ring of nodes around an empty middle: the reach is an annulus, so the
// outline has an outer ring and a hole. Leaflet fills with evenodd, so both
// rings in one polygon draw the hole.
test('nodes around an empty middle give an outer ring and a hole', () => {
  const pts = [];
  for (let k = 0; k < 24; k++) {
    const t = (k / 24) * 2 * Math.PI;
    pts.push(offset(40.7, -74.0, 40000 * Math.cos(t), 40000 * Math.sin(t)));
  }
  assert.strictEqual(SC.contourRings(pts, 8000).length, 2);
});

// Nodes on two continents must not make one grid spanning the ocean: each
// cluster is gridded on its own, so both still come out round.
test('distant clusters keep full resolution', () => {
  const nyc = { lat: 40.7, lon: -74.0 }, ams = { lat: 52.37, lon: 4.9 };
  const rings = SC.contourRings([nyc, ams], 8000);
  assert.strictEqual(rings.length, 2);
  for (const r of rings) {
    const c = metres([nyc.lat, nyc.lon], r[0]) < 100000 ? nyc : ams;
    for (const p of r) assert.ok(Math.abs(metres([c.lat, c.lon], p) - 8000) <= 400);
  }
});

console.log('\n=== scope-contours.js: membership ===');

// Spellings as they arrive: transported_scopes keeps the '#', declared_regions
// has it stripped by the server (same fixtures as test-issue-1862).
const OBS = { public_key: 'aa', lat: 40.70, lon: -74.00, transported_scopes: ['#nyc', '#ny'] };
const BOTH = { public_key: 'bb', lat: 40.75, lon: -73.95, declared_regions: ['nyc'], transported_scopes: ['#nyc'] };
const DECL = { public_key: 'cc', lat: 40.80, lon: -73.90, declared_regions: ['nyc', 'li'] };
const UNPLACED = { public_key: 'dd', transported_scopes: ['#nyc'] };
const ZERO = { public_key: 'ee', lat: 0, lon: 0, transported_scopes: ['#nyc'] };
const NONE = { public_key: 'ff', lat: 40.7, lon: -74.1 };

test('normRegion strips one leading #', () => {
  assert.strictEqual(SC.normRegion('#nyc'), 'nyc');
  assert.strictEqual(SC.normRegion('nyc'), 'nyc');
  assert.strictEqual(SC.normRegion('##x'), '#x');
  assert.strictEqual(SC.normRegion(null), '');
});

test('nodeRegionEvidence reports declared and observed separately', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(SC.nodeRegionEvidence(BOTH, '#nyc'))), { declared: true, observed: true });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(SC.nodeRegionEvidence(DECL, 'li'))), { declared: true, observed: false });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(SC.nodeRegionEvidence(OBS, 'li'))), { declared: false, observed: false });
});

test('groups by scope: observed wins, declared-only kept apart, unplaced dropped', () => {
  const g = SC.groupNodesByScope([OBS, BOTH, DECL, UNPLACED, ZERO, NONE, null]);
  // Arrays built in the vm realm: compare plain copies.
  const keys = g2 => JSON.parse(JSON.stringify(g2.map(n => n.public_key)));
  assert.deepStrictEqual(Array.from(g.keys()).sort(), ['li', 'ny', 'nyc']);
  assert.deepStrictEqual(keys(g.get('nyc').observed), ['aa', 'bb']);
  assert.deepStrictEqual(keys(g.get('nyc').declaredOnly), ['cc']);
  assert.deepStrictEqual(keys(g.get('li').observed), []);
  assert.deepStrictEqual(keys(g.get('li').declaredOnly), ['cc']);
});

test('a node listing a scope twice counts once', () => {
  const g = SC.groupNodesByScope([{ public_key: 'x', lat: 1, lon: 1, transported_scopes: ['#a', 'a'], declared_regions: ['a', 'a'] }]);
  assert.strictEqual(g.get('a').observed.length, 1);
  assert.strictEqual(g.get('a').declaredOnly.length, 0);
});

test('colorIndex is stable and in 1..8', () => {
  for (const s of ['nyc', 'li', 'be', 'be-bru', '', 'a-very-long-region-name']) {
    const i = SC.colorIndex(s);
    assert.ok(i >= 1 && i <= 8, s + ' → ' + i);
    assert.strictEqual(SC.colorIndex(s), i);
    assert.strictEqual(SC.colorIndex('#' + s), i, '# spelling must not change the colour');
  }
});

console.log('\n=== scope-contours.js: deep link ===');

test('hashFlag reads ?contours=, null when absent', () => {
  assert.strictEqual(SC.hashFlag('#/map?contours=1'), true);
  assert.strictEqual(SC.hashFlag('#/live?lat=1&contours=0&zoom=3'), false);
  assert.strictEqual(SC.hashFlag('#/map?lat=1'), null);
  assert.strictEqual(SC.hashFlag('#/map'), null);
  assert.strictEqual(SC.hashFlag(''), null);
  assert.strictEqual(SC.hashFlag('#/map?contours=yes'), null);
});

test('writeHashFlag sets and clears the param, keeping the others, without history', () => {
  const us = { window: {}, location: { hash: '#/map?lat=40.7&zoom=9' }, URLSearchParams };
  const calls = [];
  us.history = { replaceState: (s, t, h) => { calls.push(h); us.location.hash = h; } };
  vm.createContext(us);
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'public', 'url-state.js'), 'utf8'), us);
  us.window.URLState = us.window.URLState || us.URLState;
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'public', 'scope-contours.js'), 'utf8'), us);
  const S = us.window.ScopeContours;
  S.writeHashFlag(true);
  assert.strictEqual(S.hashFlag(us.location.hash), true);
  assert.ok(/lat=40\.7/.test(us.location.hash) && /zoom=9/.test(us.location.hash), us.location.hash);
  S.writeHashFlag(true);
  assert.strictEqual(calls.length, 1, 'no rewrite when nothing changes');
  S.writeHashFlag(false);
  assert.strictEqual(S.hashFlag(us.location.hash), null, us.location.hash);
});

console.log('\n=== scope-contours.js: pulse coalescing ===');

function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of Array.from(timers)) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    pending() { return timers.size; },
  };
}

test('a burst of packets for one scope starts one pulse and extends it', () => {
  const clock = fakeClock();
  const log = [];
  const p = SC.createPulser({ durationMs: 1500, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onStart: s => log.push('start:' + s), onEnd: s => log.push('end:' + s) });
  p.pulse('#nyc'); p.pulse('nyc'); clock.advance(1000); p.pulse('nyc');
  assert.deepStrictEqual(log, ['start:nyc']);
  assert.strictEqual(clock.pending(), 1, 'one timer per scope');
  clock.advance(1000);
  assert.deepStrictEqual(log, ['start:nyc'], 'the last packet extended the pulse');
  clock.advance(600);
  assert.deepStrictEqual(log, ['start:nyc', 'end:nyc']);
  assert.strictEqual(p.isActive('nyc'), false);
});

test('scopes pulse independently; empty names are ignored; cancelAll ends all', () => {
  const clock = fakeClock();
  const log = [];
  const p = SC.createPulser({ durationMs: 1500, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onStart: s => log.push('start:' + s), onEnd: s => log.push('end:' + s) });
  p.pulse('a'); p.pulse('b'); p.pulse(''); p.pulse(null); p.pulse('#');
  assert.deepStrictEqual(log, ['start:a', 'start:b']);
  p.cancelAll();
  assert.deepStrictEqual(log, ['start:a', 'start:b', 'end:a', 'end:b']);
  assert.strictEqual(clock.pending(), 0);
});

console.log('\n=== scope-contours.js: overlay ===');

// Recording Leaflet stub: enough of L for createOverlay.
function fakeLeaflet() {
  const rec = { polygons: [], panes: {}, renderers: 0 };
  function classList() {
    const s = new Set();
    return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) };
  }
  const L = {
    svg(opts) { rec.renderers++; return { _svg: true, options: opts }; },
    layerGroup() {
      const layers = new Set();
      return {
        _layers: layers, _onMap: false,
        addLayer(l) { layers.add(l); return this; },
        clearLayers() { layers.clear(); return this; },
        addTo() { this._onMap = true; return this; },
        remove() { this._onMap = false; return this; },
      };
    },
    polygon(rings, opts) {
      const el = { classList: classList() };
      const p = { rings, options: opts, tooltip: null, getElement: () => el,
        bindTooltip(t, o) { this.tooltip = t; this.tooltipOpts = o; return this; } };
      rec.polygons.push(p);
      return p;
    },
  };
  const map = {
    createPane(name) { const pane = { style: {} }; rec.panes[name] = pane; return pane; },
    getPane(name) { return rec.panes[name]; },
    hasLayer(l) { return !!l._onMap; },
    removeLayer(l) { l._onMap = false; return this; },
  };
  return { L, map, rec };
}

const NODES = [
  { public_key: 'a1', lat: 40.70, lon: -74.00, transported_scopes: ['#nyc'] },
  { public_key: 'a2', lat: 40.72, lon: -73.98, transported_scopes: ['#nyc'] },
  { public_key: 'a3', lat: 40.90, lon: -73.50, declared_regions: ['nyc', 'li'] },
  { public_key: 'a4', lat: 41.30, lon: -72.90, transported_scopes: ['#ct<script>'] },
];

test('hidden overlay computes nothing', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes(NODES);
  assert.strictEqual(o.stats().computed, 0);
  assert.strictEqual(rec.polygons.length, 0);
});

test('visible overlay draws observed solid and declared-only dashed, in its own SVG pane', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes(NODES);
  o.setVisible(true);
  assert.ok(rec.panes.mcScopeContoursPane, 'pane created');
  assert.ok(Number(rec.panes.mcScopeContoursPane.style.zIndex) < 600, 'pane sits under the marker pane');
  assert.strictEqual(rec.renderers, 1, 'one SVG renderer, so CSS classes apply on canvas maps');
  const cls = rec.polygons.map(p => p.options.className);
  const nycObs = rec.polygons.find(p => /mc-scope-area-observed/.test(p.options.className) && /nyc/.test(p.tooltip));
  const nycDecl = rec.polygons.find(p => /mc-scope-area-declared/.test(p.options.className) && /nyc/.test(p.tooltip));
  assert.ok(nycObs, 'no observed #nyc polygon: ' + cls.join(' | '));
  assert.ok(nycDecl, 'no declared-only #nyc polygon');
  assert.ok(/2 nodes/.test(nycObs.tooltip), nycObs.tooltip);
  assert.ok(/1 node\b/.test(nycDecl.tooltip), nycDecl.tooltip);
  assert.strictEqual(nycObs.options.pane, 'mcScopeContoursPane');
  assert.ok(nycObs.options.renderer && nycObs.options.renderer._svg);
  assert.ok(new RegExp('mc-reach-c' + SC.colorIndex('nyc') + '\\b').test(nycObs.options.className));
  // li has only a declared-only node, so only a dashed outline.
  assert.ok(rec.polygons.some(p => /mc-scope-area-declared/.test(p.options.className) && /#li\b/.test(p.tooltip)));
  assert.ok(!rec.polygons.some(p => /mc-scope-area-observed/.test(p.options.className) && /#li\b/.test(p.tooltip)));
});

test('tooltips escape scope names', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes(NODES); o.setVisible(true);
  const ct = rec.polygons.find(p => /ct/.test(p.tooltip));
  assert.ok(ct && ct.tooltip.includes('&lt;script&gt;') && !ct.tooltip.includes('<script>'), ct && ct.tooltip);
});

test('setOnly narrows to one scope, regardless of # spelling', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes(NODES); o.setVisible(true);
  rec.polygons.length = 0;
  o.setOnly('#li');
  assert.ok(rec.polygons.length > 0);
  assert.ok(rec.polygons.every(p => /#li\b/.test(p.tooltip)), rec.polygons.map(p => p.tooltip).join(' | '));
  rec.polygons.length = 0;
  o.setOnly('');
  assert.ok(rec.polygons.some(p => /#nyc\b/.test(p.tooltip)));
});

test('unchanged membership reuses the cached contours; a moved node recomputes only its scope', () => {
  const { L, map } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setVisible(true);
  o.setNodes(NODES);
  const first = o.stats().computed;
  assert.ok(first >= 4, 'computed ' + first);
  o.setNodes(NODES.map(n => Object.assign({}, n)));
  assert.strictEqual(o.stats().computed, first, 'same members and positions: cache hit');
  const moved = NODES.map(n => n.public_key === 'a4' ? Object.assign({}, n, { lat: 41.4 }) : n);
  o.setNodes(moved);
  assert.strictEqual(o.stats().computed, first + 1, 'only the moved node\'s scope recomputed');
});

test('the cache drops scopes that disappear', () => {
  const { L, map } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setVisible(true);
  o.setNodes(NODES);
  assert.ok(o.stats().cached >= 4);
  o.setNodes([NODES[0]]);
  assert.strictEqual(o.stats().cached, 1);
});

test('setVisible(false) takes the layer off the map', () => {
  const { L, map } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes(NODES); o.setVisible(true);
  assert.strictEqual(map.hasLayer(o.layer), true);
  o.setVisible(false);
  assert.strictEqual(map.hasLayer(o.layer), false);
});

test('pulse marks the scope\'s drawn polygons and clears them after the duration', () => {
  const clock = fakeClock();
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, { pulseMs: 1500, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  o.setNodes(NODES); o.setVisible(true);
  o.pulse('#nyc');
  const nyc = rec.polygons.filter(p => /#nyc\b/.test(p.tooltip));
  const other = rec.polygons.filter(p => !/#nyc\b/.test(p.tooltip));
  assert.ok(nyc.length && nyc.every(p => p.getElement().classList.contains('is-pulsing')));
  assert.ok(other.every(p => !p.getElement().classList.contains('is-pulsing')));
  clock.advance(1600);
  assert.ok(nyc.every(p => !p.getElement().classList.contains('is-pulsing')));
});

test('pulse is a no-op while hidden, and destroy cancels pending pulses', () => {
  const clock = fakeClock();
  const { L, map } = fakeLeaflet();
  const o = SC.createOverlay(L, map, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  o.setNodes(NODES);
  o.pulse('nyc');
  assert.strictEqual(clock.pending(), 0);
  o.setVisible(true);
  o.pulse('nyc');
  assert.strictEqual(clock.pending(), 1);
  o.destroy();
  assert.strictEqual(clock.pending(), 0);
});

console.log('\n=== scope-contours.js: performance ===');

// Deterministic PRNG so the timing is of the same work every run.
function prng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

// Timed against the module loaded in the main realm: inside a vm context
// every global lookup (Math, Float64Array) goes through the sandbox's
// property interceptor, which a browser does not have, and that roughly
// doubles the time. Same file, same code; only the realm differs.
const SCmain = (() => {
  const win = {};
  new Function('window', 'escapeHtml', fs.readFileSync(path.join(REPO_ROOT, 'public', 'scope-contours.js'), 'utf8'))(win, sandbox.escapeHtml);
  return win.ScopeContours;
})();

test('2,000 nodes across 32 scopes compute in under 50 ms', () => {
  const rnd = prng(42);
  const nodes = [];
  for (let i = 0; i < 2000; i++) {
    const p = offset(40.7, -74.0, (rnd() - 0.5) * 200000, (rnd() - 0.5) * 200000);
    const s1 = '#s' + Math.floor(rnd() * 32), s2 = 's' + Math.floor(rnd() * 32);
    nodes.push({ public_key: 'k' + i, lat: p.lat, lon: p.lon, transported_scopes: [s1], declared_regions: [s2] });
  }
  const { L, map } = fakeLeaflet();
  // Warm-up run on a separate overlay so JIT compilation is not timed.
  const warm = SCmain.createOverlay(L, map, {}); warm.setVisible(true); warm.setNodes(nodes);
  const o = SCmain.createOverlay(L, map, {});
  o.setVisible(true);
  const t0 = process.hrtime.bigint();
  o.setNodes(nodes);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('     (' + ms.toFixed(1) + ' ms for ' + o.stats().computed + ' contours)');
  assert.ok(o.stats().computed >= 32);
  assert.ok(ms < 50, ms.toFixed(1) + ' ms');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
