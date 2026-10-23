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
const pending = [];
function test(name, fn) {
  const ok = () => { passed++; console.log(`  ✅ ${name}`); };
  const bad = (e) => { failed++; console.log(`  ❌ ${name}: ${e.message}`); };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(ok, bad)); else ok();
  } catch (e) { bad(e); }
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

test('groups by scope: observed wins, configured-only kept apart, unplaced dropped', () => {
  const g = SC.groupNodesByScope([OBS, BOTH, DECL, UNPLACED, ZERO, NONE, null]);
  // Arrays built in the vm realm: compare plain copies.
  const keys = g2 => JSON.parse(JSON.stringify(g2.map(n => n.public_key)));
  assert.deepStrictEqual(Array.from(g.keys()).sort(), ['li', 'ny', 'nyc']);
  assert.deepStrictEqual(keys(g.get('nyc').observed), ['aa', 'bb']);
  assert.deepStrictEqual(keys(g.get('nyc').configuredOnly), ['cc']);
  assert.deepStrictEqual(keys(g.get('li').observed), []);
  assert.deepStrictEqual(keys(g.get('li').configuredOnly), ['cc']);
});

test('a node listing a scope twice counts once', () => {
  const g = SC.groupNodesByScope([{ public_key: 'x', lat: 1, lon: 1, transported_scopes: ['#a', 'a'], declared_regions: ['a', 'a'] }]);
  assert.strictEqual(g.get('a').observed.length, 1);
  assert.strictEqual(g.get('a').configuredOnly.length, 0);
});

test('configuredScopes reads default_scope, configured_scope and declared_regions, and says which', () => {
  const m = SC.configuredScopes({ default_scope: '#phl', configured_scope: '#phl, #us-pa,*,,us', declared_regions: ['us', 'nj'] });
  const plainMap = JSON.parse(JSON.stringify(Array.from(m)));
  assert.deepStrictEqual(plainMap, [
    ['phl', { default: true, allowed: true, declared: false }],
    ['us-pa', { default: false, allowed: true, declared: false }],
    ['us', { default: false, allowed: true, declared: true }],
    ['nj', { default: false, allowed: false, declared: true }],
  ]);
  assert.strictEqual(SC.configuredScopes({}).size, 0);
  assert.strictEqual(SC.configuredScopes(null).size, 0);
});

