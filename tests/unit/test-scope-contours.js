'use strict';
// Unit tests for scope-contours.js: the region contours overlay on the map
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

console.log('\n=== scope-contours.js: API ===');

test('exposes its API, and nothing of the old reach model', () => {
  assert.ok(SC, 'window.ScopeContours not defined');
  for (const fn of ['normRegion', 'nodeRegionEvidence', 'groupNodesByScope', 'memberLinks', 'linkedGroups', 'areaNote', 'colorsFor', 'createPulser', 'createOverlay', 'mountScopeList', 'hashFlag', 'hiddenFromHash']) {
    assert.strictEqual(typeof SC[fn], 'function', fn + ' not exported');
  }
  for (const gone of ['linkReach', 'lobeOf', 'reachFor', 'shapeFor', 'scopeHull', 'wrapShapes', 'contourShapes', 'mountViewPicker', 'viewFromHash', 'views']) {
    assert.strictEqual(SC[gone], undefined, gone + ' still exported');
  }
  assert.strictEqual(SC.defaultRadiusM, 4000);
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
    { public_key: 'd1', lat: 1, lon: 1, default_scope: '#phl' },
    { public_key: 'd2', lat: 1, lon: 2, configured_scope: '#phl,#nj' },
    { public_key: 'd3', lat: 1, lon: 3, default_scope: '#phl', transported_scopes: ['#phl'] },
  ]);
  const keys = g2 => JSON.parse(JSON.stringify(g2.map(n => n.public_key)));
  assert.deepStrictEqual(keys(g.get('phl').configuredOnly), ['d1', 'd2']);
  assert.deepStrictEqual(keys(g.get('phl').observed), ['d3']);
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
    { public_key: 'a', lat: 40, lon: -75.0 }, { public_key: 'b', lat: 40, lon: -74.9 },
    { public_key: 'c', lat: 40, lon: -74.5 }, { public_key: 'd', lat: 40, lon: -74.4 },
    { public_key: 'x', lat: 40, lon: -74.7 },
    { public_key: 'e', lat: 41, lon: -74.0 }, { public_key: 'f', lat: 41, lon: -74.0 },
  ];
  const peers = SC.memberLinks(ns, [
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
  assert.deepStrictEqual(keys(SC.linkedGroups(members, peers)), [['a', 'b'], ['c', 'd'], ['e', 'f']]);
  assert.deepStrictEqual(keys(SC.linkedGroups(members, null)), [['a'], ['b'], ['c'], ['d'], ['e'], ['f']], 'no links yet: each alone');
  assert.deepStrictEqual(keys(SC.linkedGroups([], peers)), []);
});

