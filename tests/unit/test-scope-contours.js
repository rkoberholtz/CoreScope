'use strict';
// Unit tests for scope-contours.js: the region-scope reach overlay on the map.
// Loads the browser IIFE in a vm sandbox, the same way test-map-estimated.js
// does, and drives the overlay with a recording Leaflet stub.
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
vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'public', 'scope-geometry.js'), 'utf8'), sandbox);
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

console.log('\n=== scope-contours.js: hull geometry ===');

test('exposes its API', () => {
  assert.ok(SC, 'window.ScopeContours not defined');
  for (const fn of ['normRegion', 'nodeRegionEvidence', 'groupNodesByScope', 'convexHull', 'scopeHull', 'contourShapes', 'wrapShapes', 'shapeFor', 'reachFor', 'linkReach', 'inRings', 'colorsFor', 'createOverlay', 'mountViewPicker', 'viewFromHash']) {
    assert.strictEqual(typeof SC[fn], 'function', fn + ' not exported');
  }
});

const ringPlain = (r) => JSON.parse(JSON.stringify(r));

test('convexHull keeps the corners, drops inside and collinear points', () => {
  const pts = [[0, 0], [0, 1], [1, 1], [1, 0], [0.5, 0.5], [0.2, 0.7], [0, 0.5], [1, 0.25]];
  const ring = ringPlain(SC.convexHull(pts));
  assert.strictEqual(ring.length, 4, JSON.stringify(ring));
  for (const c of [[0, 0], [0, 1], [1, 1], [1, 0]]) assert.ok(ring.some(p => p[0] === c[0] && p[1] === c[1]), 'missing corner ' + c);
});

test('convexHull of fewer than three distinct points, or of a line, is empty', () => {
  assert.deepStrictEqual(ringPlain(SC.convexHull([])), []);
  assert.deepStrictEqual(ringPlain(SC.convexHull([[0, 0], [1, 1]])), []);
  assert.deepStrictEqual(ringPlain(SC.convexHull([[0, 0], [1, 1], [2, 2]])), []);
});

test('the hull of one plain circle is that circle (within 0.2%)', () => {
  const c = [40.7, -74.0];
  const rings = SC.scopeHull([SC.shapeFor({ lat: c[0], lon: c[1] }, null, 8000)]);
  assert.strictEqual(rings.length, 1);
  assert.ok(rings[0].length >= 60, 'too coarse: ' + rings[0].length);
  for (const p of rings[0]) { const d = metres(c, p); assert.ok(d > 7975 && d < 8010, 'ring point ' + Math.round(d) + ' m'); }
});

test('distant members are joined into one area, the gap between them filled', () => {
  const a = offset(40.7, -74.0, 0, 0), b = offset(40.7, -74.0, 100000, 0);
  const rings = SC.scopeHull([SC.shapeFor(a, null, 1000), SC.shapeFor(b, null, 1000)]);
  assert.strictEqual(rings.length, 1);
  const mid = offset(40.7, -74.0, 50000, 0);
  assert.ok(SC.inRings(rings, mid.lat, mid.lon), 'midpoint not inside');
  const off = offset(40.7, -74.0, 50000, 2000);
  assert.ok(!SC.inRings(rings, off.lat, off.lon), 'a band 2 km wide should not be inside');
});

test('a ring of members has no hole: the empty middle is part of the area', () => {
  const shapes = [];
  for (let k = 0; k < 24; k++) { const t = (k / 24) * 2 * Math.PI; shapes.push(SC.shapeFor(offset(40.7, -74.0, 40000 * Math.cos(t), 40000 * Math.sin(t)), null, 1000)); }
  const rings = SC.scopeHull(shapes);
  assert.strictEqual(rings.length, 1);
  assert.ok(SC.inRings(rings, 40.7, -74.0), 'the middle is outside');
});

test('unusable shapes are skipped; none at all gives no area', () => {
  assert.deepStrictEqual(ringPlain(SC.scopeHull([])), []);
  assert.deepStrictEqual(ringPlain(SC.scopeHull([null])), []);
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

test('configuredScopes reads default_scope and the reported list, and says which', () => {
  // A server without declared_regions: configured_scope is the list.
  const m = SC.configuredScopes({ default_scope: '#metro', configured_scope: '#metro, #us-pa,*,,us' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(Array.from(m))), [
    ['metro', { default: true, reported: true }],
    ['us-pa', { default: false, reported: true }],
    ['us', { default: false, reported: true }],
  ]);
  assert.strictEqual(SC.configuredScopes({}).size, 0);
  assert.strictEqual(SC.configuredScopes(null).size, 0);
});

// declared_regions is the server's newest answer across configured_scope and
// the companions' regions queries. Adding the raw configured_scope to it
// brought back regions a newer answer had dropped.
test('declared_regions is the newest list: an older configured_scope does not add to it', () => {
  const n = { role: 'repeater', configured_scope: '#metro,#us-pa', declared_regions: ['us-pa'], transported_scopes: ['#metro'] };
  assert.deepStrictEqual(JSON.parse(JSON.stringify(Array.from(SC.configuredScopes(n)))), [['us-pa', { default: false, reported: true }]]);
  assert.strictEqual(SC.carriedScopes(n).size, 0, 'carrying #metro is older than the list that dropped it');
  const g = SC.groupNodesByScope([Object.assign({ public_key: 'r', lat: 1, lon: 1 }, n)]);
  assert.strictEqual(g.has('metro'), false, 'the dropped region makes no area');
});

// A truncated answer names only part of the list, so a region missing from
// it may still be configured: it adds what it names and rules nothing out.
test('a truncated list adds its regions but does not override carrying or the default scope', () => {
  const n = { role: 'repeater', default_scope: '#c', declared_regions: ['a'], declared_regions_truncated: true, transported_scopes: ['#b'] };
  assert.deepStrictEqual(JSON.parse(JSON.stringify(Array.from(SC.configuredScopes(n)))), [
    ['c', { default: true, reported: false }],
    ['a', { default: false, reported: true }],
  ]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(Array.from(SC.carriedScopes(n)))), ['b']);
  const whole = Object.assign({}, n, { declared_regions_truncated: undefined });
  assert.strictEqual(SC.carriedScopes(whole).size, 0, 'the same list, complete, rules #b out');
  assert.strictEqual(SC.configuredScopes(whole).has('c'), false, 'and the default it leaves out');
});

test('a node configured by default_scope or configured_scope is a configured-only member unless it carries the scope', () => {
  const g = SC.groupNodesByScope([
    { public_key: 'd1', lat: 1, lon: 1, default_scope: '#metro' },
    { public_key: 'd2', lat: 1, lon: 2, configured_scope: '#metro,#nj' },
    { public_key: 'd3', lat: 1, lon: 3, default_scope: '#metro', transported_scopes: ['#metro'] },
  ]);
  const keys = g2 => JSON.parse(JSON.stringify(g2.map(n => n.public_key)));
  assert.deepStrictEqual(keys(g.get('metro').configuredOnly), ['d1', 'd2']);
  assert.deepStrictEqual(keys(g.get('metro').observed), ['d3']);
  assert.deepStrictEqual(keys(g.get('nj').configuredOnly), ['d2']);
});

// A repeater only forwards scoped floods for regions on its list (firmware
// RegionMap::findMatch returns NULL for any other transport code), so once it
// has reported a list, carrying a scope that is not on it is evidence from
// before the list changed.
test('a reported list overrides carrying a scope it does not name', () => {
  const g = SC.groupNodesByScope([
    { public_key: 'r1', lat: 1, lon: 1, configured_scope: '*,#metro', transported_scopes: ['#metro', '#east-side'] },
    { public_key: 'r2', lat: 1, lon: 2, declared_regions: ['metro'], transported_scopes: ['#east-side'] },
    { public_key: 'r3', lat: 1, lon: 3, transported_scopes: ['#east-side'] },
  ]);
  const keys = g2 => JSON.parse(JSON.stringify(g2.map(n => n.public_key)));
  assert.deepStrictEqual(keys(g.get('metro').observed), ['r1']);
  assert.deepStrictEqual(keys(g.get('metro').configuredOnly), ['r2']);
  assert.deepStrictEqual(keys(g.get('east-side').observed), ['r3'], 'only the repeater with no list keeps its carrying');
  assert.strictEqual(g.get('east-side').configuredOnly.length, 0);
});

test('the reported list keeps a carried scope, and default_scope alone does not', () => {
  const c = n => JSON.parse(JSON.stringify(Array.from(SC.carriedScopes(n))));
  assert.deepStrictEqual(c({ configured_scope: '*,#a', transported_scopes: ['#a', '#b', '#c'] }), ['a']);
  assert.deepStrictEqual(c({ configured_scope: '*,#a', declared_regions: ['b'], transported_scopes: ['#a', '#b', '#c'] }), ['b'],
    'declared_regions, the newest list, wins over configured_scope');
  assert.deepStrictEqual(c({ default_scope: '#c', configured_scope: '*,#a', transported_scopes: ['#c'] }), [],
    'the default region need not allow floods, so it does not vouch for carrying');
  assert.deepStrictEqual(c({ default_scope: '#c', transported_scopes: ['#c'] }), ['c'], 'no list: carrying stands');
});

test('a list with no named regions means it carries nothing', () => {
  const c = n => SC.carriedScopes(n).size;
  assert.strictEqual(c({ configured_scope: '*', transported_scopes: ['#a'] }), 0);
  assert.strictEqual(c({ configured_scope: '', transported_scopes: ['#a'] }), 0);
  assert.strictEqual(c({ declared_regions: [], transported_scopes: ['#a'] }), 0);
  assert.strictEqual(c({ configured_scope: null, declared_regions: null, transported_scopes: ['#a'] }), 1, 'null is "never reported"');
});

// Only a repeater checks a scoped flood against its region list (firmware
// simple_repeater allowPacketForward). A companion (isRepeatEn) and a room
// server (disable_fwd) forward without looking at the region, so their
// default scope says nothing about what they forward.
test('default_scope makes a member only of a repeater, or of a node whose role is unknown', () => {
  const has = n => SC.configuredScopes(n).has('c');
  assert.strictEqual(has({ role: 'repeater', default_scope: '#c' }), true);
  assert.strictEqual(has({ default_scope: '#c' }), true, 'role unknown');
  assert.strictEqual(has({ role: 'companion', default_scope: '#c' }), false);
  assert.strictEqual(has({ role: 'room', default_scope: '#c' }), false);
  assert.strictEqual(has({ role: 'sensor', default_scope: '#c' }), false);
  const g = SC.groupNodesByScope([{ public_key: 'k', role: 'companion', lat: 1, lon: 1, default_scope: '#c' }]);
  assert.strictEqual(g.has('c'), false, 'a placed companion does not make an area');
});

test('a default scope the repeater\'s own list leaves out does not count', () => {
  const m = n => JSON.parse(JSON.stringify(Array.from(SC.configuredScopes(n))));
  assert.deepStrictEqual(m({ role: 'repeater', default_scope: '#c', configured_scope: '*,#a' }),
    [['a', { default: false, reported: true }]]);
  assert.deepStrictEqual(m({ role: 'repeater', default_scope: '#a', declared_regions: ['a'] }),
    [['a', { default: true, reported: true }]], 'on the list: still tagged default');
  assert.strictEqual(SC.configuredScopes({ role: 'repeater', default_scope: '#c', configured_scope: '*' }).size, 0);
});

test('linkedGroups splits members by the links between them, heard either way', () => {
  const ns = [
    { public_key: 'a', lat: 45, lon: -100.0 }, { public_key: 'b', lat: 45, lon: -99.9 },
    { public_key: 'c', lat: 45, lon: -99.5 }, { public_key: 'd', lat: 45, lon: -99.4 },
    { public_key: 'x', lat: 45, lon: -99.7 },
    { public_key: 'e', lat: 46, lon: -99.0 }, { public_key: 'f', lat: 46, lon: -99.0 },
  ];
  const r = SC.linkReach(ns, [
    { source: 'a', target: 'b', heard_by_target: 2 },
    { source: 'c', target: 'd', heard_by_source: 1 },
    // Through x, which is not a member: it forwards nothing for the scope.
    { source: 'b', target: 'x', heard_by_source: 1, heard_by_target: 1 }, { source: 'x', target: 'c', heard_by_target: 1 },
    // Direction unknown: the flag alone proves nothing.
    { source: 'b', target: 'c', bidirectional: true },
    { source: 'a', target: 'd', heard_by_source: 1, heard_by_target: 1, ambiguous: true },
    // Co-located, still linked.
    { source: 'e', target: 'f', heard_by_target: 1 },
  ]);
  const members = ns.filter(n => n.public_key !== 'x');
  const keys = gs => JSON.parse(JSON.stringify(gs.map(g => g.map(n => n.public_key))));
  assert.deepStrictEqual(keys(SC.linkedGroups(members, r.peers)), [['a', 'b'], ['c', 'd'], ['e', 'f']]);
  assert.deepStrictEqual(keys(SC.linkedGroups(members, null)), [['a'], ['b'], ['c'], ['d'], ['e'], ['f']], 'no links yet: each alone');
  assert.deepStrictEqual(keys(SC.linkedGroups([], r.peers)), []);
});

test('the click box drops a stale carrying member and tags carrying only for listed scopes', () => {
  const nodes = [
    { public_key: 'p1', name: 'Listed', lat: 45.0, lon: -100.0, configured_scope: '*,#metro', transported_scopes: ['#metro', '#east-side'] },
    { public_key: 'p2', name: 'Unlisted', lat: 45.01, lon: -100.0, transported_scopes: ['#east-side'] },
  ];
  const nj = SC.scopePopupHtml(['east-side'], nodes);
  assert.ok(!/Listed<\/a>/.test(nj.replace(/Unlisted<\/a>/g, '')), 'the listed repeater is not a east-side member: ' + nj);
  assert.ok(/Unlisted<\/a> <span class="mc-scope-tag"[^>]*>carrying<\/span>/.test(nj), nj);
  const ph = SC.scopePopupHtml(['metro'], nodes);
  assert.ok(/Listed<\/a> <span class="mc-scope-tag"[^>]*>reported<\/span><span class="mc-scope-tag"[^>]*>carrying<\/span>/.test(ph), ph);
});

test('colorsFor hands out colours in name order, whatever order the scopes come in', () => {
  const plain = (m) => Object.fromEntries(Array.from(m));
  assert.deepStrictEqual(plain(SC.colorsFor(['nyc', 'li', 'ct', 'ny', 'li'])), { ct: 1, li: 2, ny: 3, nyc: 4 });
  assert.deepStrictEqual(plain(SC.colorsFor(['METRO', 'harbor', 'midtown'])), { harbor: 1, METRO: 2, midtown: 3 }, 'case aside');
  assert.strictEqual(SC.colorsFor([]).size, 0);
});

test('colorsFor: up to eight scopes all differ; more share each colour as evenly as they can', () => {
  const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.strictEqual(new Set(SC.colorsFor(eight).values()).size, 8);
  // Twelve scopes, as on one live instance where all twelve overlap. A hash
  // of the name put those on 6 colours, with 8 pairs alike; 4 is the least
  // possible.
  const live = ['metro', 'METRO', 'downtown', 'harbor', 'uptown', 'riverside', 'north',
    'south', 'valley', 'ridge', 'coast', 'midtown'];
  const uses = new Map();
  SC.colorsFor(live).forEach((c) => {
    assert.ok(c >= 1 && c <= 8, String(c));
    uses.set(c, (uses.get(c) || 0) + 1);
  });
  assert.strictEqual(uses.size, 8, 'every colour used');
  let alike = 0;
  uses.forEach((n) => { alike += n * (n - 1) / 2; });
  assert.strictEqual(alike, 4);
});

console.log('\n=== scope-contours.js: deep link ===');

test('hashFlag reads ?contours=, null when absent', () => {
  assert.strictEqual(SC.hashFlag('#/map?contours=1'), true);
  assert.strictEqual(SC.hashFlag('#/map?lat=1&contours=0&zoom=3'), false);
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
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'public', 'scope-geometry.js'), 'utf8'), us);
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