test('a node configured by default_scope or configured_scope draws dashed unless it carries the scope', () => {
  const g = SC.groupNodesByScope([
    { public_key: 'd1', lat: 1, lon: 1, default_scope: '#phl' },
    { public_key: 'd2', lat: 1, lon: 2, configured_scope: '#phl,#nj' },
    { public_key: 'd3', lat: 1, lon: 3, default_scope: '#phl', transported_scopes: ['#phl'] },
  ]);
  const keys = g2 => JSON.parse(JSON.stringify(g2.map(n => n.public_key)));
  assert.deepStrictEqual(keys(g.get('phl').configuredOnly), ['d1', 'd2']);
  assert.deepStrictEqual(keys(g.get('phl').observed), ['d3']);
  assert.deepStrictEqual(keys(g.get('nj').configuredOnly), ['d2']);
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

console.log('\n=== scope-contours.js: link-based reach ===');

// How far the outline reaches from a node toward a bearing, in metres: walk
// out along the ray until it leaves the outline.
function reachToward(rings, c, bearingDeg) {
  const t = bearingDeg * Math.PI / 180;
  let last = 0;
  for (let m = 0; m <= 60000; m += 50) {
    const q = offset(c.lat, c.lon, m * Math.sin(t), m * Math.cos(t));
    if (!SC.inRings(rings, q.lat, q.lon)) return last;
    last = m;
  }
  return last;
}

const HOME = { public_key: 'h0', lat: 40.0, lon: -75.3 };
const EAST = Object.assign({ public_key: 'e1' }, offset(40.0, -75.3, 20000, 0));
const NORTH = Object.assign({ public_key: 'n1' }, offset(40.0, -75.3, 0, 6000));
const FAR = Object.assign({ public_key: 'f1' }, offset(40.0, -75.3, -30000, 0));
const plain = (m) => JSON.parse(JSON.stringify(Array.from(m)));

test('a link sets the reach of both ends, in the sector it points to', () => {
  const ex = SC.linkExtents([HOME, EAST], [{ source: 'h0', target: 'e1', bidirectional: true }]);
  const h = plain(ex.get('h0')), e = plain(ex.get('e1'));
  const east = SC.sectors / 4, west = SC.sectors * 3 / 4;   // 90° and 270°
  assert.ok(Math.abs(h[east] - 22000) < 200, 'home east sector ' + h[east]);   // ×1.1 margin
  assert.ok(Math.abs(e[west] - 22000) < 200, 'east node west sector ' + e[west]);
  assert.strictEqual(h.filter(v => v > 0).length, 1, 'only one sector set: ' + h);
});

test('ambiguous links, self links and links to unplaced nodes are ignored', () => {
  const ex = SC.linkExtents([HOME, EAST, { public_key: 'u1' }], [
    { source: 'h0', target: 'e1', bidirectional: true, ambiguous: true },
    { source: 'h0', target: 'h0', bidirectional: true },
    { source: 'h0', target: 'u1', bidirectional: true },
    { source: 'h0', target: 'missing', bidirectional: true },
    null,
  ]);
  assert.strictEqual(ex.size, 0, 'extents for ' + Array.from(ex.keys()));
});

test('a one-way link proves nothing: only bidirectional links count', () => {
  const ex = SC.linkExtents([HOME, EAST], [{ source: 'h0', target: 'e1', bidirectional: false }, { source: 'e1', target: 'h0' }]);
  assert.strictEqual(ex.size, 0, 'extents for ' + Array.from(ex.keys()));
});

test('the farthest link in a sector wins', () => {
  const near = Object.assign({ public_key: 'e2' }, offset(40.0, -75.3, 5000, 0));
  const ex = SC.linkExtents([HOME, EAST, near], [{ source: 'h0', target: 'e2', bidirectional: true }, { source: 'e1', target: 'h0', bidirectional: true }]);
  assert.ok(Math.abs(plain(ex.get('h0'))[SC.sectors / 4] - 22000) < 200);
});

test('a node with no links is a floor circle', () => {
  const s = SC.shapeFor(HOME, new Map(), 1500);
  assert.strictEqual(s.uniform, true);
  assert.strictEqual(s.maxExt, 1500);
  const rings = SC.contourShapes([s]);
  assert.strictEqual(rings.length, 1);
  for (const p of rings[0]) assert.ok(Math.abs(metres([HOME.lat, HOME.lon], p) - 1500) <= 75, 'floor ring point at ' + metres([HOME.lat, HOME.lon], p));
});

test('the outline follows the links: a long lobe toward them, the floor elsewhere', () => {
  const ex = SC.linkExtents([HOME, EAST, NORTH], [{ source: 'h0', target: 'e1', bidirectional: true }, { source: 'h0', target: 'n1', bidirectional: true }]);
  const rings = SC.contourShapes([SC.shapeFor(HOME, ex, 1500)]);
  assert.strictEqual(rings.length, 1);
  const east = reachToward(rings, HOME, 90), north = reachToward(rings, HOME, 0), west = reachToward(rings, HOME, 270), south = reachToward(rings, HOME, 180);
  assert.ok(Math.abs(east - 22000) < 1500, 'east ' + Math.round(east));
  assert.ok(Math.abs(north - 6600) < 800, 'north ' + Math.round(north));
  assert.ok(Math.abs(west - 1500) < 300, 'west ' + Math.round(west));
  assert.ok(Math.abs(south - 1500) < 300, 'south ' + Math.round(south));
});

// 32 sectors of 11.25°: a lone link's lobe spreads half as far sideways as
// at 16. 10° off a 22 km link, a 16-sector shape still reached about 13 km.
test('a lobe is narrow and stays attached to its node', () => {
  const ex = SC.linkExtents([HOME, EAST], [{ source: 'h0', target: 'e1', bidirectional: true }]);
  const rings = SC.contourShapes([SC.shapeFor(HOME, ex, 1500)]);
  assert.strictEqual(rings.length, 1, 'the lobe came loose from the floor circle');
  const on = reachToward(rings, HOME, 90), off = reachToward(rings, HOME, 100), far = reachToward(rings, HOME, 115);
  assert.ok(on > 20000, 'on the link ' + on);
  assert.ok(off < 9000, '10° off the link ' + off);
  assert.ok(far < 2500, '25° off the link ' + far);
});

test('linked nodes sit inside the outline they extend', () => {
  const ex = SC.linkExtents([HOME, EAST, FAR], [{ source: 'h0', target: 'e1', bidirectional: true }, { source: 'h0', target: 'f1', bidirectional: true }]);
  const rings = SC.contourShapes([HOME, EAST, FAR].map(n => SC.shapeFor(n, ex, 1500)));
  for (const n of [HOME, EAST, FAR]) assert.ok(SC.inRings(rings, n.lat, n.lon), n.public_key + ' outside its own outline');
  assert.strictEqual(rings.length, 1, 'linked shapes merge into one outline');
});

test('inRings: even-odd, so a hole is outside', () => {
  const outer = [[0, 0], [0, 10], [10, 10], [10, 0]], hole = [[4, 4], [4, 6], [6, 6], [6, 4]];
  assert.strictEqual(SC.inRings([outer, hole], 2, 2), true);
  assert.strictEqual(SC.inRings([outer, hole], 5, 5), false);
  assert.strictEqual(SC.inRings([outer, hole], 20, 5), false);
});

console.log('\n=== scope-contours.js: overlay ===');

// Recording Leaflet stub: enough of L for createOverlay.
function fakeLeaflet() {
  const rec = { polygons: [], panes: {}, renderers: 0, tip: null, tipOpen: false, handlers: {} };
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
      };
    },
    polygon(rings, opts) {
      const el = { classList: classList() };
      const p = { rings, options: opts, getElement: () => el };
      rec.polygons.push(p);
      return p;
    },
    popup(opts) {
      rec.popup = { options: opts, _onMap: false, content: '', setLatLng(ll) { this.latlng = ll; return this; }, setContent(c) { this.content = c; return this; },
        openOn() { this._onMap = true; return this; } };
      return rec.popup;
    },
    tooltip(opts) {
      rec.tip = { options: opts, _onMap: false, content: '', setLatLng(ll) { this.latlng = ll; return this; }, setContent(c) { this.content = c; return this; } };
      return rec.tip;
    },
  };
  const map = {
    createPane(name) { const pane = { style: {} }; rec.panes[name] = pane; return pane; },
    getPane(name) { return rec.panes[name]; },
    hasLayer(l) { return !!l._onMap; },
    removeLayer(l) { l._onMap = false; return this; },
    openTooltip(t) { t._onMap = true; rec.tipOpen = true; return this; },
    closeTooltip(t) { t._onMap = false; rec.tipOpen = false; return this; },
    closePopup(p) { p._onMap = false; return this; },
    on(ev, fn) { (rec.handlers[ev] = rec.handlers[ev] || []).push(fn); },
    off(ev, fn) { rec.handlers[ev] = (rec.handlers[ev] || []).filter(f => f !== fn); },
    fire(ev, e) { (rec.handlers[ev] || []).forEach(f => f(e)); },
  };
  return { L, map, rec };
}
const sync = { raf: (fn) => fn() };
const ofKind = (rec, kind) => rec.polygons.filter(p => p.options.className.includes('mc-scope-area-' + kind));