test('the click box drops a stale carrying member and tags carrying only for listed scopes', () => {
  const nodes = [
    { public_key: 'p1', name: 'Listed', lat: 40.0, lon: -75.3, configured_scope: '*,#metro', transported_scopes: ['#metro', '#east-side'] },
    { public_key: 'p2', name: 'Unlisted', lat: 40.01, lon: -75.3, transported_scopes: ['#east-side'] },
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
  assert.deepStrictEqual(plain(SC.colorsFor(['PHL', 'northeast', 'philly'])), { northeast: 1, philly: 2, PHL: 3 }, 'case aside');
  assert.strictEqual(SC.colorsFor([]).size, 0);
});

test('colorsFor: up to eight scopes all differ; more share each colour as evenly as they can', () => {
  const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.strictEqual(new Set(SC.colorsFor(eight).values()).size, 8);
  // The twelve scopes of one live instance, all overlapping. A hash of the
  // name put them on 6 colours, with 8 pairs alike; 4 is the least possible.
  const live = ['philly', 'PHL', 'northeast', 'philly-mainline', 'us-east', 'us-midatlantic',
    'us-northeast', 'prm', 'us', 'us-pa', 'us-nj', 'us-de'];
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

console.log('\n=== scope-contours.js: links ===');

const HOME = { public_key: 'h0', lat: 40.0, lon: -75.3 };
const EAST = Object.assign({ public_key: 'e1' }, offset(40.0, -75.3, 20000, 0));
const NORTH = Object.assign({ public_key: 'n1' }, offset(40.0, -75.3, 0, 6000));
const FAR = Object.assign({ public_key: 'f1' }, offset(40.0, -75.3, -30000, 0));
const plain = (m) => JSON.parse(JSON.stringify(Array.from(m)));
// Neighbor-graph edges as the API serves them: heard_by_target counts the
// target receiving the source, heard_by_source the reverse.
const two = (a, b) => ({ source: a, target: b, bidirectional: true, heard_by_source: 1, heard_by_target: 1 });
const heard = (a, b) => ({ source: a, target: b, bidirectional: false, heard_by_source: 0, heard_by_target: 1 }); // b heard a
const tick = () => new Promise(r => setTimeout(r, 0));

test('memberLinks: a link heard in either direction joins both ends', () => {
  const peers = SC.memberLinks([HOME, EAST, NORTH], [two('h0', 'e1'), heard('n1', 'h0')]);
  assert.deepStrictEqual(plain(peers).sort(), [['e1', ['h0']], ['h0', ['e1', 'n1']], ['n1', ['h0']]]);
});

test('memberLinks: ambiguous links, links of unknown direction, self links and links to unplaced nodes prove nothing', () => {
  const nowhere = { public_key: 'u1' };
  const peers = SC.memberLinks([HOME, EAST, NORTH, nowhere], [
    Object.assign(two('h0', 'e1'), { ambiguous: true }),
    { source: 'h0', target: 'n1', bidirectional: true },
    { source: 'h0', target: 'n1', bidirectional: true, heard_by_source: 0, heard_by_target: 0 },
    two('h0', 'h0'), two('h0', 'u1'), two('h0', 'zz'), null,
  ]);
  assert.strictEqual(peers.size, 0, JSON.stringify(plain(peers)));
  assert.strictEqual(SC.memberLinks([HOME], null).size, 0);
});

console.log('\n=== scope-contours.js: overlay ===');

// Recording Leaflet stub: enough of L for createOverlay.
function fakeLeaflet() {
  const rec = { polygons: [], lines: [], panes: {}, renderers: 0, tip: null, tipOpen: false, handlers: {} };
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
    polyline(lines, opts) {
      const attrs = {};
      const el = { classList: classList(), setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: k => attrs[k] };
      const p = { lines, options: opts, getElement: () => el };
      rec.lines.push(p);
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
// The layers drawn by the last render: a fill and an outline per scope.
const drawnNow = o => Array.from(o.layer._layers);
const fillsNow = o => drawnNow(o).filter(l => l.rings);
// A fill's shapes: one ring each (the polygon is [[ring], [ring], ...]).
const shapesOf = fill => fill.rings.map(poly => poly[0]);
const inFill = (fill, lat, lon) => G.inAny(shapesOf(fill), lat, lon);
const G = sandbox.window.ScopeGeometry;

test('hidden overlay computes nothing and fetches no links', () => {
  const { L, map, rec } = fakeLeaflet();
  let loads = 0;
  const o = SC.createOverlay(L, map, { loadLinks: () => { loads++; return []; } });
  o.setNodes(NODES);
  assert.strictEqual(o.stats().computed, 0);
  assert.strictEqual(rec.polygons.length, 0);
  assert.strictEqual(loads, 0);
});

test('visible overlay draws one non-interactive area per scope, a fill and an outline, in its own SVG pane', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes(NODES); o.setLinks(NYC_LINKS);
  o.setVisible(true);
  assert.ok(rec.panes.mcScopeContoursPane, 'pane created');
  assert.ok(Number(rec.panes.mcScopeContoursPane.style.zIndex) < 600, 'pane sits under the marker pane');
  assert.strictEqual(rec.renderers, 1, 'one SVG renderer, so CSS classes apply on canvas maps');
  // ct, li, ny, nyc: carried or configured, each one area.
  assert.strictEqual(rec.polygons.length, 4);
  assert.strictEqual(rec.lines.length, 4);
  for (const p of rec.polygons.concat(rec.lines)) {
    assert.strictEqual(p.options.interactive, false, 'areas must never take pointer events');
    assert.strictEqual(p.options.pane, 'mcScopeContoursPane');
    assert.ok(p.options.renderer && p.options.renderer._svg);
    assert.ok(/\bmc-scope-area\b/.test(p.options.className));
  }
  for (const p of rec.polygons) {
    assert.strictEqual(p.options.stroke, false, 'the fill has no stroke: no lines between overlapping shapes');
    assert.strictEqual(p.options.fillRule, 'nonzero', 'overlapping shapes must not cancel');
    assert.ok(/\bmc-scope-fill\b/.test(p.options.className));
  }
  for (const l of rec.lines) {
    assert.strictEqual(l.options.fill, false);
    assert.ok(/\bmc-scope-line\b/.test(l.options.className));
    assert.ok(l.lines.length >= 1 && l.lines.every(x => x.length >= 2));
  }
  // ct<script>, li, ny, nyc in name order: nyc is the fourth colour.
  assert.ok(rec.polygons.some(p => /mc-reach-c4\b/.test(p.options.className)));
  assert.ok(rec.lines.some(p => /mc-reach-c4\b/.test(p.options.className)));
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

test('links are loaded once shown, and add the band between two members', () => {
  const { L, map, rec } = fakeLeaflet();
  const nodes = [Object.assign({ transported_scopes: ['#home'] }, HOME), Object.assign({ transported_scopes: ['#home'] }, EAST)];
  let loads = 0;
  let resolve;
  const o = SC.createOverlay(L, map, { loadLinks: () => { loads++; return new Promise(r => { resolve = r; }); } });
  o.setNodes(nodes);
  o.setVisible(true);
  assert.strictEqual(loads, 1);
  const mid = offset(HOME.lat, HOME.lon, 10000, 0);
  const before = rec.polygons[rec.polygons.length - 1];
  assert.strictEqual(shapesOf(before).length, 2, 'two octagons before links arrive');
  assert.ok(!inFill(before, mid.lat, mid.lon));
  resolve([two('h0', 'e1')]);
  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    const after = rec.polygons[rec.polygons.length - 1];
    assert.strictEqual(shapesOf(after).length, 3, 'and the band once they have');
    assert.ok(inFill(after, mid.lat, mid.lon), 'the band covers the midpoint');
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

test('a new link rebuilds only the scopes both its ends belong to', () => {
  const { L, map } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setVisible(true); o.setNodes(NODES); o.setLinks([]);
  const base = o.stats().computed;
  o.setLinks([two('a4', 'a3')]); // a4 is in ct only, a3 in nyc and li: no scope holds both
  assert.strictEqual(o.stats().computed, base, 'a link to a non-member changes no area');
  o.setLinks([two('a4', 'a3'), two('a1', 'a3')]); // both in nyc
  assert.strictEqual(o.stats().computed, base + 1);
});

test('scopes with the same members share one area', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setVisible(true);
  o.setNodes([Object.assign({ transported_scopes: ['#one', '#two'] }, HOME), Object.assign({ transported_scopes: ['#one', '#two'] }, EAST)]);
  assert.strictEqual(rec.polygons.length, 2);
  assert.strictEqual(o.stats().computed, 1);
  assert.strictEqual(o.stats().cached, 1);
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

console.log('\n=== scope-contours.js: schematic areas ===');

const scopedAs = (n, s) => Object.assign({ transported_scopes: [s] }, n);
const lastFill = rec => rec.polygons[rec.polygons.length - 1];
const cornerDist = (ring, n) => ring.map(p => metres(p, [n.lat, n.lon]));

test('a lone repeater is an octagon, 4 km to its corners, outlined once', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes([scopedAs(HOME, '#home')]); o.setVisible(true);
  const shapes = shapesOf(lastFill(rec));
  assert.strictEqual(shapes.length, 1);
  assert.strictEqual(shapes[0].length, 8);
  cornerDist(shapes[0], HOME).forEach(d => assert.ok(Math.abs(d - 4000) < 15, 'corner at ' + d.toFixed(0) + ' m'));
  const lines = rec.lines[rec.lines.length - 1].lines;
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].length, 9, 'a closed ring');
});

test('opts.radiusM and opts.tubeWidthM set the sizes', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, { radiusM: 1500, tubeWidthM: 600 });
  o.setNodes([scopedAs(HOME, '#home'), scopedAs(EAST, '#home')]); o.setLinks([two('h0', 'e1')]); o.setVisible(true);
  const fill = lastFill(rec);
  cornerDist(shapesOf(fill)[0], HOME).forEach(d => assert.ok(Math.abs(d - 1500) < 10, d.toFixed(0)));
  const at = (n) => { const p = offset(HOME.lat, HOME.lon, 10000, n); return inFill(fill, p.lat, p.lon); };
  assert.ok(at(250) && at(-250), 'inside a 600 m band');
  assert.ok(!at(320) && !at(-320), 'outside it');
});

test('a band joins two members that hear each other, a third of the radius wide: linked, not covered', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  o.setNodes([scopedAs(HOME, '#home'), scopedAs(EAST, '#home')]); o.setLinks([heard('h0', 'e1')]); o.setVisible(true);
  const fill = lastFill(rec);
  assert.strictEqual(shapesOf(fill).length, 3);
  const at = (n) => { const p = offset(HOME.lat, HOME.lon, 10000, n); return inFill(fill, p.lat, p.lon); };
  assert.ok(at(0) && at(600) && at(-600), 'the band is about 670 m either side');
  assert.ok(!at(700) && !at(-700) && !at(2000), 'and no wider');
  // One outline round octagon, band and octagon: no line across the joins.
  const lines = rec.lines[rec.lines.length - 1].lines;
  const shapes = shapesOf(fill);
  lines.forEach(l => l.forEach((p, i) => {
    if (!i) return;
    const m = [(l[i - 1][0] + p[0]) / 2, (l[i - 1][1] + p[1]) / 2];
    const inside = shapes.filter(r => G.inAny([r], m[0] + 1e-7, m[1] + 1e-7) && G.inAny([r], m[0] - 1e-7, m[1] - 1e-7)).length;
    assert.ok(inside === 0, 'an outline piece runs inside a shape');
  }));
});

test('no band where the octagons already meet, through a non-member, or without a known link', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, {});
  const relay = Object.assign({ public_key: 'r9' }, offset(HOME.lat, HOME.lon, 10000, 0));
  // NORTH is 6 km off: two 4 km octagons overlap. EAST is linked only
  // through r9, which is not in the scope. FAR has no link at all.
  o.setNodes([scopedAs(HOME, '#home'), scopedAs(NORTH, '#home'), scopedAs(EAST, '#home'), scopedAs(FAR, '#home'), relay]);
  o.setLinks([two('h0', 'n1'), two('h0', 'r9'), two('r9', 'e1')]);
  o.setVisible(true);
  const fill = lastFill(rec);
  assert.strictEqual(shapesOf(fill).length, 4, 'four octagons, no band');
  assert.ok(!inFill(fill, relay.lat, relay.lon), 'nothing is drawn through a repeater that does not forward the scope');
});

test('nothing is drawn until the map config has answered; then its radius, band width and per-repeater radii apply', () => {
  const { L, map, rec } = fakeLeaflet();
  let answer, asked = 0;
  const infos = [];
  const o = SC.createOverlay(L, map, { loadMapConfig: () => { asked++; return new Promise(r => { answer = r; }); } });
  o.onChange((list, visible, info) => infos.push([list.length, info.radiusM]));
  o.setNodes([scopedAs(HOME, '#home'), scopedAs(EAST, '#home'), scopedAs(Object.assign({}, FAR, { public_key: 'F1AB' }), '#home')]);
  o.setLinks([two('h0', 'e1')]);
  assert.strictEqual(asked, 0, 'not asked while hidden');
  o.setVisible(true);
  o.setNodes([scopedAs(HOME, '#home'), scopedAs(EAST, '#home'), scopedAs(Object.assign({}, FAR, { public_key: 'F1AB' }), '#home')]);
  assert.strictEqual(asked, 1, 'asked once');
  assert.strictEqual(rec.polygons.length, 0, 'drawn at the default before the config said');
  assert.deepStrictEqual(infos[infos.length - 1], [1, 4000], 'the list is there meanwhile');
  // h0 matches both 'h' and 'h0': the longer wins. Keys match in any case.
  answer({ contours: { radiusKm: 6, tubeWidthKm: 1, radii: { h: 9, H0: 2, f1: 10, zz: 3 } } });
  return tick().then(() => {
    const fill = lastFill(rec);
    const shapes = shapesOf(fill);
    assert.strictEqual(shapes.length, 4, 'three octagons and a band');
    cornerDist(shapes[0], HOME).forEach(d => assert.ok(Math.abs(d - 2000) < 10, 'h0 at its own 2 km: ' + d.toFixed(0)));
    cornerDist(shapes[1], EAST).forEach(d => assert.ok(Math.abs(d - 6000) < 20, 'e1 at the mesh-wide 6 km: ' + d.toFixed(0)));
    cornerDist(shapes[2], FAR).forEach(d => assert.ok(Math.abs(d - 10000) < 30, 'F1AB at 10 km: ' + d.toFixed(0)));
    const at = (n) => { const p = offset(HOME.lat, HOME.lon, 8000, n); return inFill(fill, p.lat, p.lon); };
    assert.ok(at(420) && !at(520), 'a 1 km band');
    assert.deepStrictEqual(infos[infos.length - 1], [1, 6000]);
    assert.strictEqual(asked, 1);
  });
});

test('config values out of range are ignored, and a failed config leaves the defaults', () => {
  const run = (cfg) => {
    const { L, map, rec } = fakeLeaflet();
    const o = SC.createOverlay(L, map, { loadMapConfig: cfg });
    o.setNodes([scopedAs(HOME, '#home')]); o.setVisible(true);
    return tick().then(() => cornerDist(shapesOf(lastFill(rec))[0], HOME)[0]);
  };
  return run(() => ({ contours: { radiusKm: 400, tubeWidthKm: -1, radii: { h0: 0.01, e1: 'big' } } }))
    .then(d => assert.ok(Math.abs(d - 4000) < 15, 'out of range: ' + d.toFixed(0)))
    .then(() => run(() => Promise.reject(new Error('offline'))))
    .then(d => assert.ok(Math.abs(d - 4000) < 15, 'failed: ' + d.toFixed(0)))
    .then(() => run(() => null))
    .then(d => assert.ok(Math.abs(d - 4000) < 15, 'no config: ' + d.toFixed(0)));
});

const WEST = [{ public_key: 'w1', name: 'West One', lat: 40, lon: -75.30 }, { public_key: 'w2', name: 'West Two', lat: 40, lon: -75.29 }];
const EASTS = [{ public_key: 'x1', name: 'East One', lat: 40, lon: -75.00 }, { public_key: 'x2', name: 'East Two', lat: 40, lon: -74.99 }];
const scoped = (ns, s) => ns.map(n => Object.assign({ transported_scopes: [s] }, n));

test('unlinked groups of one scope leave the gap between them empty; a link across it draws a band', () => {
  const { L, map, rec } = fakeLeaflet();
  const o = SC.createOverlay(L, map, sync);
  o.setNodes(scoped(WEST.concat(EASTS), '#us'));
  o.setLinks([two('w1', 'w2'), two('x1', 'x2')]);
  o.setVisible(true);
  assert.strictEqual(fillsNow(o).length, 1, 'one fill a scope');
  let fill = fillsNow(o)[0];
  assert.strictEqual(shapesOf(fill).length, 4);
  assert.ok(!inFill(fill, 40, -75.145), 'the gap is painted');
  for (const n of WEST.concat(EASTS)) assert.ok(inFill(fill, n.lat, n.lon), n.name + ' outside');
  assert.ok(drawnNow(o).every(p => p.getElement().getAttribute('data-scope') === 'us'));
  o.setLinks([two('w1', 'w2'), two('x1', 'x2'), two('w2', 'x1')]);
  fill = fillsNow(o)[0];
  assert.strictEqual(shapesOf(fill).length, 5);
  assert.ok(inFill(fill, 40, -75.145), 'the link across the gap is drawn');
  assert.ok(!inFill(fill, 40.02, -75.145), 'as a band, not as an area: 2 km off it is empty');
});

test('a split scope is hovered, pulsed and listed once, and the click box says how many groups', () => {
  const { L, map, rec } = fakeLeaflet();
  let now = 0; const timers = [];
  const o = SC.createOverlay(L, map, Object.assign({ pulseMs: 100, setTimeout: (fn, ms) => { timers.push([now + ms, fn]); return timers.length; }, clearTimeout: () => {} }, sync));
  // Close enough that the two groups' octagons overlap, still unlinked.
  const near = [WEST[0], WEST[1], Object.assign({}, EASTS[0], { lon: -75.25 }), Object.assign({}, EASTS[1], { lon: -75.24 })];
  o.setNodes(scoped(near, '#us'));
  o.setLinks([two('w1', 'w2'), two('x1', 'x2')]);
  o.setVisible(true);
  assert.strictEqual(drawnNow(o).length, 2, 'a fill and an outline');
  map.fire('mousemove', { latlng: { lat: 40, lng: -75.27 } });
  assert.strictEqual(rec.tip.content, '#us · 4 nodes · 2 separate groups', rec.tip.content);
  assert.strictEqual(drawnNow(o).filter(p => p.getElement().classList.contains('is-hovered')).length, 2, 'fill and outline lit');
  o.pulse('#us');
  assert.strictEqual(drawnNow(o).filter(p => p.getElement().classList.contains('is-pulsing')).length, 2, 'fill and outline pulse');
  map.fire('click', { latlng: { lat: 40, lng: -75.27 }, sourceTarget: map });
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

test('after destroy, nothing is drawn or asked: a late config answer and queued frames are dropped', () => {
  const { L, map, rec } = fakeLeaflet();
  let answer, linkLoads = 0;
  const frames = [];
  const o = SC.createOverlay(L, map, { raf: fn => frames.push(fn), loadMapConfig: () => new Promise(r => { answer = r; }), loadLinks: () => { linkLoads++; return [two('h0', 'e1')]; } });
  const nodes = [scopedAs(HOME, '#home'), scopedAs(EAST, '#home')];
  o.setVisible(true);
  o.setNodes(nodes);
  map.fire('mousemove', { latlng: { lat: HOME.lat, lng: HOME.lon } });
  return tick().then(() => {
    const loadsBefore = linkLoads, drawn = rec.polygons.length;
    o.destroy();
    answer({ contours: { radiusKm: 6 } });
    return tick().then(() => {
      frames.splice(0).forEach(f => f());
      assert.strictEqual(rec.polygons.length, drawn, 'drew after destroy');
      assert.strictEqual(rec.tipOpen, false, 'hovered after destroy');
      o.setNodes(nodes.slice(0, 1));
      return tick();
    }).then(() => {
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
  assert.ok(/#phl<\/strong>(<\/span>)* <span class="mc-scope-pop-sum"><span title="[^"]*">3 with known config<\/span> · <span title="[^"]*">2 seen carrying<\/span>/.test(html), html);
  // A carrying repeater is configured too: the first count says what is
  // known, and each count says so on hover.
  assert.ok(html.includes('title="Its region list or default scope has been reported">3 with known config'), html);
  assert.ok(html.includes('title="Seen relaying this scope\'s traffic, so it forwards it">2 seen carrying'), html);
  assert.ok(!/\d configured ·/.test(html), 'the old wording');
  assert.ok(/#philly<\/strong>/.test(html), 'overlapping #philly not listed');
  assert.ok(!/#nj/.test(html), 'a scope not under the click is listed');
  // nj, philly, phl in name order: the swatches match the areas, not just
  // the two scopes under the click.
  assert.ok(/mc-reach-c3" aria-hidden="true"><\/span> <strong>#phl</.test(html), html);
  assert.ok(/mc-reach-c2" aria-hidden="true"><\/span> <strong>#philly</.test(html), html);
  const phl = html.split('<section').find(sec => sec.includes('#phl</strong>'));
  // Configured first (by name), then carrying-only.
  const order = ['Amon', 'Nowhere', 'Treebeard', 'Carrier'].map(n => phl.indexOf(n));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), 'order ' + order);
  assert.ok(/Treebeard<\/a> <span class="mc-scope-tag"[^>]*>default<\/span><span class="mc-scope-tag"[^>]*>carrying<\/span>/.test(html), 'Treebeard tags');
  assert.ok(/Nowhere<\/a> <span class="mc-scope-tag"[^>]*>reported<\/span><span class="mc-scope-tag"[^>]*>no position<\/span>/.test(html), 'unplaced node tags');
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

test('scopes with the same repeaters, listed the same way, share one popup entry', () => {
  // Near Philadelphia a few repeaters each carry many scopes, so a click
  // there was 11 entries, most of them the same list.
  const ns = [
    { public_key: 'r1', name: 'Treebeard', lat: 40.0, lon: -75.3, transported_scopes: ['#a', '#b', '#c'], default_scope: '#c', declared_regions: ['a', 'b', 'c', 'd'] },
    { public_key: 'r2', name: 'Amon Sul', lat: 40.0, lon: -75.31, transported_scopes: ['#a', '#b'], declared_regions: ['a', 'b', 'd'] },
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
    { public_key: 'r1', name: 'Treebeard', lat: 40.0, lon: -75.3, transported_scopes: ['#us-pa', '#us', '#PHL', '#northeast'], default_scope: '#phl' },
    { public_key: 'r2', name: 'Amon Sul', lat: 40.0, lon: -75.31, transported_scopes: ['#us-pa', '#us'], default_scope: '#northeast' },
  ];
  const html = SC.scopePopupHtml(['us-pa', 'phl', 'northeast', 'us', 'PHL'], ns);
  const heads = html.split('<section class="mc-scope-pop-scope">').slice(1)
    .map(s => (s.match(/#[^<]+(?=<\/strong>)/g) || []).join(' '));
  assert.deepStrictEqual(heads, ['#northeast', '#PHL', '#phl', '#us #us-pa']);
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

test('the list hint says the areas are schematic, with the radius in use', () => {
  assert.ok(/^Schematic, not measured coverage: each area is an octagon 4 km round/.test(SC.areaNote()), SC.areaNote());
  assert.ok(/octagon 2\.5 km round/.test(SC.areaNote(2500)));
  const { S } = listSandbox('#/map');
  const { L, map } = fakeLeaflet();
  const el = fakeListEl();
  const o = S.createOverlay(L, map, { loadMapConfig: () => ({ contours: { radiusKm: 7 } }) });
  S.mountScopeList(el, o);
  o.setNodes(NODES); o.setVisible(true);
  return tick().then(() => {
    assert.ok(/octagon 7 km round every repeater/.test(el.innerHTML), el.innerHTML);
    assert.ok(/thin band joining two that hear each other/.test(el.innerHTML));
    assert.ok(/Click an area to list its repeaters\./.test(el.innerHTML));
    assert.ok(!/terrain|Terrain|Convex|Detailed/.test(el.innerHTML), 'the old model is still described');
  });
});

test('an old ?contoursView= link still opens, and the stored view is not read', () => {
  const { S, store } = listSandbox('#/map?contours=1&contoursView=detailed', { 'meshcore-scope-contours-view': 'detailed' });
  assert.strictEqual(S.hashFlag('#/map?contours=1&contoursView=detailed'), true);
  const { L, map, rec } = fakeLeaflet();
  const o = S.createOverlay(L, map, {});
  S.mountScopeList(fakeListEl(), o);
  o.setNodes(NODES); o.setVisible(true);
  assert.strictEqual(rec.polygons.length, 4);
  assert.strictEqual(store['meshcore-scope-contours-view'], 'detailed', 'left alone');
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

// 2,000 nodes in 32 scopes over 200 km, with 2,800 links. Each link goes
// from a node to the nearest of 30 others picked at random (a few km to a
// few tens of km, like a real mesh), and the far end is put in the near
// end's scope too, so every link is between two members and draws a band:
// the worst case for this overlay.
function perfMesh() {
  const rnd = prng(42);
  const nodes = [];
  for (let i = 0; i < 2000; i++) {
    const p = offset(40.7, -74.0, (rnd() - 0.5) * 200000, (rnd() - 0.5) * 200000);
    // Carried, with no reported list: a list would rule out the scopes it
    // does not name, and the far ends below could not join.
    const s1 = '#s' + Math.floor(rnd() * 32), s2 = '#s' + Math.floor(rnd() * 32);
    nodes.push({ public_key: 'k' + i, lat: p.lat, lon: p.lon, transported_scopes: s1 === s2 ? [s1] : [s1, s2] });
  }
  const edges = [];
  for (let i = 0; i < 2800; i++) {
    const a = nodes[Math.floor(rnd() * 2000)];
    let b = null, best = Infinity;
    for (let c = 0; c < 30; c++) {
      const q = nodes[Math.floor(rnd() * 2000)];
      const d = (q.lat - a.lat) ** 2 + (q.lon - a.lon) ** 2;
      if (q !== a && d < best) { best = d; b = q; }
    }
    if (b.transported_scopes.indexOf(a.transported_scopes[0]) < 0) b.transported_scopes.push(a.transported_scopes[0]);
    edges.push({ source: a.public_key, target: b.public_key, bidirectional: true, heard_by_source: 1, heard_by_target: 1 });
  }
  return { nodes, edges };
}

// Same shape as test-hop-path-inference.js: let the JIT settle, then the
// median of 5 full rebuilds (a fresh overlay each, so nothing is cached),
// then one rebuild of the same nodes, cached.
function timeRebuild() {
  const { nodes, edges } = perfMesh();
  const { L, map, rec } = fakeLeaflet();
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
  const t1 = process.hrtime.bigint();
  o.setNodes(nodes.slice());
  const cachedMs = Number(process.hrtime.bigint() - t1) / 1e6;
  const shapes = rec.polygons.slice(-32).reduce((n, p) => n + p.rings.length, 0);
  return { median: times[2], cachedMs, computed: o.stats().computed, links: edges.length, shapes };
}

// The assertion allows twice the target locally and four times it on CI
// (GitHub sets CI=true): shared runners measured the old hull view at 29-79
// ms against a 30 ms target, which failed nightly builds at random.
// The model this replaced took ~28 ms (hull) and ~300 ms (Detailed, with
// path-loss reach) on its own benchmark mesh, before any terrain tile was
// fetched or walked.
const PERF_HEADROOM = process.env.CI ? 4 : 2;
const PERF_TARGET_MS = 60;
test('2,000 nodes with 2,800 links between members across 32 scopes: median rebuild within budget', () => {
  const r = timeRebuild();
  console.log('     (median ' + r.median.toFixed(1) + ' ms over 5 runs (target ' + PERF_TARGET_MS + ' ms, limit ' + PERF_HEADROOM * PERF_TARGET_MS + ') for ' + r.computed + ' areas, ' + r.shapes + ' shapes, over ' + r.links + ' links; cached rebuild ' + r.cachedMs.toFixed(1) + ' ms)');
  assert.ok(r.computed >= 32);
  assert.ok(r.shapes > 4000, 'bands were drawn: ' + r.shapes + ' shapes');
  assert.ok(r.median < PERF_HEADROOM * PERF_TARGET_MS, 'median ' + r.median.toFixed(1) + ' ms, limit ' + PERF_HEADROOM * PERF_TARGET_MS + ' ms');
  assert.ok(r.cachedMs < r.median, 'the cached rebuild is not cheaper');
});

test('a hover hit test over 32 areas takes under 1 ms', () => {
  const { nodes, edges } = perfMesh();
  const { L, map } = fakeLeaflet();
  const o = SCmain.createOverlay(L, map, { raf: fn => fn() });
  o.setVisible(true); o.setLinks(edges); o.setNodes(nodes);
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