console.log('\n=== scope-contours.js: reach (radius, terrain, links) ===');

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

const HOME = { public_key: 'h0', lat: 45.0, lon: -100.0 };
const EAST = Object.assign({ public_key: 'e1' }, offset(45.0, -100.0, 20000, 0));
const NORTH = Object.assign({ public_key: 'n1' }, offset(45.0, -100.0, 0, 6000));
const FAR = Object.assign({ public_key: 'f1' }, offset(45.0, -100.0, -30000, 0));
const plain = (m) => JSON.parse(JSON.stringify(Array.from(m)));
// Neighbor-graph edges as the API serves them: heard_by_target counts the
// target receiving the source, heard_by_source the reverse.
const two = (a, b) => ({ source: a, target: b, bidirectional: true, heard_by_source: 1, heard_by_target: 1 });
const heard = (a, b) => ({ source: a, target: b, bidirectional: false, heard_by_source: 0, heard_by_target: 1 }); // b heard a
const RAY = (deg) => Math.round(deg / 5) % 72;   // 72 rays of 5°

test('the radius is the 75th percentile of the distances it was heard over x 1.1 (~13.9 km here)', () => {
  // A repeater heard over 17 links, distances in km as a real mesh had
  // them, all bearings east so only the distances matter here.
  const km = [0.05, 0.9, 1.7, 1.8, 2.1, 2.1, 2.1, 2.2, 2.3, 7.3, 10.0, 10.0, 12.6, 14.9, 15.1, 15.1, 33.2];
  const others = km.map((d, i) => Object.assign({ public_key: 'o' + i }, offset(HOME.lat, HOME.lon, d * 1000, 0)));
  const r = SC.linkReach([HOME].concat(others), others.map(o => heard('h0', o.public_key)));
  const R = r.radius.get('h0');
  assert.ok(Math.abs(R - 13860) < 60, 'radius ' + R);
});

test('a one-way link counts only for the end that was heard', () => {
  // EAST heard HOME: that proves how far HOME's signal goes, not EAST's.
  const r = SC.linkReach([HOME, EAST], [heard('h0', 'e1')]);
  assert.strictEqual(r.radius.get('h0'), 20000, 'heard over 20 km x 1.1, clamped');
  assert.ok(!r.radius.has('e1'), 'the listener gets no radius from it');
  assert.strictEqual((r.links.get('h0') || []).length, 1, 'a lobe toward the listener');
  assert.ok(!r.links.has('e1'), 'no lobe from the listener back');
  assert.deepStrictEqual(plain(r.partners.get('h0')).map(p => p.lon.toFixed(3)), [EAST.lon.toFixed(3)], 'the listener raises the antenna estimate');
  assert.ok(!r.partners.has('e1'));
  assert.deepStrictEqual(plain(r.peers.get('h0')), ['e1'], 'still joins the two for grouping');
  assert.deepStrictEqual(plain(r.peers.get('e1')), ['h0']);
  // The reverse direction, as heard_by_source.
  const back = SC.linkReach([HOME, EAST], [{ source: 'h0', target: 'e1', heard_by_source: 4 }]);
  assert.ok(back.radius.has('e1') && !back.radius.has('h0'), 'heard_by_source: the source heard the target');
});

test('the radius is clamped to 1-20 km; a node with no links gets 1 km', () => {
  const near = Object.assign({ public_key: 'n1' }, offset(HOME.lat, HOME.lon, 400, 0));
  const far = Object.assign({ public_key: 'f9' }, offset(HOME.lat, HOME.lon, 0, 40000));
  const r = SC.linkReach([HOME, near, far, EAST], [two('h0', 'n1'), two('e1', 'f9')]);
  assert.strictEqual(r.radius.get('h0'), 1000);
  assert.strictEqual(r.radius.get('e1'), 20000);
  assert.strictEqual(SC.noLinkRadius, 1000);
});

test('ambiguous links, links of unknown direction, self links and links to unplaced nodes prove nothing', () => {
  const r = SC.linkReach([HOME, EAST, { public_key: 'u1' }], [
    { source: 'h0', target: 'e1', bidirectional: true, heard_by_source: 1, heard_by_target: 1, ambiguous: true },
    // bidirectional without direction counts (as the server once sent every
    // edge, and still does for edges restored at startup) is not evidence.
    { source: 'h0', target: 'e1', bidirectional: true },
    { source: 'h0', target: 'e1', bidirectional: true, heard_by_source: 0, heard_by_target: 0 },
    { source: 'h0', target: 'e1' },
    two('h0', 'h0'), two('h0', 'u1'), two('h0', 'missing'), null,
  ]);
  assert.strictEqual(r.radius.size, 0);
  assert.strictEqual(r.links.size, 0);
  assert.strictEqual(r.peers.size, 0);
});

test('a link lobe is its distance x 1.1 within one ray of its bearing, tapering to nothing at 11.25°', () => {
  const r = SC.linkReach([HOME, EAST], [two('h0', 'e1')]);
  const h = plain(SC.lobeOf(r.links.get('h0'))), e = plain(SC.lobeOf(r.links.get('e1')));
  assert.ok(Math.abs(h[RAY(90)] - 22000) < 150, 'on bearing ' + h[RAY(90)]);
  assert.ok(Math.abs(h[RAY(85)] - 22000) < 150 && Math.abs(h[RAY(95)] - 22000) < 150, 'one ray off ' + h[RAY(85)] + ' ' + h[RAY(95)]);
  assert.ok(Math.abs(h[RAY(80)] - 22000 * (1 - 5 / 6.25)) < 400, '10° off ' + h[RAY(80)]);
  assert.strictEqual(h[RAY(75)], 0, '15° off');
  assert.ok(Math.abs(e[RAY(270)] - 22000) < 150, 'the far end gets the reverse lobe');
});

test('reachFor: min(radius, terrain), stretched by lobes, never under the floor', () => {
  const cut = new Float64Array(SC.sectors).fill(8000);
  cut[RAY(270)] = 300; cut[RAY(180)] = 100;
  const lobe = new Float64Array(SC.sectors); lobe[RAY(90)] = 22000;
  const out = plain(SC.reachFor(5000, cut, lobe, 250));
  assert.strictEqual(out[RAY(0)], 5000, 'radius caps terrain');
  assert.strictEqual(out[RAY(270)], 300, 'terrain cuts');
  assert.strictEqual(out[RAY(180)], 250, 'floor holds');
  assert.strictEqual(out[RAY(90)], 22000, 'a proven link stretches past the radius');
  assert.ok(plain(SC.reachFor(5000, null, null, 250)).every(v => v === 5000), 'no terrain: the radius all round');
});

test('the hull spans a terrain notch from the directions either side of it', () => {
  // One member, radius 8 km, terrain cut to 2 km from 225° to 315°: the
  // area's west edge is the chord between 220° and 320°, 8 km x sin 40°
  // west, not the 2 km cut. A general area, as chosen.
  const cut = new Float64Array(SC.sectors).fill(30000);
  for (let d = 225; d <= 315; d += 5) cut[RAY(d)] = 2000;
  const rings = SC.scopeHull([SC.shapeFor(HOME, SC.reachFor(8000, cut, null, 1000), 1000)]);
  const west = reachToward(rings, HOME, 270), north = reachToward(rings, HOME, 0);
  assert.ok(Math.abs(west - 8000 * Math.sin(40 * Math.PI / 180)) < 300, 'west ' + west);
  assert.ok(Math.abs(north - 8000) < 100, 'north ' + north);
});

test('a far link\'s tip is a corner of the area', () => {
  const lobe = plain(SC.lobeOf(SC.linkReach([HOME, EAST], [two('h0', 'e1')]).links.get('h0')));
  const rings = SC.scopeHull([SC.shapeFor(HOME, SC.reachFor(1000, null, lobe, 1000), 1000)]);
  const tip = offset(HOME.lat, HOME.lon, 22000, 0);
  assert.ok(rings[0].some(p => metres([tip.lat, tip.lon], p) < 60), 'no vertex at the lobe tip');
  assert.ok(SC.inRings(rings, EAST.lat, EAST.lon), 'the linked node is outside');
});