const NODES = [
  { public_key: 'a1', lat: 40.70, lon: -74.00, transported_scopes: ['#nyc'] },
  { public_key: 'a2', lat: 40.72, lon: -73.98, transported_scopes: ['#nyc', '#ny'] },
  { public_key: 'a3', lat: 40.90, lon: -73.50, declared_regions: ['nyc', 'li'] },
  { public_key: 'a4', lat: 41.30, lon: -72.90, transported_scopes: ['#ct<script>'] },
];

test('hidden overlay computes nothing and fetches no links', () => {
  const { L, map, rec } = fakeLeaflet();
  let loads = 0;
  const o = SC.createOverlay(L, map, { loadLinks: () => { loads++; return []; } });
  o.setNodes(NODES);
  assert.strictEqual(o.stats().computed, 0);
  assert.strictEqual(rec.polygons.length, 0);
  assert.strictEqual(loads, 0);
});

test('visible overlay draws non-interactive solid and dashed outlines in its own SVG pane', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes(NODES);
  o.setVisible(true);
  assert.ok(rec.panes.mcScopeContoursPane, 'pane created');
  assert.ok(Number(rec.panes.mcScopeContoursPane.style.zIndex) < 600, 'pane sits under the marker pane');
  assert.strictEqual(rec.renderers, 1, 'one SVG renderer, so CSS classes apply on canvas maps');
  // observed: nyc, ny, ct; configured-only: nyc (a3), li (a3)
  assert.strictEqual(ofKind(rec, 'observed').length, 3);
  assert.strictEqual(ofKind(rec, 'configured').length, 2);
  for (const p of rec.polygons) {
    assert.strictEqual(p.options.interactive, false, 'outlines must never take pointer events');
    assert.strictEqual(p.options.pane, 'mcScopeContoursPane');
    assert.ok(p.options.renderer && p.options.renderer._svg);
  }
  assert.ok(rec.polygons.some(p => new RegExp('mc-reach-c' + SC.colorIndex('nyc') + '\\b').test(p.options.className)));
});