test('a linked node off the 5° rays is still inside, with room past it, in both views', () => {
  // Rays sit every 5°; a partner between two of them got a lobe that fell
  // short of it (to ~86% of its distance at 2.5° off), leaving it just
  // outside a corner, as happened on a real mesh.
  for (const deg of [2.5, 37.5, 62, 118.7, 211.2, 333.3]) {
    const t = deg * Math.PI / 180;
    const far = Object.assign({ public_key: 'p1' }, offset(HOME.lat, HOME.lon, 30000 * Math.sin(t), 30000 * Math.cos(t)));
    const past = offset(HOME.lat, HOME.lon, 31500 * Math.sin(t), 31500 * Math.cos(t));
    const lobe = SC.lobeOf(SC.linkReach([HOME, far], [two('h0', 'p1')]).links.get('h0'));
    const shape = SC.shapeFor(HOME, SC.reachFor(1000, null, lobe, 1000), 1000);
    for (const [view, rings] of [['hull', SC.scopeHull([shape])], ['detailed', SC.wrapShapes([shape])]]) {
      assert.ok(SC.inRings(rings, far.lat, far.lon), view + ': partner at ' + deg + '° is outside');
      assert.ok(SC.inRings(rings, past.lat, past.lon), view + ': no room past the partner at ' + deg + '°');
    }
  }
});

// The guarantee the floor exists for: every member has at least 1 km of
// area all round it, edge members included.
function assertKmAround(rings, n, label) {
  for (let d = 0; d < 360; d += 5) {
    const t = d * Math.PI / 180, q = offset(n.lat, n.lon, 990 * Math.sin(t), 990 * Math.cos(t));
    assert.ok(SC.inRings(rings, q.lat, q.lon), label + ': less than 1 km of area at ' + d + '°');
  }
}

test('every member has at least 1 km of area all round, even boxed in by a ridge 300 m away', () => {
  const boxed = new Float64Array(SC.sectors).fill(300);   // terrain cuts every direction to 300 m
  const members = [
    SC.shapeFor(HOME, SC.reachFor(8000, boxed, null, 1000), 1000),
    SC.shapeFor(EAST, SC.reachFor(1000, null, null, 1000), 1000),
    SC.shapeFor(FAR, SC.reachFor(20000, null, null, 1000), 1000),
  ];
  const rings = SC.scopeHull(members);
  for (const n of [HOME, EAST, FAR]) assertKmAround(rings, n, n.public_key);
});

// Metres from p to the nearest point of ring's edge, in a local projection.
function edgeDist(ring, p) {
  const kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 111320;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = (ring[j][1] - p[1]) * kx, ay = (ring[j][0] - p[0]) * ky;
    const bx = (ring[i][1] - p[1]) * kx, by = (ring[i][0] - p[0]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
// The largest turn, in degrees, at any vertex of a ring: a sharp corner
// turns a lot at one vertex, a rounded one a little at each.
function sharpestTurn(ring) {
  let worst = 0;
  const kx = Math.cos(ring[0][0] * Math.PI / 180);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
    const t1 = Math.atan2(b[0] - a[0], (b[1] - a[1]) * kx), t2 = Math.atan2(c[0] - b[0], (c[1] - b[1]) * kx);
    let d = Math.abs(t2 - t1) * 180 / Math.PI;
    if (d > 180) d = 360 - d;
    worst = Math.max(worst, d);
  }
  return worst;
}
function assertAround(rings, n, m, label) {
  for (let d = 0; d < 360; d += 5) {
    const t = d * Math.PI / 180, q = offset(n.lat, n.lon, m * Math.sin(t), m * Math.cos(t));
    assert.ok(SC.inRings(rings, q.lat, q.lon), label + ': less than ' + m + ' m of area at ' + d + '°');
  }
}

test('the hull with a 2 km margin: 2 km past the bare hull everywhere, corners rounded', () => {
  const r = SC.linkReach([HOME, EAST, FAR], [two('h0', 'e1'), two('h0', 'f1')]);
  const shapes = [HOME, EAST, FAR].map(n => SC.shapeFor(n, SC.reachFor(r.radius.get(n.public_key) || 1000, null, SC.lobeOf(r.links.get(n.public_key)), 1000), 1000));
  const bare = SC.scopeHull(shapes)[0], rings = SC.scopeHull(shapes, 2000), ring = rings[0];
  assert.strictEqual(rings.length, 1);
  for (const p of ring) {
    const dd = edgeDist(bare, p);
    assert.ok(dd > 1980 && dd < 2020, 'a vertex ' + Math.round(dd) + ' m from the bare hull');
  }
  for (const p of bare) assert.ok(SC.inRings(rings, p[0], p[1]), 'a bare corner is outside');
  assert.ok(sharpestTurn(ring) <= 5.5, 'a corner turns ' + sharpestTurn(ring).toFixed(1) + '° at once');
  for (const n of [HOME, EAST, FAR]) assertAround(rings, n, 2990, n.public_key);
  assert.deepStrictEqual(SC.scopeHull(shapes, 0), SC.scopeHull(shapes), 'no margin, no change');
});

test('Detailed with a 2 km margin: about 2 km past the bare area, a lobe tip rounded', () => {
  const lobe = SC.lobeOf(SC.linkReach([HOME, EAST], [two('h0', 'e1')]).links.get('h0'));
  const shapes = [SC.shapeFor(HOME, SC.reachFor(1000, null, lobe, 1000), 1000)];
  const bare = SC.wrapShapes(shapes), rings = SC.wrapShapes(shapes, undefined, 2000);
  assert.strictEqual(rings.length, 1);
  assertAround(rings, HOME, 2990, 'home');
  // 2 km past the lobe's tip (22 km east), and 2 km either side of it.
  for (const [e, n] of [[23900, 0], [22000, 1900], [22000, -1900]]) {
    const q = offset(HOME.lat, HOME.lon, e, n);
    assert.ok(SC.inRings(rings, q.lat, q.lon), 'no margin round the tip at ' + e + ',' + n);
  }
  const out = offset(HOME.lat, HOME.lon, 24700, 0);
  assert.ok(!SC.inRings(rings, out.lat, out.lon), 'more than ~2 km past the tip');
  for (const p of rings[0]) {
    const dd = Math.min.apply(null, bare.map(b => edgeDist(b, p)));
    assert.ok(dd > 1900 && dd < 2700, 'a vertex ' + Math.round(dd) + ' m from the bare area');
  }
});

test('the overlay draws both views with the 2 km margin: 3 km round a lone repeater', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  const lone = { public_key: 'z1', lat: 45.0, lon: -100.0, transported_scopes: ['#solo'] };
  o.setNodes([lone]); o.setVisible(true);
  for (const view of ['hull', 'detailed']) {
    o.setView(view);   // Convex Hull is already drawn: a no-op
    const rings = rec.polygons[rec.polygons.length - 1].rings;
    assertAround(rings, lone, 2950, view);
    const out = offset(lone.lat, lone.lon, 3400, 0);
    assert.ok(!SC.inRings(rings, out.lat, out.lon), view + ': more than 3 km round it');
  }
  assert.strictEqual(SC.areaMarginM, 2000);
});

test('linked nodes sit inside the area they extend', () => {
  const r = SC.linkReach([HOME, EAST, FAR], [two('h0', 'e1'), two('h0', 'f1')]);
  const shapes = [HOME, EAST, FAR].map(n => SC.shapeFor(n, SC.reachFor(r.radius.get(n.public_key) || 1000, null, SC.lobeOf(r.links.get(n.public_key)), 1000), 1000));
  const rings = SC.scopeHull(shapes);
  for (const n of [HOME, EAST, FAR]) assert.ok(SC.inRings(rings, n.lat, n.lon), n.public_key + ' outside its own area');
});

test('inRings: even-odd, so a hole is outside', () => {
  const outer = [[0, 0], [0, 10], [10, 10], [10, 0]], hole = [[4, 4], [4, 6], [6, 6], [6, 4]];
  assert.strictEqual(SC.inRings([outer, hole], 2, 2), true);
  assert.strictEqual(SC.inRings([outer, hole], 5, 5), false);
  assert.strictEqual(SC.inRings([outer, hole], 20, 5), false);
  // Per-ring boxes skip rings that cannot hold the point, same answers.
  const far = [[50, 50], [50, 60], [60, 60], [60, 50]];
  const rings = [outer, hole, far], boxes = [[0, 0, 10, 10], [4, 4, 6, 6], [50, 50, 60, 60]];
  for (const p of [[2, 2], [5, 5], [20, 5], [55, 55], [5, 55], [55, 5]]) {
    assert.strictEqual(SC.inRings(rings, p[0], p[1], boxes), SC.inRings(rings, p[0], p[1]), 'at ' + p);
  }
});

console.log('\n=== scope-contours.js: reach field (contourShapes, what the detailed view wraps) ===');

const circles = (pts, R) => pts.map(p => SC.shapeFor(p, null, R));

test('no shapes, or only unusable ones, give no rings', () => {
  assert.deepStrictEqual(ringPlain(SC.contourShapes([])), []);
  assert.deepStrictEqual(ringPlain(SC.contourShapes([null, { lat: NaN, lon: 1, minExt: 1000 }])), []);
});

test('one circle gives one ring at its radius, within 5%', () => {
  const c = [40.7, -74.0];
  const rings = SC.contourShapes(circles([{ lat: c[0], lon: c[1] }], 8000));
  assert.strictEqual(rings.length, 1);
  assert.ok(rings[0].length >= 16, 'ring too coarse: ' + rings[0].length + ' points');
  for (const p of rings[0]) assert.ok(Math.abs(metres(c, p) - 8000) <= 400, 'ring point ' + Math.round(metres(c, p)) + ' m from the node');
});

test('far-apart circles give two rings, overlapping ones one', () => {
  const a = offset(40.7, -74.0, 0, 0);
  assert.strictEqual(SC.contourShapes(circles([a, offset(40.7, -74.0, 100000, 0)], 8000)).length, 2);
  const b = offset(40.7, -74.0, 5000, 0);
  const rings = SC.contourShapes(circles([a, b], 8000));
  assert.strictEqual(rings.length, 1);
  const lons = rings[0].map(p => p[1]);
  assert.ok(Math.min(...lons) < a.lon && Math.max(...lons) > b.lon, 'the merged outline reaches past both');
});

test('members round an empty middle give an outer ring and a hole', () => {
  const pts = [];
  for (let k = 0; k < 24; k++) { const t = (k / 24) * 2 * Math.PI; pts.push(offset(40.7, -74.0, 40000 * Math.cos(t), 40000 * Math.sin(t))); }
  const rings = SC.contourShapes(circles(pts, 8000));
  assert.strictEqual(rings.length, 2);
  assert.ok(!SC.inRings(rings, 40.7, -74.0), 'the middle is not reached');
});

test('distant clusters keep full resolution', () => {
  const nyc = { lat: 40.7, lon: -74.0 }, ams = { lat: 52.37, lon: 4.9 };
  const rings = SC.contourShapes(circles([nyc, ams], 8000));
  assert.strictEqual(rings.length, 2);
  for (const r of rings) {
    const c = metres([nyc.lat, nyc.lon], r[0]) < 100000 ? nyc : ams;
    for (const p of r) assert.ok(Math.abs(metres([c.lat, c.lon], p) - 8000) <= 400);
  }
});

test('the outline follows the reach: cut by terrain west, radius north, a lobe east', () => {
  const cut = new Float64Array(SC.sectors).fill(30000);
  for (let d = 225; d <= 315; d += 5) cut[RAY(d)] = 2000;
  const lobe = plain(SC.lobeOf(SC.linkReach([HOME, EAST], [two('h0', 'e1')]).links.get('h0')));
  const rings = SC.contourShapes([SC.shapeFor(HOME, SC.reachFor(8000, cut, lobe, 1000), 1000)]);
  assert.strictEqual(rings.length, 1);
  const west = reachToward(rings, HOME, 270), north = reachToward(rings, HOME, 0), east = reachToward(rings, HOME, 90);
  assert.ok(Math.abs(west - 2000) < 250, 'west ' + west);
  assert.ok(Math.abs(north - 8000) < 400, 'north ' + north);
  // The lobe runs to 22 km (the link x 1.1); its last few hundred metres are
  // narrower than a grid cell, so the drawn tip stops up to a cell or two
  // short, but always past the linked node at 20 km.
  assert.ok(east >= 20000 && east <= 22500, 'east ' + east);
  assert.ok(SC.inRings(rings, EAST.lat, EAST.lon), 'the linked node is outside');
});

test('an edge slanting across the rays (a ridge line) is not pushed out', () => {
  // Terrain cuts every westward ray at a north-south line 3 km west: the
  // reach edge slants across the rays, up to 60° off them here.
  const cut = new Float64Array(SC.sectors).fill(30000);
  for (let d = 210; d <= 330; d += 5) cut[RAY(d)] = 3000 / Math.abs(Math.sin(d * Math.PI / 180));
  const rings = SC.contourShapes([SC.shapeFor(HOME, SC.reachFor(8000, cut, null, 1000), 1000)]);
  // How far past the ridge line the outline reaches, along a row: walking
  // west, the last point inside. Grid cells are 600 m here.
  const past = (dn) => {
    let x = -2000;
    while (x > -6000) { const q = offset(HOME.lat, HOME.lon, x - 10, dn); if (!SC.inRings(rings, q.lat, q.lon)) break; x -= 10; }
    return -x - 3000;
  };
  const out = [-4000, -2000, 0, 2000, 4000].map(past);
  assert.ok(out.every((m) => m < 150), 'metres past the ridge line: ' + out.join(', '));
});

test('a lone link\'s lobe is narrow and stays attached to its 1 km circle', () => {
  const lobe = plain(SC.lobeOf(SC.linkReach([HOME, EAST], [two('h0', 'e1')]).links.get('h0')));
  const rings = SC.contourShapes([SC.shapeFor(HOME, SC.reachFor(1000, null, lobe, 1000), 1000)]);
  assert.strictEqual(rings.length, 1, 'the lobe came loose from the circle');
  const on = reachToward(rings, HOME, 90), off = reachToward(rings, HOME, 80), far = reachToward(rings, HOME, 70);
  assert.ok(on > 20000, 'on the link ' + on);
  assert.ok(off < 7000, '10° off the link ' + off);
  assert.ok(far < 2500, '20° off the link ' + far);
});

test('detailed: every member has at least 1 km of area all round, even boxed in by terrain', () => {
  const boxed = new Float64Array(SC.sectors).fill(300);
  const rings = SC.contourShapes([
    SC.shapeFor(HOME, SC.reachFor(8000, boxed, null, 1000), 1000),
    SC.shapeFor(EAST, SC.reachFor(1000, null, null, 1000), 1000),
  ]);
  for (const n of [HOME, EAST]) assertKmAround(rings, n, n.public_key);
});

console.log('\n=== scope-contours.js: detailed view (wrapShapes, shrink-wrap) ===');

// selfCrosses: whether any two non-adjacent edges of a ring cross.
function selfCrosses(ring) {
  const n = ring.length;
  const crossP = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j], d = ring[(j + 1) % n];
      if (crossP(a, b, c) * crossP(a, b, d) < 0 && crossP(c, d, a) * crossP(c, d, b) < 0) return true;
    }
  }
  return false;
}

test('members whose reach comes within 15 km are joined; further apart they stay two areas', () => {
  assert.strictEqual(SC.wrapGapM, 15000);
  const a = offset(40.7, -74.0, 0, 0);
  // Reach 1 km each: centres 12 km apart leave a 10 km gap, 30 km apart 28 km.
  const near = SC.wrapShapes(circles([a, offset(40.7, -74.0, 12000, 0)], 1000));
  assert.strictEqual(near.length, 1, 'a 10 km gap should be bridged');
  const mid = offset(40.7, -74.0, 6000, 0);
  assert.ok(SC.inRings(near, mid.lat, mid.lon), 'the gap is part of the area');
  assert.ok(!SC.inRings(SC.contourShapes(circles([a, offset(40.7, -74.0, 12000, 0)], 1000)), mid.lat, mid.lon), 'detailed leaves the gap');
  const far = SC.wrapShapes(circles([a, offset(40.7, -74.0, 30000, 0)], 1000));
  assert.strictEqual(far.length, 2, 'a 28 km gap should not be bridged');
});

test('the gap is measured between reach edges, not between repeaters', () => {
  // 30 km apart, but each reaches 8 km toward the other: a 14 km gap.
  const rings = SC.wrapShapes(circles([offset(40.7, -74.0, 0, 0), offset(40.7, -74.0, 30000, 0)], 8000));
  assert.strictEqual(rings.length, 1);
});

test('the middle of a group is filled, and a bay narrower than 15 km too', () => {
  const tri = [offset(40.7, -74.0, 0, 0), offset(40.7, -74.0, 12000, 0), offset(40.7, -74.0, 6000, 10000)];
  const rings = SC.wrapShapes(circles(tri, 1000));
  assert.strictEqual(rings.length, 1);
  const c = offset(40.7, -74.0, 6000, 3300);
  assert.ok(SC.inRings(rings, c.lat, c.lon), 'the middle of the triangle is outside');
  // A U of members 6 km apart, 12 km across (a 10 km gap): its bay is
  // filled. One 16 km across (14 km gap, its diagonal 15.9 km) is only
  // filled as far as its corners bridge.
  const u = [[0, 0], [6000, 0], [12000, 0], [0, 6000], [12000, 6000], [0, 12000], [12000, 12000]].map(p => offset(40.7, -74.0, p[0], p[1]));
  const ur = SC.wrapShapes(circles(u, 1000));
  const bay = offset(40.7, -74.0, 6000, 9000);
  assert.ok(SC.inRings(ur, bay.lat, bay.lon), 'the bay is outside');
});

test('a lone repeater\'s spokes are wrapped: the notch between them is filled while narrower than 15 km', () => {
  // One repeater, 1 km round it, with link lobes 20 km long every 60°: what
  // the live map showed (one central repeater, a star of proven links).
  const lobe = new Float64Array(SC.sectors);
  for (let b = 0; b < 360; b += 60) for (let k = -2; k <= 2; k++) lobe[RAY(b + 5 * k + 360)] = Math.max(lobe[RAY(b + 5 * k + 360)], 20000 * (1 - Math.abs(5 * k) / 11.25));
  const shapes = [SC.shapeFor(HOME, SC.reachFor(1000, null, lobe, 1000), 1000)];
  const wrap = SC.wrapShapes(shapes), det = SC.contourShapes(shapes);
  // Between two spokes, 30° off each: 6 km out the gap is 6 km wide, 22 km
  // out (past the tips) 22 km.
  const near = offset(HOME.lat, HOME.lon, 6000 * Math.sin(Math.PI / 6), 6000 * Math.cos(Math.PI / 6));
  assert.ok(!SC.inRings(det, near.lat, near.lon), 'detailed fills the notch');
  assert.ok(SC.inRings(wrap, near.lat, near.lon), 'wrap leaves the notch between spokes open');
  const far = offset(HOME.lat, HOME.lon, 19000 * Math.sin(Math.PI / 6), 19000 * Math.cos(Math.PI / 6));
  assert.ok(!SC.inRings(wrap, far.lat, far.lon), 'wrap fills between spokes where they are 19 km apart');
  assert.ok(reachToward(wrap, HOME, 0) >= 18000, 'the spoke itself is cut short');
});

test('a long link lobe stays a lobe: no big triangle toward its tip', () => {
  const lobe = plain(SC.lobeOf(SC.linkReach([HOME, EAST], [two('h0', 'e1')]).links.get('h0')));
  const shapes = [SC.shapeFor(HOME, SC.reachFor(1000, null, lobe, 1000), 1000), SC.shapeFor(NORTH, null, 1000)];
  const wrap = SC.wrapShapes(shapes), hull = SC.scopeHull(shapes);
  const between = offset(HOME.lat, HOME.lon, 11000, 3000);
  assert.ok(SC.inRings(hull, between.lat, between.lon), 'the general view fills it (the contrast this view is for)');
  assert.ok(!SC.inRings(wrap, between.lat, between.lon), 'wrap filled the triangle to the lobe tip');
  assert.ok(reachToward(wrap, HOME, 90) > 20000, 'the lobe itself is kept');
});

test('wrap contains what each member reaches, and 1 km round every member', () => {
  const rnd = prng(11);
  const shapes = [];
  for (let i = 0; i < 25; i++) {
    const p = offset(40.7, -74.0, (rnd() - 0.5) * 60000, (rnd() - 0.5) * 60000);
    const cut = new Float64Array(SC.sectors).fill(30000);
    for (let k = 0; k < 20; k++) cut[Math.floor(rnd() * SC.sectors)] = 500;
    shapes.push(Object.assign(SC.shapeFor(p, SC.reachFor(1000 + rnd() * 9000, cut, null, 1000), 1000), { _p: p }));
  }
  const wrap = SC.wrapShapes(shapes);
  for (const s of shapes) assertKmAround(wrap, s._p, 'member');
  // Every point a member reaches on both rays either side of it (2% in,
  // which is as close as a grid outline is drawn) is inside the wrap.
  // Between a ray cut to the floor and a long one the shape is a sliver
  // narrower than a grid cell, and the terrain there is not known anyway.
  const reaches = (s, q) => {
    const kx = 111320 * Math.cos(s.lat * Math.PI / 180);
    const dx = (q.lon - s.lon) * kx, dy = (q.lat - s.lat) * 111320, d = Math.sqrt(dx * dx + dy * dy);
    let b = Math.atan2(dx, dy); if (b < 0) b += 2 * Math.PI;
    const i = Math.floor(b / (2 * Math.PI / SC.sectors)) % SC.sectors;
    return d < Math.min(s.ext[i], s.ext[(i + 1) % SC.sectors]) * 0.98;
  };
  let checked = 0;
  for (let k = 0; k < 3000; k++) {
    const q = offset(40.7, -74.0, (rnd() - 0.5) * 80000, (rnd() - 0.5) * 80000);
    if (!shapes.some((s) => reaches(s, q))) continue;
    checked++;
    assert.ok(SC.inRings(wrap, q.lat, q.lon), 'a reached point is outside the wrap');
  }
  assert.ok(checked > 100, 'too few points checked: ' + checked);
});

test('wrap rings never cross themselves', () => {
  const rnd = prng(3);
  const pts = [];
  for (let i = 0; i < 40; i++) pts.push(offset(40.7, -74.0, (rnd() - 0.5) * 70000, (rnd() - 0.5) * 70000));
  const rings = SC.wrapShapes(pts.map(p => SC.shapeFor(p, SC.reachFor(1000 + rnd() * 6000, null, null, 1000), 1000)));
  assert.ok(rings.length >= 1);
  rings.forEach((r, i) => assert.ok(!selfCrosses(r), 'ring ' + i + ' crosses itself'));
});