test('scopes() lists every scope with its counts, sorted, and onChange reports it', () => {
  const { L, map } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  const seen = [];
  o.onChange((list, visible) => seen.push([list.length, visible]));
  o.setNodes(NODES); o.setVisible(true);
  const list = JSON.parse(JSON.stringify(o.scopes()));
  assert.deepStrictEqual(list.map(s => s.scope), ['ct<script>', 'li', 'ny', 'nyc']);
  const nyc = list.find(s => s.scope === 'nyc');
  assert.strictEqual(nyc.observed, 2); assert.strictEqual(nyc.configured, 1); assert.strictEqual(nyc.hidden, false);
  assert.deepStrictEqual(seen[seen.length - 1], [4, true]);
});

test('links are loaded once shown, and change the shape', () => {
  const { L, map, rec } = fakeLeaflet();
  const nodes = [Object.assign({ transported_scopes: ['#home'] }, HOME), EAST];
  let loads = 0;
  let resolve;
  const o = SC.createOverlay(L, map, { loadLinks: () => { loads++; return new Promise(r => { resolve = r; }); } });
  o.setNodes(nodes);
  o.setVisible(true);
  assert.strictEqual(loads, 1);
  const before = ofKind(rec, 'observed').pop();
  assert.ok(reachToward(before.rings, HOME, 90) < 2000, 'floor circle before links arrive');
  resolve([{ source: 'h0', target: 'e1', bidirectional: true }]);
  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    const after = ofKind(rec, 'observed').pop();
    assert.ok(reachToward(after.rings, HOME, 90) > 18000, 'lobe after links arrive: ' + reachToward(after.rings, HOME, 90));
  });
});

test('setOnly narrows to one scope, regardless of # spelling', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes(NODES); o.setVisible(true);
  rec.polygons.length = 0;
  o.setOnly('#li');
  assert.strictEqual(rec.polygons.length, 1);
  assert.ok(rec.polygons[0].options.className.includes('mc-scope-area-configured'));
  o.setOnly('');
  assert.strictEqual(rec.polygons.length, 1 + 5);
});

test('setHidden leaves hidden scopes out of the map but in the list', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes(NODES); o.setVisible(true);
  rec.polygons.length = 0;
  o.setHidden(['#nyc', 'li']);
  assert.strictEqual(rec.polygons.length, 2, 'ny and ct left');
  const list = JSON.parse(JSON.stringify(o.scopes()));
  assert.deepStrictEqual(list.filter(s => s.hidden).map(s => s.scope), ['li', 'nyc']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(o.hidden())).sort(), ['li', 'nyc']);
});

test('unchanged members and links reuse the cache; a moved node recomputes only its scope', () => {
  const { L, map } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setVisible(true);
  o.setNodes(NODES);
  const first = o.stats().computed;
  assert.strictEqual(first, 5);
  o.setNodes(NODES.map(n => Object.assign({}, n)));
  assert.strictEqual(o.stats().computed, first, 'same members and positions: cache hit');
  o.setNodes(NODES.map(n => n.public_key === 'a4' ? Object.assign({}, n, { lat: 41.4 }) : n));
  assert.strictEqual(o.stats().computed, first + 1, 'only the moved node\'s scope recomputed');
});

test('a new link recomputes only the scopes whose members it touches', () => {
  const { L, map } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setVisible(true); o.setNodes(NODES); o.setLinks([]);
  const base = o.stats().computed;
  o.setLinks([{ source: 'a4', target: 'a3', bidirectional: true }]); // touches ct (a4 observed) and nyc/li configured (a3)
  assert.strictEqual(o.stats().computed, base + 3);
});

test('the cache drops scopes that disappear', () => {
  const { L, map } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setVisible(true);
  o.setNodes(NODES);
  assert.strictEqual(o.stats().cached, 5);
  o.setNodes([NODES[0]]);
  assert.strictEqual(o.stats().cached, 1);
});