test('co-located and collinear members do not break the wrap', () => {
  const a = offset(40.7, -74.0, 0, 0);
  assert.strictEqual(SC.wrapShapes(circles([a, a, a], 1000)).length, 1);
  const line = [0, 10000, 20000, 30000].map(x => offset(40.7, -74.0, x, 0));
  const rings = SC.wrapShapes(circles(line, 1000));
  assert.strictEqual(rings.length, 1, 'collinear members 8 km apart should be one area');
  assert.deepStrictEqual(ringPlain(SC.wrapShapes([])), []);
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
      const attrs = {};
      const el = { classList: classList(), setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: k => attrs[k] };
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

const NODES = [
  { public_key: 'a1', lat: 40.70, lon: -74.00, transported_scopes: ['#nyc'] },
  { public_key: 'a2', lat: 40.72, lon: -73.98, transported_scopes: ['#nyc', '#ny'] },
  { public_key: 'a3', lat: 40.90, lon: -73.50, declared_regions: ['nyc', 'li'] },
  { public_key: 'a4', lat: 41.30, lon: -72.90, transported_scopes: ['#ct<script>'] },
];
// Links that make #nyc one area (a1, a2 and a3 carry or declare it).
const NYC_LINKS = [two('a1', 'a2'), two('a2', 'a3')];
// The polygons drawn by the last render.
const drawnNow = o => Array.from(o.layer._layers);

test('hidden overlay computes nothing and fetches no links', () => {
  const { L, map, rec } = fakeLeaflet();
  let loads = 0;
  const o = SC.createOverlay(L, map, { loadLinks: () => { loads++; return []; } });
  o.setNodes(NODES);
  assert.strictEqual(o.stats().computed, 0);
  assert.strictEqual(rec.polygons.length, 0);
  assert.strictEqual(loads, 0);
});

test('visible overlay draws one non-interactive outline per scope (members linked) in its own SVG pane', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes(NODES); o.setLinks(NYC_LINKS);
  o.setVisible(true);
  assert.ok(rec.panes.mcScopeContoursPane, 'pane created');
  assert.ok(Number(rec.panes.mcScopeContoursPane.style.zIndex) < 600, 'pane sits under the marker pane');
  assert.strictEqual(rec.renderers, 1, 'one SVG renderer, so CSS classes apply on canvas maps');
  // ct, li, ny, nyc: carried or configured, each one area.
  assert.strictEqual(rec.polygons.length, 4);
  assert.ok(rec.polygons.every(p => !/observed|configured/.test(p.options.className)), 'no kind of area any more');
  for (const p of rec.polygons) {
    assert.strictEqual(p.options.interactive, false, 'outlines must never take pointer events');
    assert.strictEqual(p.options.pane, 'mcScopeContoursPane');
    assert.ok(p.options.renderer && p.options.renderer._svg);
  }
  // ct<script>, li, ny, nyc in name order: nyc is the fourth colour.
  assert.ok(rec.polygons.some(p => /mc-reach-c4\b/.test(p.options.className)));
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
  assert.strictEqual(nyc.nodes, 3); assert.strictEqual(nyc.carrying, 2); assert.strictEqual(nyc.hidden, false);
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
  const before = rec.polygons[rec.polygons.length - 1];
  assert.ok(reachToward(before.rings, HOME, 90) < 1100 + SC.areaMarginM, 'floor circle (and margin) before links arrive');
  resolve([{ source: 'h0', target: 'e1', bidirectional: true, heard_by_source: 1, heard_by_target: 1 }]);
  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    const after = rec.polygons[rec.polygons.length - 1];
    assert.ok(reachToward(after.rings, HOME, 90) > 18000, 'lobe after links arrive: ' + reachToward(after.rings, HOME, 90));
  });
});

test('setOnly narrows to one scope, regardless of # spelling', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes(NODES); o.setLinks(NYC_LINKS); o.setVisible(true);
  rec.polygons.length = 0;
  o.setOnly('#li');
  assert.strictEqual(rec.polygons.length, 1);
  assert.ok(/mc-reach-c2\b/.test(rec.polygons[0].options.className), 'narrowing must not recolour: li stays second of four');
  o.setOnly('');
  assert.strictEqual(rec.polygons.length, 1 + 4);
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
  assert.deepStrictEqual(list.map(s => s.scope + ':' + s.colour), ['ct<script>:1', 'li:2', 'ny:3', 'nyc:4'], 'hiding must not recolour');
  assert.ok(rec.polygons.some(p => /mc-reach-c3\b/.test(p.options.className)), 'ny keeps its colour');
});

test('unchanged members and links reuse the cache; a moved node recomputes only its scope', () => {
  const { L, map } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setVisible(true);
  o.setNodes(NODES);
  const first = o.stats().computed;
  assert.strictEqual(first, 4);
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
  o.setLinks([{ source: 'a4', target: 'a3', bidirectional: true, heard_by_source: 1, heard_by_target: 1 }]); // touches ct (a4) and nyc and li (a3)
  assert.strictEqual(o.stats().computed, base + 3);
});

test('the cache drops scopes that disappear', () => {
  const { L, map } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setVisible(true);
  o.setNodes(NODES);
  assert.strictEqual(o.stats().cached, 4);
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

console.log('\n=== scope-contours.js: terrain ===');

// Fake terrain provider: answers asynchronously, as the real one does, with
// a cut to 2 km west (225-315°) of every repeater asked about.
function fakeTerrain(opts) {
  opts = opts || {};
  const t = { calls: [], state: opts.state || 'ok', pending: [] };
  // release() answers the oldest request still waiting.
  t.release = () => t.pending.shift()();
  t.status = () => t.state;
  t.sources = [];
  t.setSource = (src) => t.sources.push(src);
  t.sourceUrl = () => opts.url || null;
  t.extentsFor = (items, onProgress) => {
    t.calls.push(items.map(it => ({ pk: it.pk, R: Math.round(it.R) })));
    const answer = () => items.forEach(it => {
      const ext = new Float64Array(SC.sectors).fill(it.R);
      for (let d = 225; d <= 315; d += 5) ext[RAY(d)] = 2000;
      onProgress(it.pk, ext);
    });
    if (opts.defer) return new Promise(r => { t.pending.push(() => { answer(); r(); }); });
    return Promise.resolve().then(answer);
  };
  return t;
}
const tick = () => new Promise(r => setTimeout(r, 0));

const T_NODES = [
  Object.assign({ transported_scopes: ['#home'] }, HOME),
  Object.assign({ transported_scopes: ['#east'] }, EAST),
  Object.assign({ default_scope: '#gone' }, FAR),
];

test('terrain is asked for the members of drawn scopes only, with each one\'s radius', () => {
  const { L, map } = fakeLeaflet();
  const t = fakeTerrain();
  const o = SC.createOverlay(L, map, Object.assign({ terrain: t }, sync));
  o.setVisible(true);
  o.setHidden(['gone']);
  o.setLinks([two('h0', 'e1')]);
  o.setNodes(T_NODES);
  return tick().then(() => {
    const asked = t.calls.flat().map(c => c.pk + ':' + c.R).sort();
    assert.deepStrictEqual(asked, ['e1:20000', 'h0:20000'], 'asked ' + asked.join(' '));
  });
});

test('the floor is 1 km by default: the overlay keeps every member 1 km inside its border', () => {
  const { L, map, rec } = fakeLeaflet();
  const t = fakeTerrain();
  t.extentsFor = (items, onP) => Promise.resolve().then(() => items.forEach(it => onP(it.pk, new Float64Array(SC.sectors).fill(100))));
  const o = SC.createOverlay(L, map, Object.assign({ terrain: t }, sync));
  o.setVisible(true);
  const ns = [Object.assign({ transported_scopes: ['#x'] }, HOME), Object.assign({ transported_scopes: ['#x'] }, EAST)];
  o.setNodes(ns);
  return tick().then(() => {
    // Unlinked: each in its own area.
    for (const n of ns) assertKmAround(drawnNow(o).find(p => SC.inRings(p.rings, n.lat, n.lon)).rings, n, n.public_key);
  });
});

test('a terrain answer reshapes that repeater\'s area', () => {
  const { L, map, rec } = fakeLeaflet();
  const t = fakeTerrain();
  const o = SC.createOverlay(L, map, Object.assign({ terrain: t }, sync));
  o.setVisible(true);
  o.setNodes([T_NODES[0], EAST]);   // EAST: no scope, but placed, so a link to it counts
  o.setLinks([two('h0', 'e1')]);    // R = 20 km
  const westBefore = () => reachToward(rec.polygons[rec.polygons.length - 1].rings, HOME, 270);
  return tick().then(() => {
    // Cut to 2 km from 225° to 315°: the area's west edge becomes the chord
    // between 220° and 320°, 20 km x sin 40° ~ 12.9 km, from 20 km, plus
    // the 2 km margin.
    const west = westBefore();
    assert.ok(Math.abs(west - 20000 * Math.sin(40 * Math.PI / 180) - SC.areaMarginM) < 400, 'west ' + west);
  });
});

test('an answer for a node that has since moved is ignored', () => {
  const { L, map, rec } = fakeLeaflet();
  const t = fakeTerrain({ defer: true });
  const o = SC.createOverlay(L, map, Object.assign({ terrain: t }, sync));
  o.setVisible(true);
  o.setLinks([two('h0', 'e1')]);
  o.setNodes([T_NODES[0], EAST]);
  const moved = Object.assign({}, T_NODES[0], { lat: HOME.lat + 0.05 });
  o.setNodes([moved, EAST]);
  t.release();   // the answer for the old position, the first request
  return tick().then(() => {
    const p = rec.polygons[rec.polygons.length - 1];
    const west = reachToward(p.rings, moved, 270);
    assert.ok(west > 10000, 'a stale terrain cut was applied: west ' + west);
  });
});

test('without a set height, the request carries the link partners to estimate it from', () => {
  const { L, map } = fakeLeaflet();
  const t = fakeTerrain();
  const seen = [];
  t.extentsFor = ((orig) => (items, onP) => { items.forEach(it => seen.push(it)); return orig(items, onP); })(t.extentsFor);
  const o = SC.createOverlay(L, map, Object.assign({ terrain: t }, sync));
  o.setVisible(true);
  o.setLinks([two('h0', 'e1')]);
  o.setNodes([T_NODES[0], EAST]);
  return tick().then(() => {
    const h = seen.filter(it => it.pk === 'h0').pop();
    assert.ok(h && !h.antennaM, 'no height was set');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(h.links)), [{ lat: EAST.lat, lon: EAST.lon }]);
  });
});

test('an operator height (longest matching prefix) is sent instead, and requests wait for it', () => {
  const { L, map } = fakeLeaflet();
  const t = fakeTerrain();
  const seen = [];
  t.extentsFor = ((orig) => (items, onP) => { items.forEach(it => seen.push(it)); return orig(items, onP); })(t.extentsFor);
  let resolveHeights;
  const o = SC.createOverlay(L, map, Object.assign({ terrain: t, loadMapConfig: () => new Promise(r => { resolveHeights = r; }) }, sync));
  o.setVisible(true);
  o.setNodes([Object.assign({}, T_NODES[0], { public_key: 'h0aaaaaaaabbbb' })]);
  assert.strictEqual(seen.length, 0, 'asked before the heights were known');
  resolveHeights({ center: [0, 0], zoom: 9, antennaHeights: { 'H0AAAAAA': 15, 'h0aaaaaaaa': 25 } });
  return tick().then(tick).then(() => {
    const h = seen.pop();
    assert.ok(h, 'never asked');
    assert.strictEqual(h.antennaM, 25, 'the longer prefix should win');
    assert.ok(!h.links, 'links sent despite a set height');
  });
});

// A case from a real mesh: a repeater whose long links are all to hilltop
// repeaters in none of its areas. Five neighbours 1 km round it keep its
// radius at 1.1 km; PEAK, 40 km east, would stretch a 44 km lobe.
const PEAK = Object.assign({ public_key: 'pk' }, offset(HOME.lat, HOME.lon, 40000, 0));
const NEARS = [0, 72, 144, 216, 288].map((d, i) => Object.assign({ public_key: 'nb' + i },
  offset(HOME.lat, HOME.lon, 1000 * Math.sin(d * Math.PI / 180), 1000 * Math.cos(d * Math.PI / 180))));
const PEAK_LINKS = NEARS.map(n => two('h0', n.public_key)).concat([two('h0', 'pk')]);
function areaOf(o, rec, scope) { o.setOnly(scope); return rec.polygons[rec.polygons.length - 1].rings; }

test('a link to a repeater outside the area does not stretch it, in both views', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setVisible(true);
  o.setLinks(PEAK_LINKS);
  o.setNodes([Object.assign({ default_scope: '#solo' }, HOME), Object.assign({ transported_scopes: ['#peak'] }, PEAK)].concat(NEARS));
  for (const view of ['hull', 'detailed']) {
    o.setView(view);
    const east = reachToward(areaOf(o, rec, 'solo'), HOME, 90);
    assert.ok(east < 1100 + SC.areaMarginM + 400, view + ': stretched toward a partner in another area, east ' + east);
  }
});

test('a link to a repeater in the same area still stretches it past the partner', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setVisible(true);
  o.setLinks(PEAK_LINKS);
  o.setNodes([Object.assign({ default_scope: '#solo' }, HOME), Object.assign({ default_scope: '#solo' }, PEAK)].concat(NEARS));
  for (const view of ['hull', 'detailed']) {
    o.setView(view);
    const rings = areaOf(o, rec, 'solo');
    const past = offset(PEAK.lat, PEAK.lon, 1500, 0);
    assert.ok(SC.inRings(rings, past.lat, past.lon), view + ': no room past the partner');
  }
});

test('a repeater in two areas is shaped for each: only partners in that area count', () => {
  // HOME is in #a and #b; PEAK, its partner, only in #b.
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setVisible(true);
  o.setLinks(PEAK_LINKS);
  o.setNodes([Object.assign({ transported_scopes: ['#a', '#b'] }, HOME),
    Object.assign({ transported_scopes: ['#c'] }, PEAK)].concat(NEARS));
  assert.ok(reachToward(areaOf(o, rec, 'a'), HOME, 90) < 1100 + SC.areaMarginM + 400, '#a: stretched toward a partner in #c');
  o.setNodes([Object.assign({ transported_scopes: ['#a', '#b'] }, HOME),
    Object.assign({ transported_scopes: ['#a'] }, PEAK)].concat(NEARS));
  assert.ok(SC.inRings(areaOf(o, rec, 'a'), PEAK.lat, PEAK.lon), '#a: its partner is outside');
  assert.ok(reachToward(areaOf(o, rec, 'b'), HOME, 90) < 1100 + SC.areaMarginM + 400, '#b: stretched toward a partner in #a only');
});

test('a repeater configured for a scope is a member like one seen carrying it: links between them stretch the area', () => {
  // #m: HOME carries it; PEAK, 40 km east and linked to HOME, is only configured for it.
  for (const view of ['hull', 'detailed']) {
    const { L, map, rec } = fakeLeaflet();
    const o = SC.createOverlay(L, map, sync);
    o.setVisible(true);
    o.setLinks(PEAK_LINKS);
    o.setNodes([Object.assign({ transported_scopes: ['#m'] }, HOME), Object.assign({ default_scope: '#m' }, PEAK)].concat(NEARS));
    o.setView(view);
    rec.polygons.length = 0;
    const rings = areaOf(o, rec, 'm');
    assert.strictEqual(rec.polygons.length, 1, view + ': one area for the scope');
    const past = offset(PEAK.lat, PEAK.lon, 1500, 0);
    assert.ok(SC.inRings(rings, past.lat, past.lon), view + ': stops short of the configured repeater');
    assert.ok(SC.inRings(rings, HOME.lat, HOME.lon), view + ': the carrying repeater outside');
    const mid = offset(HOME.lat, HOME.lon, 20000, 0);
    map.fire('mousemove', { latlng: { lat: mid.lat, lng: mid.lon } });
    assert.strictEqual(rec.tip.content, '#m · 2 nodes', view);
  }
});

test('a new link changes what the height is estimated from, so it is asked again', () => {
  const { L, map } = fakeLeaflet();
  const t = fakeTerrain();
  const o = SC.createOverlay(L, map, Object.assign({ terrain: t }, sync));
  o.setVisible(true);
  o.setNodes([T_NODES[0], EAST, NORTH]);
  o.setLinks([two('h0', 'e1')]);
  return tick().then(() => {
    const before = t.calls.flat().filter(c => c.pk === 'h0').length;
    o.setLinks([two('h0', 'e1'), two('h0', 'n1')]);
    return tick().then(() => assert.ok(t.calls.flat().filter(c => c.pk === 'h0').length > before, 'not asked again'));
  });
});

// The terrain model's antenna height is an estimate, not a fact about the
// operator's mast, and a viewer cannot change it: the click box leaves it out.
test('the click box does not show the antenna height the terrain model used', () => {
  const { L, map, rec } = fakeLeaflet();
  const t = fakeTerrain();
  const meta = { h0: { antennaM: 23.6, source: 'links' }, e1: { antennaM: 25, source: 'set' } };
  t.extentsFor = ((orig) => (items, onP) => orig(items, (pk, ext) => onP(pk, ext, meta[pk] || { antennaM: 10, source: 'default' })))(t.extentsFor);
  const o = SC.createOverlay(L, map, Object.assign({ terrain: t }, sync));
  o.setVisible(true);
  o.setNodes([T_NODES[0], Object.assign({ transported_scopes: ['#home'] }, EAST), Object.assign({ transported_scopes: ['#home'] }, NORTH)]);
  return tick().then(() => {
    map.fire('click', { latlng: { lat: HOME.lat, lng: HOME.lon }, sourceTarget: map });
    const html = rec.popup.content;
    assert.ok(/#home<\/strong>/.test(html), html);
    assert.ok(!/mast|antenna/i.test(html), 'antenna height shown: ' + html);
  });
});

// Two groups of a scope's repeaters with no two-way link between them: no
// repeater forwarding the scope is known to bridge the gap, so the area must
// not paint it.
const WEST = [{ public_key: 'w1', name: 'West One', lat: 45, lon: -100.30 }, { public_key: 'w2', name: 'West Two', lat: 45, lon: -100.29 }];
const EASTS = [{ public_key: 'x1', name: 'East One', lat: 45, lon: -100.00 }, { public_key: 'x2', name: 'East Two', lat: 45, lon: -99.99 }];
const scoped = (ns, s) => ns.map(n => Object.assign({ transported_scopes: [s] }, n));

test('unlinked groups of one scope get separate outlines, not one area over the gap, in both views', () => {
  for (const view of ['hull', 'detailed']) {
    const { L, map } = fakeLeaflet();
    const o = SC.createOverlay(L, map, Object.assign({ view }, sync));
    o.setNodes(scoped(WEST.concat(EASTS), '#us'));
    o.setLinks([two('w1', 'w2'), two('x1', 'x2')]);
    o.setVisible(true);
    let polys = drawnNow(o);
    assert.strictEqual(polys.length, 2, view + ': ' + polys.length + ' outlines');
    assert.ok(polys.every(p => !SC.inRings(p.rings, 45, -100.145)), view + ': the gap is painted');
    for (const n of WEST.concat(EASTS)) assert.ok(polys.some(p => SC.inRings(p.rings, n.lat, n.lon)), view + ': ' + n.name + ' outside');
    assert.ok(polys.every(p => p.getElement().getAttribute('data-scope') === 'us'));
    // A link across the gap joins them.
    o.setLinks([two('w1', 'w2'), two('x1', 'x2'), two('w2', 'x1')]);
    polys = drawnNow(o);
    assert.strictEqual(polys.length, 1, view + ': linked, one outline');
    assert.ok(SC.inRings(polys[0].rings, 45, -100.145), view + ': the linked gap is part of the area');
  }
});

test('a split scope is hovered and listed once, and the click box says how many groups', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  // Close enough that the two areas overlap between them, still unlinked.
  const near = [WEST[0], WEST[1], Object.assign({}, EASTS[0], { lon: -100.25 }), Object.assign({}, EASTS[1], { lon: -100.24 })];
  o.setNodes(scoped(near, '#us'));
  o.setLinks([two('w1', 'w2'), two('x1', 'x2')]);
  o.setVisible(true);
  assert.strictEqual(drawnNow(o).length, 2);
  map.fire('mousemove', { latlng: { lat: 45, lng: -100.27 } });
  assert.strictEqual(rec.tip.content, '#us · 4 nodes · 2 separate groups', rec.tip.content);
  assert.strictEqual(drawnNow(o).filter(p => p.getElement().classList.contains('is-hovered')).length, 2, 'both groups lit');
  map.fire('click', { latlng: { lat: 45, lng: -100.27 }, sourceTarget: map });
  const html = rec.popup.content;
  assert.strictEqual(html.split('#us</strong>').length - 1, 1, 'listed once: ' + html);
  assert.ok(/>0 with known config<\/span> · <span[^>]*>4 seen carrying<\/span> · <span[^>]*title="[^"]*">2 separate groups<\/span>/.test(html), html);
});

test('the click box mentions groups only when a scope is split', () => {
  const ns = scoped(WEST, '#us');
  assert.ok(!/group/.test(SC.scopePopupHtml(['us'], ns)), 'no count given');
  assert.ok(!/group/.test(SC.scopePopupHtml(['us'], ns, () => 1)), 'one group');
  assert.ok(/3 separate groups/.test(SC.scopePopupHtml(['us'], ns, () => 3)));
});

test('the list says when terrain is unavailable or off, and credits the source when it is used', () => {
  const run = (state, url) => {
    const { S } = listSandbox('#/map');
    const { L, map } = fakeLeaflet();
    const o = S.createOverlay(L, map, Object.assign({ terrain: fakeTerrain({ state, url }) }, sync));
    const el = fakeListEl();
    S.mountScopeList(el, o);
    o.setNodes(NODES); o.setVisible(true);
    return el.innerHTML;
  };
  assert.ok(/Terrain unavailable/.test(run('unavailable')));
  const off = run('off');
  assert.ok(/Terrain is off on this instance/.test(off) && !/AWS Terrain Tiles/.test(off), off);
  const ok = run('ok');
  assert.ok(/AWS Terrain Tiles/.test(ok) && !/Terrain unavailable/.test(ok), ok);
  const other = run('ok', 'https://dem.example.org/t/{z}/{x}/{y}.png');
  assert.ok(/Terrain: dem\.example\.org/.test(other) && !/AWS Terrain Tiles/.test(other), other);
});

test('the map config sets the terrain source before any terrain is asked for', () => {
  const { L, map } = fakeLeaflet();
  const t = fakeTerrain();
  const order = [];
  t.setSource = (src) => order.push(['source', JSON.parse(JSON.stringify(src))]);
  t.extentsFor = ((orig) => (items, onP) => { order.push(['ask']); return orig(items, onP); })(t.extentsFor);
  let resolve;
  const o = SC.createOverlay(L, map, Object.assign({ terrain: t, loadMapConfig: () => new Promise(r => { resolve = r; }) }, sync));
  o.setVisible(true);
  o.setNodes([T_NODES[0]]);
  resolve({ terrainTiles: { url: 'https://t.example.org/{z}/{x}/{y}.png' } });
  return tick().then(tick).then(() => {
    assert.deepStrictEqual(order[0], ['source', { url: 'https://t.example.org/{z}/{x}/{y}.png' }]);
    assert.ok(order.findIndex(x => x[0] === 'ask') > 0, 'asked for terrain before the source was set: ' + JSON.stringify(order));
  });
});

// Frames run by hand, so provider calls can be counted per frame.
function manualFrames() {
  const queue = [];
  return {
    raf: (fn) => queue.push(fn),
    run(n) {
      let p = Promise.resolve();
      for (let i = 0; i < n; i++) p = p.then(() => { queue.splice(0).forEach(f => f()); }).then(tick);
      return p;
    },
  };
}

test('terrain off: the overlay asks the provider nothing, frame after frame', () => {
  const { L, map } = fakeLeaflet();
  const t = fakeTerrain({ state: 'off' });
  let calls = 0;
  t.extentsFor = () => { calls++; return Promise.resolve(new Map()); };
  const frames = manualFrames();
  const o = SC.createOverlay(L, map, { terrain: t, raf: frames.raf, loadMapConfig: () => Promise.resolve({ terrainTiles: { disabled: true } }) });
  o.setVisible(true);
  o.setLinks([two('h0', 'e1')]);
  o.setNodes(T_NODES);
  return tick().then(() => frames.run(10)).then(() => {
    assert.strictEqual(calls, 0, calls + ' provider calls in 10 frames');
  });
});

test('a member the provider does not answer is asked once, not every frame', () => {
  const { L, map } = fakeLeaflet();
  const t = fakeTerrain();
  let calls = 0;
  t.extentsFor = () => { calls++; return Promise.resolve(new Map()); };
  const frames = manualFrames();
  const o = SC.createOverlay(L, map, { terrain: t, raf: frames.raf });
  o.setVisible(true);
  o.setLinks([two('h0', 'e1')]);
  o.setNodes(T_NODES);
  return tick().then(() => frames.run(10)).then(() => {
    assert.strictEqual(calls, 1, calls + ' provider calls in 10 frames');
  });
});