test('setVisible(false) takes the layer off the map and empties the list', () => {
  const { L, map } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  const seen = [];
  o.onChange((list, visible) => seen.push([list.length, visible]));
  o.setNodes(NODES); o.setVisible(true);
  assert.strictEqual(map.hasLayer(o.layer), true);
  o.setVisible(false);
  assert.strictEqual(map.hasLayer(o.layer), false);
  assert.deepStrictEqual(seen[seen.length - 1], [0, false]);
});

console.log('\n=== scope-contours.js: hover ===');

test('hovering names every scope under the cursor, highlights them, and escapes names', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setNodes(NODES); o.setVisible(true);
  // a2 carries both #nyc and #ny: their outlines overlap there.
  map.fire('mousemove', { latlng: { lat: 40.72, lng: -73.98 } });
  assert.strictEqual(rec.tipOpen, true);
  assert.ok(/#nyc · carried by 2 nodes/.test(rec.tip.content), rec.tip.content);
  assert.ok(/#ny · carried by 1 node\b/.test(rec.tip.content), rec.tip.content);
  const lit = rec.polygons.filter(p => p.getElement().classList.contains('is-hovered'));
  assert.strictEqual(lit.length, 2);
  map.fire('mousemove', { latlng: { lat: 41.30, lng: -72.90 } });
  assert.ok(rec.tip.content.includes('#ct&lt;script&gt;') && !rec.tip.content.includes('<script>'), rec.tip.content);
  assert.strictEqual(rec.polygons.filter(p => p.getElement().classList.contains('is-hovered')).length, 1, 'previous highlight cleared');
});

test('moving off every outline, or off the map, closes the tooltip', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setNodes(NODES); o.setVisible(true);
  map.fire('mousemove', { latlng: { lat: 40.70, lng: -74.00 } });
  assert.strictEqual(rec.tipOpen, true);
  map.fire('mousemove', { latlng: { lat: 10, lng: 10 } });
  assert.strictEqual(rec.tipOpen, false);
  map.fire('mousemove', { latlng: { lat: 40.70, lng: -74.00 } });
  map.fire('mouseout', {});
  assert.strictEqual(rec.tipOpen, false);
  assert.strictEqual(rec.polygons.filter(p => p.getElement().classList.contains('is-hovered')).length, 0);
});

test('hidden scopes and a hidden overlay are not hovered', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setNodes(NODES); o.setVisible(true); o.setHidden(['ny']);
  map.fire('mousemove', { latlng: { lat: 40.72, lng: -73.98 } });
  assert.ok(!/#ny ·/.test(rec.tip.content), rec.tip.content);
  o.setVisible(false);
  map.fire('mousemove', { latlng: { lat: 40.72, lng: -73.98 } });
  assert.strictEqual(rec.tipOpen, false);
});

test('mousemoves are coalesced to one hit test per frame', () => {
  const { L, map, rec } = fakeLeaflet();
  const frames = [];
  const o = SC.createOverlay(L, map, { raf: fn => frames.push(fn) });
  o.setNodes(NODES); o.setVisible(true);
  for (let k = 0; k < 20; k++) map.fire('mousemove', { latlng: { lat: 40.70, lng: -74.00 } });
  assert.strictEqual(frames.length, 1);
  frames.shift()();
  assert.strictEqual(rec.tipOpen, true);
});

test('destroy drops the map listeners', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.destroy();
  assert.strictEqual((rec.handlers.mousemove || []).length, 0);
  assert.strictEqual((rec.handlers.mouseout || []).length, 0);
});

console.log('\n=== scope-contours.js: click popup ===');

const POP_NODES = [
  { public_key: 'p1', name: 'Treebeard', lat: 40.0, lon: -75.3, default_scope: '#phl', transported_scopes: ['#phl'] },
  { public_key: 'p2', name: 'Amon <b>Sul</b>', lat: 40.001, lon: -75.301, default_scope: '#phl' },
  { public_key: 'p3', name: 'Carrier', lat: 40.002, lon: -75.299, transported_scopes: ['#phl', '#philly'] },
  { public_key: 'p4', name: 'Nowhere', configured_scope: '#phl' },
  { public_key: 'p5', name: 'Other', lat: 41.0, lon: -74.0, default_scope: '#nj' },
];