test('after destroy, nothing is drawn or asked: late answers and queued frames are dropped', () => {
  const { L, map, rec } = fakeLeaflet();
  const t = fakeTerrain();
  let calls = 0, answer = null;
  t.extentsFor = (items, onP) => {
    calls++;
    return new Promise(r => { answer = () => { items.forEach(it => onP(it.pk, new Float64Array(SC.sectors).fill(500))); r(); }; });
  };
  const frames = manualFrames();
  let linkLoads = 0;
  const o = SC.createOverlay(L, map, { terrain: t, raf: frames.raf, loadLinks: () => { linkLoads++; return [two('h0', 'e1')]; } });
  o.setVisible(true);
  o.setNodes(T_NODES);
  return tick().then(() => frames.run(1)).then(() => {
    assert.ok(calls >= 1 && answer, 'terrain was asked for');
    const asked = calls, loadsBefore = linkLoads;
    const drawn = rec.polygons.length;
    o.destroy();
    answer();
    return tick().then(() => frames.run(5)).then(() => {
      assert.strictEqual(calls, asked, (calls - asked) + ' provider calls after destroy');
      assert.strictEqual(rec.polygons.length, drawn, 'drew after destroy');
      o.setNodes(T_NODES.slice(0, 1));
      return frames.run(2);
    }).then(() => {
      assert.strictEqual(calls, asked, 'setNodes after destroy asked the provider');
      assert.strictEqual(rec.polygons.length, drawn, 'setNodes after destroy drew');
      assert.strictEqual(linkLoads, loadsBefore, 'setNodes after destroy reloaded the links');
    });
  });
});

console.log('\n=== scope-contours.js: hover ===');

test('hovering names every scope under the cursor, highlights them, and escapes names', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setNodes(NODES); o.setLinks(NYC_LINKS); o.setVisible(true);
  // a2 carries both #nyc and #ny: their outlines overlap there.
  map.fire('mousemove', { latlng: { lat: 40.72, lng: -73.98 } });
  assert.strictEqual(rec.tipOpen, true);
  // #nyc: a1 and a2 carry it, a3 declares it.
  assert.ok(/#nyc · 3 nodes/.test(rec.tip.content), rec.tip.content);
  assert.ok(/#ny · 1 node\b/.test(rec.tip.content), rec.tip.content);
  assert.strictEqual(rec.tip.content.split('<br>').length, 2, 'one line a scope: ' + rec.tip.content);
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
  { public_key: 'p1', name: 'Tall Pine', lat: 45.0, lon: -100.0, default_scope: '#metro', transported_scopes: ['#metro'] },
  { public_key: 'p2', name: 'Alder <b>Ridge</b>', lat: 45.001, lon: -100.001, default_scope: '#metro' },
  { public_key: 'p3', name: 'Carrier', lat: 45.002, lon: -99.999, transported_scopes: ['#metro', '#downtown'] },
  { public_key: 'p4', name: 'Nowhere', configured_scope: '#metro' },
  { public_key: 'p5', name: 'Other', lat: 41.0, lon: -74.0, default_scope: '#nj' },
];

test('clicking inside outlines lists each scope\'s repeaters with why they are there', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setNodes(POP_NODES); o.setVisible(true);
  map.fire('click', { latlng: { lat: 45.001, lng: -100.000 }, sourceTarget: map });
  assert.ok(rec.popup && rec.popup._onMap, 'popup not opened');
  const html = rec.popup.content;
  assert.ok(/#metro<\/strong>(<\/span>)* <span class="mc-scope-pop-sum"><span title="[^"]*">3 with known config<\/span> · <span title="[^"]*">2 seen carrying<\/span>/.test(html), html);
  // A carrying repeater is configured too: the first count says what is
  // known, and each count says so on hover.
  assert.ok(html.includes('title="Its region list or default scope has been reported">3 with known config'), html);
  assert.ok(html.includes('title="Seen relaying this scope\'s traffic, so it forwards it">2 seen carrying'), html);
  assert.ok(!/\d configured ·/.test(html), 'the old wording');
  assert.ok(/#downtown<\/strong>/.test(html), 'overlapping #downtown not listed');
  assert.ok(!/#nj/.test(html), 'a scope not under the click is listed');
  // downtown, metro, nj in name order: each swatch is its area's colour.
  assert.ok(/mc-reach-c1" aria-hidden="true"><\/span> <strong>#downtown</.test(html), html);
  assert.ok(/mc-reach-c2" aria-hidden="true"><\/span> <strong>#metro</.test(html), html);
  const metro = html.split('<section').find(sec => sec.includes('#metro</strong>'));
  // Configured first (by name), then carrying-only.
  const order = ['Alder', 'Nowhere', 'Tall Pine', 'Carrier'].map(n => metro.indexOf(n));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), 'order ' + order);
  assert.ok(/Tall Pine<\/a> <span class="mc-scope-tag"[^>]*>default<\/span><span class="mc-scope-tag"[^>]*>carrying<\/span>/.test(html), 'Tall Pine tags');
  assert.ok(/Nowhere<\/a> <span class="mc-scope-tag"[^>]*>reported<\/span><span class="mc-scope-tag"[^>]*>no position<\/span>/.test(html), 'unplaced node tags');
  assert.ok(html.includes('href="#/nodes/p1"'), 'node link');
  assert.ok(html.includes('Alder &lt;b&gt;Ridge&lt;/b&gt;') && !html.includes('<b>Ridge'), 'name not escaped');
});

test('a click on another layer, or outside every outline, opens nothing', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setNodes(POP_NODES); o.setVisible(true);
  map.fire('click', { latlng: { lat: 45.001, lng: -100.000 }, sourceTarget: { _isNodeMarker: true } });
  assert.ok(!rec.popup._onMap, 'opened for a click that belongs to a node');
  map.fire('click', { latlng: { lat: 10, lng: 10 }, sourceTarget: map });
  assert.ok(!rec.popup._onMap, 'opened outside the outlines');
});

test('the popup pauses hover, and hiding the overlay closes it', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setNodes(POP_NODES); o.setVisible(true);
  map.fire('click', { latlng: { lat: 45.001, lng: -100.000 } });
  assert.ok(rec.popup._onMap);
  map.fire('mousemove', { latlng: { lat: 45.001, lng: -100.000 } });
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
  map.fire('mousemove', { latlng: { lat: 45.001, lng: -100.000 } });
  map.fire('click', { latlng: { lat: 45.001, lng: -100.000 }, sourceTarget: map });
  assert.ok(rec.popup._onMap);
  frames.forEach(fn => fn());
  assert.strictEqual(rec.tipOpen, false, 'tooltip drawn over the popup');
});

test('scopes with the same repeaters, listed the same way, share one popup entry', () => {
  // In a busy area a few repeaters each carry many scopes, so a click
  // there was 11 entries, most of them the same list.
  const ns = [
    { public_key: 'r1', name: 'Tall Pine', lat: 45.0, lon: -100.0, transported_scopes: ['#a', '#b', '#c'], default_scope: '#c', declared_regions: ['a', 'b', 'c', 'd'] },
    { public_key: 'r2', name: 'Alder Ridge', lat: 45.0, lon: -100.01, transported_scopes: ['#a', '#b'], declared_regions: ['a', 'b', 'd'] },
  ];
  const html = SC.scopePopupHtml(['a', 'c', 'b', 'd'], ns);
  const sections = html.split('<section class="mc-scope-pop-scope">').slice(1);
  assert.strictEqual(sections.length, 3, html);
  assert.ok(/#a<\/strong>[\s\S]*#b<\/strong>/.test(sections[0]) && !/#c</.test(sections[0]), '#a and #b together, first: ' + sections[0]);
  assert.ok(/#c<\/strong>/.test(sections[1]) && !/#b</.test(sections[1]), '#c alone: it is its default');
  assert.ok(/#d<\/strong>/.test(sections[2]) && !/#a</.test(sections[2]), '#d alone: the same repeaters, but declared, not carrying');
  assert.strictEqual((sections[0].match(/<li><a /g) || []).length, 2, 'the shared list once');
  assert.strictEqual((sections[0].match(/mc-scope-swatch/g) || []).length, 2, 'a swatch per scope');
});

test('the popup lists its scopes by name, whatever order they were drawn in', () => {
  const ns = [
    { public_key: 'r1', name: 'Tall Pine', lat: 45.0, lon: -100.0, transported_scopes: ['#us-pa', '#us', '#METRO', '#northeast'], default_scope: '#metro' },
    { public_key: 'r2', name: 'Alder Ridge', lat: 45.0, lon: -100.01, transported_scopes: ['#us-pa', '#us'], default_scope: '#northeast' },
  ];
  const html = SC.scopePopupHtml(['us-pa', 'metro', 'northeast', 'us', 'METRO'], ns);
  const heads = html.split('<section class="mc-scope-pop-scope">').slice(1)
    .map(s => (s.match(/#[^<]+(?=<\/strong>)/g) || []).join(' '));
  assert.deepStrictEqual(heads, ['#METRO', '#metro', '#northeast', '#us #us-pa']);
});

test('the popup lists at most 50 rows per scope, then says how many more', () => {
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ public_key: 'm' + i, name: 'R' + String(i).padStart(2, '0'), lat: 45.0, lon: -100.0 + i * 0.00001, default_scope: '#big' });
  const html = SC.scopePopupHtml(['big'], many);
  assert.strictEqual((html.match(/<li><a /g) || []).length, 50);
  assert.ok(html.includes('+10 more'), 'no overflow line');
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
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'public', 'scope-geometry.js'), 'utf8'), ctx);
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
  assert.ok(/data-scope="nyc" checked> <span class="mc-scope-swatch mc-reach-c4"/.test(el.innerHTML), el.innerHTML);
  assert.ok(el.innerHTML.includes('data-scope="ct&lt;script&gt;"') && !el.innerHTML.includes('<script>'), 'scope name not escaped');
  assert.ok(!/--configured/.test(el.innerHTML), 'a configured-only scope looks like any other');
  assert.ok(/title="#nyc: 3 nodes, 2 seen carrying it"/.test(el.innerHTML), el.innerHTML);
  assert.ok(/title="#li: 1 node, none seen carrying it yet"/.test(el.innerHTML), el.innerHTML);
  assert.ok(/#nyc <span class="mc-scope-count">3<\/span>/.test(el.innerHTML) && /#li <span class="mc-scope-count">1<\/span>/.test(el.innerHTML), el.innerHTML);
});

test('unchecking a row hides the scope, stores it, and writes it to the URL', () => {
  const { S, ctx, store } = listSandbox('#/map?contours=1');
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
  o.setNodes(NODES); o.setLinks(NYC_LINKS); o.setVisible(true);
  rec.polygons.length = 0;
  el.fire('click', button('data-scope-none'));
  assert.strictEqual(rec.polygons.length, 0);
  assert.strictEqual(JSON.parse(JSON.stringify(o.hidden())).length, 4);
  el.fire('click', button('data-scope-all'));
  assert.strictEqual(rec.polygons.length, 4, 'one area per scope');
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

console.log('\n=== scope-contours.js: area views ===');

test('views are hull (default) and detailed', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(SC.views)), ['hull', 'detailed']);
  const { L, map } = fakeLeaflet();
  assert.strictEqual(SC.createOverlay(L, map, {}).view(), 'hull');
  assert.strictEqual(SC.createOverlay(L, map, { view: 'detailed' }).view(), 'detailed');
  for (const gone of ['general', 'wrap', 'bogus']) assert.strictEqual(SC.createOverlay(L, map, { view: gone }).view(), 'hull', gone);
});

// Two members of one scope 30 km apart, 1 km reach each: a 28 km gap, which
// the hull spans and the detailed view, filling only gaps under 15 km, does
// not.
const GAP_NODES = [
  Object.assign({ public_key: 'g1', transported_scopes: ['#gap'] }, offset(40.7, -74.0, 0, 0)),
  Object.assign({ public_key: 'g2', transported_scopes: ['#gap'] }, offset(40.7, -74.0, 30000, 0)),
];
const GAP_MID = offset(40.7, -74.0, 15000, 0);

// Unlinked, so two groups: neither view draws the 28 km gap between them,
// and switching view redraws them.
test('setView redraws in that view; an unlinked pair stays two areas in both', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setNodes(GAP_NODES); o.setVisible(true);
  const hull = drawnNow(o).map(p => JSON.stringify(p.rings));
  assert.strictEqual(hull.length, 2, 'hull: two areas');
  assert.ok(drawnNow(o).every(p => !SC.inRings(p.rings, GAP_MID.lat, GAP_MID.lon)), 'hull drew the gap');
  o.setView('detailed');
  assert.strictEqual(o.view(), 'detailed');
  assert.strictEqual(drawnNow(o).length, 2, 'detailed: two areas');
  assert.ok(drawnNow(o).every(p => !hull.includes(JSON.stringify(p.rings))), 'detailed redrew');
  assert.ok(drawnNow(o).every(p => !SC.inRings(p.rings, GAP_MID.lat, GAP_MID.lon)), 'detailed drew the gap');
  // Hover follows the drawn view.
  map.fire('mousemove', { latlng: { lat: GAP_MID.lat, lng: GAP_MID.lon } });
  assert.strictEqual(rec.tipOpen, false, 'hovering the gap names the scope');
  map.fire('mousemove', { latlng: { lat: GAP_NODES[1].lat, lng: GAP_NODES[1].lon } });
  assert.strictEqual(rec.tipOpen, true);
});

test('each view is cached: switching back computes nothing, an unknown view changes nothing', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes(NODES); o.setVisible(true);
  const hull = o.stats().computed;
  o.setView('detailed');
  const afterDetailed = o.stats().computed;
  assert.ok(afterDetailed > hull);
  o.setView('hull'); o.setView('detailed');
  assert.strictEqual(o.stats().computed, afterDetailed, 'a view seen before was recomputed');
  const drawn = rec.polygons.length;
  o.setView('wrap'); o.setView('detailed');
  assert.strictEqual(rec.polygons.length, drawn, 'no redraw for an unknown or unchanged view');
});

test('a hidden overlay computes no view; switching view closes the click box', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes(NODES);
  o.setView('detailed');
  assert.strictEqual(o.stats().computed, 0);
  o.setVisible(true);
  map.fire('click', { latlng: { lat: 40.70, lng: -74.00 }, sourceTarget: map });
  assert.strictEqual(rec.popup._onMap, true);
  o.setView('hull');
  assert.strictEqual(rec.popup._onMap, false);
});