test('clicking inside outlines lists each scope\'s repeaters with why they are there', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setNodes(POP_NODES); o.setVisible(true);
  map.fire('click', { latlng: { lat: 40.001, lng: -75.300 }, sourceTarget: map });
  assert.ok(rec.popup && rec.popup._onMap, 'popup not opened');
  const html = rec.popup.content;
  assert.ok(/#phl<\/strong> <span class="mc-scope-pop-sum">3 configured · 2 carrying/.test(html), html);
  assert.ok(/#philly<\/strong>/.test(html), 'overlapping #philly not listed');
  assert.ok(!/#nj/.test(html), 'a scope not under the click is listed');
  const phl = html.split('#philly')[0];
  // Configured first (by name), then carrying-only.
  const order = ['Amon', 'Nowhere', 'Treebeard', 'Carrier'].map(n => phl.indexOf(n));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), 'order ' + order);
  assert.ok(/Treebeard<\/a> <span class="mc-scope-tag"[^>]*>default<\/span><span class="mc-scope-tag"[^>]*>carrying<\/span>/.test(html), 'Treebeard tags');
  assert.ok(/Nowhere<\/a> <span class="mc-scope-tag"[^>]*>allowed<\/span><span class="mc-scope-tag"[^>]*>no position<\/span>/.test(html), 'unplaced node tags');
  assert.ok(html.includes('href="#/nodes/p1"'), 'node link');
  assert.ok(html.includes('Amon &lt;b&gt;Sul&lt;/b&gt;') && !html.includes('<b>Sul'), 'name not escaped');
});

test('a click on another layer, or outside every outline, opens nothing', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setNodes(POP_NODES); o.setVisible(true);
  map.fire('click', { latlng: { lat: 40.001, lng: -75.300 }, sourceTarget: { _isNodeMarker: true } });
  assert.ok(!rec.popup._onMap, 'opened for a click that belongs to a node');
  map.fire('click', { latlng: { lat: 10, lng: 10 }, sourceTarget: map });
  assert.ok(!rec.popup._onMap, 'opened outside the outlines');
});

test('the popup pauses hover, and hiding the overlay closes it', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setNodes(POP_NODES); o.setVisible(true);
  map.fire('click', { latlng: { lat: 40.001, lng: -75.300 } });
  assert.ok(rec.popup._onMap);
  map.fire('mousemove', { latlng: { lat: 40.001, lng: -75.300 } });
  assert.strictEqual(rec.tipOpen, false, 'hover tooltip over an open popup');
  o.setVisible(false);
  assert.ok(!rec.popup._onMap, 'popup left open on a hidden overlay');
});

// Regression: a click is a mousemove and then the click. The move queues a
// hover for the next frame; when that frame runs the popup is already open,
// and the tooltip must not be drawn over it.
test('a hover queued just before a click does not draw over the popup', () => {
  const { L, map, rec } = fakeLeaflet();
  const frames = [];
  const o = SC.createOverlay(L, map, { raf: fn => frames.push(fn) });
  o.setNodes(POP_NODES); o.setVisible(true);
  map.fire('mousemove', { latlng: { lat: 40.001, lng: -75.300 } });
  map.fire('click', { latlng: { lat: 40.001, lng: -75.300 }, sourceTarget: map });
  assert.ok(rec.popup._onMap);
  frames.forEach(fn => fn());
  assert.strictEqual(rec.tipOpen, false, 'tooltip drawn over the popup');
});

test('the popup lists at most 50 rows per scope, then says how many more', () => {
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ public_key: 'm' + i, name: 'R' + String(i).padStart(2, '0'), lat: 40.0, lon: -75.3 + i * 0.00001, default_scope: '#big' });
  const html = SC.scopePopupHtml(['big'], many);
  assert.strictEqual((html.match(/<li><a /g) || []).length, 50);
  assert.ok(html.includes('+10 more'), 'no overflow line');
});

test('pulse marks the scope\'s drawn polygons and clears them after the duration', () => {
  const clock = fakeClock();
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, { pulseMs: 1500, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  o.setNodes(NODES); o.setVisible(true);
  o.pulse('#ny');
  const pulsing = () => rec.polygons.filter(p => p.getElement().classList.contains('is-pulsing'));
  assert.strictEqual(pulsing().length, 1);
  clock.advance(1600);
  assert.strictEqual(pulsing().length, 0);
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

console.log('\n=== scope-contours.js: show/hide list ===');

function listSandbox(hash, stored) {
  const store = Object.assign({}, stored || {});
  const ctx = {
    window: {}, location: { hash }, URLSearchParams, setTimeout, clearTimeout, escapeHtml: sandbox.escapeHtml,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  };
  ctx.history = { replaceState: (s, t, h) => { ctx.location.hash = h; } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'public', 'url-state.js'), 'utf8'), ctx);
  ctx.window.URLState = ctx.window.URLState || ctx.URLState;
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'public', 'scope-contours.js'), 'utf8'), ctx);
  return { S: ctx.window.ScopeContours, ctx, store };
}
function fakeListEl() {
  const h = {};
  return { hidden: true, innerHTML: '', addEventListener(t, f) { h[t] = f; }, fire(t, target) { h[t]({ target }); } };
}
const checkbox = (scope, checked) => ({ checked, getAttribute: k => (k === 'data-scope' ? scope : null) });
const button = (attr) => ({ hasAttribute: k => k === attr });

test('the list shows a row per scope with its colour, escaped, only while visible', () => {
  const { S } = listSandbox('#/map');
  const { L, map } = fakeLeaflet();
  const o = S.createOverlay(L, map, {});
  const el = fakeListEl();
  S.mountScopeList(el, o, { titleHtml: '<h3>REGION SCOPES</h3>' });
  o.setNodes(NODES);
  assert.strictEqual(el.hidden, true, 'hidden while the overlay is off');
  o.setVisible(true);
  assert.strictEqual(el.hidden, false);
  assert.ok(el.innerHTML.startsWith('<h3>REGION SCOPES</h3>'));
  assert.strictEqual((el.innerHTML.match(/class="mc-scope-row"/g) || []).length, 4);
  assert.ok(el.innerHTML.includes('mc-reach-c' + SC.colorIndex('nyc')));
  assert.ok(el.innerHTML.includes('data-scope="ct&lt;script&gt;"') && !el.innerHTML.includes('<script>'), 'scope name not escaped');
  assert.ok(/mc-scope-swatch--configured[^>]*><\/span> #li/.test(el.innerHTML), 'configured-only swatch not dashed');
});

test('unchecking a row hides the scope, stores it, and writes it to the URL', () => {
  const { S, ctx, store } = listSandbox('#/live?contours=1');
  const { L, map, rec } = fakeLeaflet();
  const o = S.createOverlay(L, map, {});
  const el = fakeListEl();
  S.mountScopeList(el, o);
  o.setNodes(NODES); o.setVisible(true);
  el.fire('change', checkbox('nyc', false));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(o.hidden())), ['nyc']);
  assert.deepStrictEqual(JSON.parse(store['meshcore-scope-contours-hidden']), ['nyc']);
  assert.ok(/[?&]contoursHide=nyc\b/.test(ctx.location.hash) && /contours=1/.test(ctx.location.hash), ctx.location.hash);
  assert.ok(el.innerHTML.includes('data-scope="nyc">'), 'nyc row should now be unchecked');
  el.fire('change', checkbox('nyc', true));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(o.hidden())), []);
  assert.ok(!/contoursHide/.test(ctx.location.hash), ctx.location.hash);
});

test('None hides every scope, All shows them again', () => {
  const { S } = listSandbox('#/map');
  const { L, map, rec } = fakeLeaflet();
  const o = S.createOverlay(L, map, {});
  const el = fakeListEl();
  S.mountScopeList(el, o);
  o.setNodes(NODES); o.setVisible(true);
  rec.polygons.length = 0;
  el.fire('click', button('data-scope-none'));
  assert.strictEqual(rec.polygons.length, 0);
  assert.strictEqual(JSON.parse(JSON.stringify(o.hidden())).length, 4);
  el.fire('click', button('data-scope-all'));
  assert.strictEqual(rec.polygons.length, 5);
});

test('hidden scopes come from the URL first, then the stored choice', () => {
  const a = listSandbox('#/map?contoursHide=li,%23ny', { 'meshcore-scope-contours-hidden': '["nyc"]' });
  const f1 = fakeLeaflet();
  const o1 = a.S.createOverlay(f1.L, f1.map, {});
  a.S.mountScopeList(fakeListEl(), o1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(o1.hidden())).sort(), ['li', 'ny']);
  const b = listSandbox('#/map', { 'meshcore-scope-contours-hidden': '["nyc"]' });
  const f2 = fakeLeaflet();
  const o2 = b.S.createOverlay(f2.L, f2.map, {});
  b.S.mountScopeList(fakeListEl(), o2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(o2.hidden())), ['nyc']);
  const c = listSandbox('#/map', { 'meshcore-scope-contours-hidden': 'not json' });
  const f3 = fakeLeaflet();
  const o3 = c.S.createOverlay(f3.L, f3.map, {});
  c.S.mountScopeList(fakeListEl(), o3);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(o3.hidden())), []);
});