test('the list hint says what an area is in the current view', () => {
  const { S } = listSandbox('#/map');
  const { L, map } = fakeLeaflet();
  const o = S.createOverlay(L, map, {});
  const el = fakeListEl();
  S.mountScopeList(el, o);
  o.setNodes(NODES); o.setVisible(true);
  assert.ok(/farthest reach/.test(el.innerHTML));
  o.setView('detailed');
  assert.ok(/narrower than 15 km/.test(el.innerHTML), el.innerHTML);
});

const viewButton = (v) => ({ getAttribute: k => (k === 'data-view' ? v : null) });

test('the view picker shows Convex Hull and Detailed while the overlay is shown, the current one pressed', () => {
  const { S } = listSandbox('#/map');
  const { L, map } = fakeLeaflet();
  const o = S.createOverlay(L, map, {});
  const el = fakeListEl();
  S.mountViewPicker(el, o);
  o.setNodes(NODES);
  assert.strictEqual(el.hidden, true, 'hidden while the overlay is off');
  o.setVisible(true);
  assert.strictEqual(el.hidden, false);
  assert.strictEqual((el.innerHTML.match(/data-view="/g) || []).length, 2);
  assert.ok(/class="btn active" data-view="hull" aria-pressed="true"[^>]*>Convex Hull</.test(el.innerHTML), el.innerHTML);
  assert.ok(/data-view="detailed" aria-pressed="false"[^>]*>Detailed</.test(el.innerHTML), el.innerHTML);
  assert.ok(/Area shape/.test(el.innerHTML));
  o.setVisible(false);
  assert.strictEqual(el.hidden, true);
});

test('picking a view switches it, stores it, and writes it to the URL; the default clears the URL', () => {
  const { S, ctx, store } = listSandbox('#/map?contours=1');
  const { L, map } = fakeLeaflet();
  const o = S.createOverlay(L, map, {});
  const el = fakeListEl();
  S.mountViewPicker(el, o);
  o.setNodes(NODES); o.setVisible(true);
  el.fire('click', viewButton('detailed'));
  assert.strictEqual(o.view(), 'detailed');
  assert.strictEqual(store['meshcore-scope-contours-view'], 'detailed');
  assert.ok(/[?&]contoursView=detailed\b/.test(ctx.location.hash) && /contours=1/.test(ctx.location.hash), ctx.location.hash);
  assert.ok(/class="btn active" data-view="detailed"/.test(el.innerHTML));
  el.fire('click', viewButton('hull'));
  assert.strictEqual(store['meshcore-scope-contours-view'], 'hull');
  assert.ok(!/contoursView/.test(ctx.location.hash), ctx.location.hash);
  el.fire('click', viewButton('wrap'));
  el.fire('click', { getAttribute: () => null });
  assert.strictEqual(o.view(), 'hull');
});

test('the starting view comes from the URL first, then the stored choice', () => {
  const start = (hash, stored) => {
    const { S } = listSandbox(hash, stored);
    const { L, map } = fakeLeaflet();
    const o = S.createOverlay(L, map, {});
    S.mountViewPicker(fakeListEl(), o);
    return o.view();
  };
  assert.strictEqual(start('#/map?contoursView=detailed', { 'meshcore-scope-contours-view': 'hull' }), 'detailed');
  assert.strictEqual(start('#/map', { 'meshcore-scope-contours-view': 'detailed' }), 'detailed');
  // Choices stored by the three-view picker that came before.
  assert.strictEqual(start('#/map?contoursView=wrap', { 'meshcore-scope-contours-view': 'general' }), 'hull');
  assert.strictEqual(start('#/map'), 'hull');
});

test('the view picker takes an optional heading above it', () => {
  const { S } = listSandbox('#/map');
  const { L, map } = fakeLeaflet();
  const o = S.createOverlay(L, map, {});
  const el = fakeListEl();
  S.mountViewPicker(el, o, { titleHtml: '<h3 class="legend-title">REGION SCOPES</h3>' });
  o.setNodes(NODES); o.setVisible(true);
  assert.ok(el.innerHTML.startsWith('<h3 class="legend-title">REGION SCOPES</h3>') && /Area shape/.test(el.innerHTML), el.innerHTML);
  o.setVisible(false);
  assert.strictEqual(el.innerHTML, '', 'heading hidden with the picker');
});

test('the stored view is shared by every overlay that mounts the picker', () => {
  const { S, store } = listSandbox('#/map');
  const { L, map } = fakeLeaflet();
  const onMap = S.createOverlay(L, map, {});
  const mapEl = fakeListEl();
  S.mountViewPicker(mapEl, onMap);
  onMap.setNodes(NODES); onMap.setVisible(true);
  mapEl.fire('click', viewButton('detailed'));
  const { S: S2 } = listSandbox('#/map', store);
  const again = S2.createOverlay(L, map, {});
  S2.mountViewPicker(fakeListEl(), again);
  assert.strictEqual(again.view(), 'detailed');
});

test('viewFromHash reads ?contoursView=, null when absent or unknown', () => {
  assert.strictEqual(SC.viewFromHash('#/map?contoursView=detailed'), 'detailed');
  assert.strictEqual(SC.viewFromHash('#/map?contoursView=wrap'), null);
  assert.strictEqual(SC.viewFromHash('#/map?contours=1'), null);
  assert.strictEqual(SC.viewFromHash('#/map?contoursView=x'), null);
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
  new Function('window', fs.readFileSync(path.join(REPO_ROOT, 'public', 'scope-geometry.js'), 'utf8'))(win);
  new Function('window', 'escapeHtml', fs.readFileSync(path.join(REPO_ROOT, 'public', 'scope-contours.js'), 'utf8'))(win, sandbox.escapeHtml);
  return win.ScopeContours;
})();

// 2,000 nodes in 32 scopes, with 2,800 links shaped like a real mesh.
function perfMesh() {
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
    edges.push({ source: a.public_key, target: b.public_key, bidirectional: true, heard_by_source: 1, heard_by_target: 1 });
  }
  return { nodes, edges };
}

// Same shape as test-hop-path-inference.js: let the JIT settle, then the
// median of 5 full rebuilds (a fresh overlay each, so nothing is cached),
// then one rebuild of the same nodes, cached.
function timeRebuild(view) {
  const { nodes, edges } = perfMesh();
  const { L, map } = fakeLeaflet();
  for (let w = 0; w < 2; w++) { const warm = SCmain.createOverlay(L, map, { view }); warm.setVisible(true); warm.setLinks(edges); warm.setNodes(nodes); }
  const times = [];
  let o = null;
  for (let r = 0; r < 5; r++) {
    o = SCmain.createOverlay(L, map, { view });
    o.setVisible(true);
    o.setLinks(edges);
    const t0 = process.hrtime.bigint();
    o.setNodes(nodes);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const t1 = process.hrtime.bigint();
  o.setNodes(nodes.slice());
  return { median: times[2], cachedMs: Number(process.hrtime.bigint() - t1) / 1e6, computed: o.stats().computed, links: edges.length };
}

// Targets per view; the assertion allows twice that for slower CI runners.
// Detailed rose from 260 ms when lobes started counting only toward
// partners in the same area: none of this mesh's partners are in one (2% on
// a real 190-node instance), so members merge into fewer clusters (512 grids
// rather than 296) and small reaches get finer cells (11.2M vertices rather
// than 4.9M).
// This mesh links no member to another, so since each linked group gets its
// own area every member is a lone outline: 2,000 of them, not 32. That is
// the worst case (a carrying repeater got the packet from a hop that also
// forwards the scope, so real members link). Hull stays near its ~20 ms
// (~28 ms) through one hull per lone shape without a sort and a mitred
// point at each shallow margin corner; Detailed fell from ~185 to ~105 ms,
// its grids now one small group each.
[['hull', 30], ['detailed', 400]].forEach(([view, target]) => {
  test('2,000 nodes with 2,800 mesh-shaped links across 32 scopes, ' + view + ' view: median rebuild within budget', () => {
    const r = timeRebuild(view);
    console.log('     (median ' + r.median.toFixed(1) + ' ms over 5 runs (target ' + target + ' ms) for ' + r.computed + ' outlines over ' + r.links + ' links; cached rebuild ' + r.cachedMs.toFixed(1) + ' ms)');
    assert.ok(r.computed >= 32);
    assert.ok(r.median < 2 * target, 'median ' + r.median.toFixed(1) + ' ms');
  });
});

['hull', 'detailed'].forEach((view) => test('a hover hit test over 32 outlines takes under 1 ms, ' + view + ' view', () => {
  const rnd = prng(7);
  const nodes = [];
  for (let i = 0; i < 2000; i++) {
    const p = offset(40.7, -74.0, (rnd() - 0.5) * 200000, (rnd() - 0.5) * 200000);
    nodes.push({ public_key: 'k' + i, lat: p.lat, lon: p.lon, transported_scopes: ['#s' + Math.floor(rnd() * 32)], declared_regions: ['s' + Math.floor(rnd() * 32)] });
  }
  const { L, map } = fakeLeaflet();
  const o = SCmain.createOverlay(L, map, { raf: fn => fn(), view });
  o.setVisible(true); o.setNodes(nodes);
  const N = 200;
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < N; k++) map.fire('mousemove', { latlng: { lat: 40.7 + (k % 20) * 0.01, lng: -74.0 + (k % 7) * 0.01 } });
  const per = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log('     (' + per.toFixed(3) + ' ms per hit test)');
  assert.ok(per < 1, per.toFixed(3) + ' ms');
}));

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