test('hiddenFromHash parses the list, null when absent', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(SC.hiddenFromHash('#/map?contoursHide=a,%23b,,c'))), ['a', 'b', 'c']);
  assert.strictEqual(SC.hiddenFromHash('#/map?contours=1'), null);
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

test('2,000 nodes with 2,800 mesh-shaped links across 32 scopes: median rebuild within budget', () => {
  const rnd = prng(42);
  const nodes = [];
  for (let i = 0; i < 2000; i++) {
    const p = offset(40.7, -74.0, (rnd() - 0.5) * 200000, (rnd() - 0.5) * 200000);
    const s1 = '#s' + Math.floor(rnd() * 32), s2 = 's' + Math.floor(rnd() * 32);
    nodes.push({ public_key: 'k' + i, lat: p.lat, lon: p.lon, transported_scopes: [s1], declared_regions: [s2] });
  }
  // Links shaped like a real mesh (measured on a 104-node instance: 1.41
  // links per placed node, median 4.5 km, p90 16 km, max 36 km): each link
  // goes from a node to a point at a log-normal distance in a random
  // direction, ending on a node placed there.
  const edges = [];
  for (let i = 0; i < 2800; i++) {
    const a = nodes[Math.floor(rnd() * 2000)];
    const u = Math.max(1e-6, rnd()), v = rnd();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const km = Math.min(40, 4.5 * Math.exp(0.98 * z));
    const t = rnd() * 2 * Math.PI;
    const q = offset(a.lat, a.lon, km * 1000 * Math.sin(t), km * 1000 * Math.cos(t));
    const b = { public_key: 'x' + i, lat: q.lat, lon: q.lon };
    nodes.push(b);
    edges.push({ source: a.public_key, target: b.public_key, bidirectional: true });
  }
  const { L, map } = fakeLeaflet();
  // Same shape as test-hop-path-inference.js: let the JIT settle, then the
  // median of 5 full rebuilds (a fresh overlay each, so nothing is cached).
  for (let w = 0; w < 2; w++) { const warm = SCmain.createOverlay(L, map, {}); warm.setVisible(true); warm.setLinks(edges); warm.setNodes(nodes); }
  const times = [];
  let o = null;
  for (let r = 0; r < 5; r++) {
    o = SCmain.createOverlay(L, map, {});
    o.setVisible(true);
    o.setLinks(edges);
    const t0 = process.hrtime.bigint();
    o.setNodes(nodes);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const median = times[2];
  const t1 = process.hrtime.bigint();
  o.setNodes(nodes.slice());
  const cachedMs = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log('     (median ' + median.toFixed(1) + ' ms over 5 runs (target 100 ms) for ' + o.stats().computed + ' contours over ' + edges.length + ' links; cached rebuild ' + cachedMs.toFixed(1) + ' ms)');
  assert.ok(o.stats().computed >= 32);
  // Headroom over the target for slower CI runners.
  assert.ok(median < 200, 'median ' + median.toFixed(1) + ' ms');
});

test('a hover hit test over 64 outlines takes under 1 ms', () => {
  const rnd = prng(7);
  const nodes = [];
  for (let i = 0; i < 2000; i++) {
    const p = offset(40.7, -74.0, (rnd() - 0.5) * 200000, (rnd() - 0.5) * 200000);
    nodes.push({ public_key: 'k' + i, lat: p.lat, lon: p.lon, transported_scopes: ['#s' + Math.floor(rnd() * 32)], declared_regions: ['s' + Math.floor(rnd() * 32)] });
  }
  const { L, map } = fakeLeaflet();
  const o = SCmain.createOverlay(L, map, { raf: fn => fn() });
  o.setVisible(true); o.setNodes(nodes);
  const N = 200;
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < N; k++) map.fire('mousemove', { latlng: { lat: 40.7 + (k % 20) * 0.01, lng: -74.0 + (k % 7) * 0.01 } });
  const per = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log('     (' + per.toFixed(3) + ' ms per hit test)');
  assert.ok(per < 1, per.toFixed(3) + ' ms');
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
