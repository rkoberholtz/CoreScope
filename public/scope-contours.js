/* Region scope reach contours for the map and live pages.

   For each MeshCore region scope, outline the general area its nodes reach:
   one area per scope and kind. Two kinds:

   - observed: nodes whose full pubkey appears in the path of traffic for the
     scope (transported_scopes, #1751/#1902). Drawn solid.
   - configured only: nodes configured for the region (configuredScopes: its
     default scope, the regions an observer reported it allows, or its own
     declared list) but not seen carrying it. Drawn dashed, because
     configuration is not evidence of reach.

   A node's reach, in 72 directions (reachFor):
     max( min(R, terrain cut), link lobe, 1 km floor )
   - R, how far it regularly reaches, comes from its proven two-way links in
     the neighbor graph (linkReach): the 75th percentile of their distances
     × 1.1, 1-20 km; 1 km for a node with no links.
   - The terrain cut is where line of sight over elevation data ends in that
     direction (terrain-reach.js). Real radios reach roughly a circle, trimmed
     where a ridge or valley shadows the ground.
   - Each proven link still stretches its own bearing out to it, tapering over
     ±11.25°, so evidence always beats the model.
   Interpolating between the 72 directions keeps the shape smooth.

   A scope's outline is its general area: the convex hull of its members'
   reach shapes (scopeHull), everything between their farthest edges
   included. The hull contains every member's whole shape, so no member is
   closer to the border than the 1 km floor. Hulls are cached per scope and
   recomputed only when its members, their positions or their reach change.

   Hover and click are hit-tested from the map's own events, not from the
   outlines: the live map draws canvases above them, and overlapping scopes
   should all be named. Hover names the scopes under the cursor; a click
   lists the repeaters configured for or carrying each of them. The outlines
   take no pointer events, so they never block a click on anything else.

   The radius rule, floor, terrain model and pulse duration are fixed for
   now; exposing them in the customizer is a follow-up. */
(function () {
  'use strict';

  // No reach is ever drawn closer than this, whatever the terrain says: a
  // repeater that carries a scope always has at least this much of the
  // region round it, edge repeaters included. Within ~1 km a LoRa signal
  // from a mast mostly gets round nearby terrain anyway.
  var DEFAULT_FLOOR_M = 1000;
  // Radius rule (linkReach): 75th percentile of two-way link distances,
  // × LINK_MARGIN, clamped; a node with no links gets NO_LINK_RADIUS_M.
  var RADIUS_PCT = 0.75;
  var MIN_RADIUS_M = 1000;
  var MAX_RADIUS_M = 20000;
  var NO_LINK_RADIUS_M = 1000;
  var DEFAULT_PULSE_MS = 1500;
  // 72 rays of 5°, the same as terrain-reach.js walks.
  var SECTORS = 72;
  var SECTOR_RAD = 2 * Math.PI / SECTORS;
  // A proven link's lobe tapers to nothing this far either side of it.
  var LOBE_HALF_RAD = 11.25 * Math.PI / 180;
  // A link proves the far node hears this one; the outline is drawn a little
  // past it so the linked node sits inside rather than on the edge.
  var LINK_MARGIN = 1.1;
  var PANE = 'mcScopeContoursPane';
  // Under overlayPane (400) and markerPane (600): outlines never cover a
  // route line or a node marker.
  var PANE_Z = 350;
  var PALETTE_SIZE = 8;
  var M_PER_DEG = 111320;
  // Points sampled per sector along each member's reach edge for the hull.
  var BOUNDARY_PER_SECTOR = 2;
  var HIDDEN_KEY = 'meshcore-scope-contours-hidden';

  // normRegion mirrors the server's normScope (scope_audit.go): strip one
  // leading '#', nothing else, so the map, the audit and the live feed spell
  // a region alike. transported_scopes and scope_name keep the '#';
  // declared_regions has it stripped by the server.
  function normRegion(s) {
    s = s == null ? '' : String(s);
    return s.charAt(0) === '#' ? s.slice(1) : s;
  }

  function nodeRegionEvidence(n, region) {
    var want = normRegion(region);
    var ev = { declared: false, observed: false };
    if (!want || !n) return ev;
    var d = Array.isArray(n.declared_regions) ? n.declared_regions : [];
    for (var i = 0; i < d.length; i++) { if (normRegion(d[i]) === want) { ev.declared = true; break; } }
    var t = Array.isArray(n.transported_scopes) ? n.transported_scopes : [];
    for (var j = 0; j < t.length; j++) { if (normRegion(t[j]) === want) { ev.observed = true; break; } }
    return ev;
  }

  // position returns [lat, lon] for a node that can be placed, else null.
  // 0,0 is the "no position" placeholder, as on the live page.
  function position(n) {
    if (!n || n.lat == null || n.lon == null) return null;
    var lat = Number(n.lat), lon = Number(n.lon);
    if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return [lat, lon];
  }

  // configuredScopes returns Map scope → { default, allowed, declared }: the
  // region scopes a node is configured for, from the three sources the API
  // carries, and which of them say so.
  //   default_scope     the scope its own adverts go out under (its
  //                     firmware default, "region default")
  //   configured_scope  the comma-separated regions an observer reported it
  //                     allows (#1865); '*' is the flood wildcard, not a region
  //   declared_regions  its own answer to a companion's regions query (#1862)
  function configuredScopes(n) {
    var out = new Map();
    function add(r, key) {
      r = normRegion(String(r).trim());
      if (!r || r === '*') return;
      var e = out.get(r);
      if (!e) { e = { default: false, allowed: false, declared: false }; out.set(r, e); }
      e[key] = true;
    }
    if (!n) return out;
    if (n.default_scope) add(n.default_scope, 'default');
    if (n.configured_scope) String(n.configured_scope).split(',').forEach(function (r) { add(r, 'allowed'); });
    (Array.isArray(n.declared_regions) ? n.declared_regions : []).forEach(function (r) { add(r, 'declared'); });
    return out;
  }

  function carriedScopes(n) {
    var out = new Set();
    (n && Array.isArray(n.transported_scopes) ? n.transported_scopes : []).forEach(function (r) {
      r = normRegion(r);
      if (r) out.add(r);
    });
    return out;
  }

  // groupNodesByScope returns Map scope → { observed: [], configuredOnly: [] }.
  // A node seen carrying a scope is observed even if it is also configured
  // for it. Unplaced nodes are left out: they cannot contribute to an outline.
  function groupNodesByScope(nodes) {
    var groups = new Map();
    function group(s) {
      var g = groups.get(s);
      if (!g) { g = { observed: [], configuredOnly: [] }; groups.set(s, g); }
      return g;
    }
    (nodes || []).forEach(function (n) {
      if (!position(n)) return;
      var observed = carriedScopes(n);
      observed.forEach(function (r) { group(r).observed.push(n); });
      configuredScopes(n).forEach(function (_, r) { if (!observed.has(r)) group(r).configuredOnly.push(n); });
    });
    return groups;
  }

  // colorIndex picks one of the --mc-reach-N colours from the scope name, so
  // a scope keeps its colour across reloads, pages and the region picker.
  function colorIndex(scope) {
    var s = normRegion(scope), h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return (h % PALETTE_SIZE) + 1;
  }

  // ── Reach ────────────────────────────────────────────────────────────────

  function angleDiff(a, b) {
    var d = (a - b) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
  }

  // percentile of an ascending array, interpolating between ranks.
  function percentile(sorted, p) {
    var f = p * (sorted.length - 1), i = Math.floor(f), t = f - i;
    return i + 1 < sorted.length ? sorted[i] + (sorted[i + 1] - sorted[i]) * t : sorted[i];
  }

  // linkReach reads what the neighbor graph proves about each node's reach.
  // Only two-way links between two placed nodes count (each end has heard
  // the other), never an ambiguous one (a hop prefix that could be several
  // nodes). O(links × SECTORS).
  //   radius: Map pk → R, how far the node regularly reaches: the 75th
  //           percentile of its link distances × 1.1, clamped to 1-20 km.
  //           It ignores one exceptional long link and a crowd of close
  //           neighbours alike.
  //   lobes:  Map pk → Float64Array(SECTORS), each link stretching its own
  //           bearing out to its distance × 1.1, tapering to nothing over
  //           ±11.25°, so a proven link always sits inside the outline.
  //   partners: Map pk → [{ lat, lon }] of the other ends, from which the
  //           terrain provider estimates the node's antenna height.
  function linkReach(nodes, edges) {
    var pos = new Map();
    (nodes || []).forEach(function (n) { var p = position(n); if (p && n.public_key) pos.set(n.public_key, p); });
    var dists = new Map(), lobes = new Map(), partners = new Map();
    function partner(pk, p) { var l = partners.get(pk); if (l) l.push({ lat: p[0], lon: p[1] }); else partners.set(pk, [{ lat: p[0], lon: p[1] }]); }
    function lobe(pk, bearing, len) {
      var e = lobes.get(pk);
      if (!e) { e = new Float64Array(SECTORS); lobes.set(pk, e); }
      for (var i = 0; i < SECTORS; i++) {
        var off = angleDiff(i * SECTOR_RAD, bearing);
        if (off >= LOBE_HALF_RAD) continue;
        var v = len * (1 - off / LOBE_HALF_RAD);
        if (v > e[i]) e[i] = v;
      }
    }
    function dist(pk, d) { var l = dists.get(pk); if (l) l.push(d); else dists.set(pk, [d]); }
    (edges || []).forEach(function (e) {
      if (!e || e.bidirectional !== true || e.ambiguous || e.source === e.target) return;
      var a = pos.get(e.source), b = pos.get(e.target);
      if (!a || !b) return;
      var cos = Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
      var dx = (b[1] - a[1]) * M_PER_DEG * cos, dy = (b[0] - a[0]) * M_PER_DEG;
      var d = Math.sqrt(dx * dx + dy * dy);
      dist(e.source, d); dist(e.target, d);
      partner(e.source, b); partner(e.target, a);
      if (!(d > 0)) return;
      var fwd = Math.atan2(dx, dy);
      lobe(e.source, fwd, d * LINK_MARGIN);
      lobe(e.target, fwd + Math.PI, d * LINK_MARGIN);
    });
    var radius = new Map();
    dists.forEach(function (l, pk) {
      l.sort(function (x, y) { return x - y; });
      var r = percentile(l, RADIUS_PCT) * LINK_MARGIN;
      radius.set(pk, Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, r)));
    });
    return { radius: radius, lobes: lobes, partners: partners };
  }

  // reachFor combines the three into per-sector reach:
  //   max( min(R, terrain cut), link lobe, floor )
  // terrain is null when there is none (yet, or the tiles failed): the
  // radius then stands unclipped.
  function reachFor(R, terrain, lobe, floorM) {
    var out = new Float64Array(SECTORS);
    for (var i = 0; i < SECTORS; i++) {
      var v = terrain ? Math.min(R, terrain[i]) : R;
      if (lobe && lobe[i] > v) v = lobe[i];
      out[i] = v > floorM ? v : floorM;
    }
    return out;
  }

  // shapeFor builds the reach shape of one node: its position plus
  // per-sector reach (ext; null for a plain circle of floorM).
  function shapeFor(n, ext, floorM) {
    var p = position(n);
    var e = new Float64Array(SECTORS);
    var max = floorM, min = Infinity;
    for (var i = 0; i < SECTORS; i++) {
      e[i] = ext && ext[i] > floorM ? ext[i] : floorM;
      if (e[i] > max) max = e[i];
      if (e[i] < min) min = e[i];
    }
    return { lat: p[0], lon: p[1], ext: e, maxExt: max, minExt: min, uniform: max === min };
  }

  // reachAt interpolates a shape's reach at a bearing between the two nearest
  // sector centres.
  function reachAt(shape, bearing) {
    if (shape.uniform) return shape.ext[0];
    var f = bearing / SECTOR_RAD;
    if (f < 0) f += SECTORS;
    var i = Math.floor(f), t = f - i;
    i %= SECTORS;
    return shape.ext[i] + (shape.ext[(i + 1) % SECTORS] - shape.ext[i]) * t;
  }

  // ── Geometry ─────────────────────────────────────────────────────────────

  // shapeEdge samples a shape's edge into a flat Float64Array [lat, lon,
  // lat, lon, ...] (no per-point arrays: a rebuild samples thousands of
  // members), with its bounding box: BOUNDARY_PER_SECTOR points per sector,
  // or one per sector for a plain circle (a 5° chord sits 0.1% inside the
  // arc). Between samples the edge bulges out by about 0.1% of the reach,
  // too little to see. Sampled once per member and shared between the
  // scopes it is in. null for an unusable shape.
  function shapeEdge(shape) {
    if (!shape || !isFinite(shape.lat) || !isFinite(shape.lon) || !(shape.minExt > 0)) return null;
    var n = SECTORS * (shape.uniform ? 1 : BOUNDARY_PER_SECTOR);
    var cos = Math.cos(shape.lat * Math.PI / 180);
    var pts = new Float64Array(2 * n), box = [Infinity, -Infinity, Infinity, -Infinity];
    for (var k = 0; k < n; k++) {
      var t = (k / n) * 2 * Math.PI, r = reachAt(shape, t);
      var la = shape.lat + r * Math.cos(t) / M_PER_DEG, lo = shape.lon + r * Math.sin(t) / (M_PER_DEG * cos);
      pts[2 * k] = la; pts[2 * k + 1] = lo;
      if (la < box[0]) box[0] = la; if (la > box[1]) box[1] = la;
      if (lo < box[2]) box[2] = lo; if (lo > box[3]) box[3] = lo;
    }
    return { pts: pts, box: box };
  }

  // hullOfEdges is the convex hull of all the edges' points as one ring of
  // [lat, lon] (Andrew's monotone chain, O(n log n)), in a local projection
  // so a degree of longitude is not taken for a degree of latitude.
  // Collinear points are dropped. Before the sort, an Akl-Toussaint filter:
  // the 8 extremes (by x, y, x+y, x-y) span a convex octagon, and nothing
  // strictly inside it can be on the hull; a member whose whole box is
  // inside is dropped without looking at its points. [] for fewer than
  // three distinct points.
  function hullOfEdges(edges) {
    edges = edges.filter(Boolean);
    var n = 0, lat0 = 0, e, i, k;
    for (e = 0; e < edges.length; e++) { n += edges[e].pts.length / 2; lat0 += (edges[e].box[0] + edges[e].box[1]) / 2; }
    if (n < 3) return [];
    var kx = Math.cos((lat0 / edges.length) * Math.PI / 180);
    var xs = new Float64Array(n), ys = new Float64Array(n), start = new Int32Array(edges.length + 1);
    for (e = 0, i = 0; e < edges.length; e++) {
      var p = edges[e].pts;
      start[e] = i;
      for (k = 0; k < p.length; k += 2, i++) { ys[i] = p[k]; xs[i] = p[k + 1] * kx; }
    }
    start[edges.length] = n;
    function cross(o, a, b) { return (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]); }
    // CCW: min y, max x-y, max x, max x+y, max y, min x-y, min x, min x+y
    var ext = [0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 1; i < n; i++) {
      var x = xs[i], y = ys[i];
      if (y < ys[ext[0]]) ext[0] = i;
      if (x - y > xs[ext[1]] - ys[ext[1]]) ext[1] = i;
      if (x > xs[ext[2]]) ext[2] = i;
      if (x + y > xs[ext[3]] + ys[ext[3]]) ext[3] = i;
      if (y > ys[ext[4]]) ext[4] = i;
      if (x - y < xs[ext[5]] - ys[ext[5]]) ext[5] = i;
      if (x < xs[ext[6]]) ext[6] = i;
      if (x + y < xs[ext[7]] + ys[ext[7]]) ext[7] = i;
    }
    var poly = [];
    ext.forEach(function (v) { if (poly[poly.length - 1] !== v && poly[0] !== v) poly.push(v); });
    var m = poly.length;
    function strictlyInside(px, py) {
      if (m < 3) return false;
      for (var j = 0; j < m; j++) {
        var a = poly[j], b = poly[(j + 1) % m];
        if ((xs[b] - xs[a]) * (py - ys[a]) - (ys[b] - ys[a]) * (px - xs[a]) <= 0) return false;
      }
      return true;
    }
    var ord = [];
    for (e = 0; e < edges.length; e++) {
      var bx = edges[e].box;
      if (strictlyInside(bx[2] * kx, bx[0]) && strictlyInside(bx[3] * kx, bx[0]) &&
          strictlyInside(bx[2] * kx, bx[1]) && strictlyInside(bx[3] * kx, bx[1])) continue;
      for (i = start[e]; i < start[e + 1]; i++) if (!strictlyInside(xs[i], ys[i])) ord.push(i);
    }
    ord.sort(function (a, b) { return xs[a] - xs[b] || ys[a] - ys[b]; });
    var hull = [], len = ord.length;
    for (k = 0; k < len; k++) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], ord[k]) <= 0) hull.pop();
      hull.push(ord[k]);
    }
    var lowerLen = hull.length + 1;
    for (k = len - 2; k >= 0; k--) {
      while (hull.length >= lowerLen && cross(hull[hull.length - 2], hull[hull.length - 1], ord[k]) <= 0) hull.pop();
      hull.push(ord[k]);
    }
    hull.pop();
    return hull.length >= 3 ? hull.map(function (j) { return [ys[j], xs[j] / kx]; }) : [];
  }

  // convexHull of [lat, lon] points as one ring: the same hull, for callers
  // with plain points.
  function convexHull(points) {
    if (!points || points.length < 3) return [];
    var pts = new Float64Array(points.length * 2), box = [Infinity, -Infinity, Infinity, -Infinity];
    points.forEach(function (p, i) {
      pts[2 * i] = p[0]; pts[2 * i + 1] = p[1];
      if (p[0] < box[0]) box[0] = p[0]; if (p[0] > box[1]) box[1] = p[0];
      if (p[1] < box[2]) box[2] = p[1]; if (p[1] > box[3]) box[3] = p[1];
    });
    return hullOfEdges([{ pts: pts, box: box }]);
  }

  // scopeHull is a scope's general area: the convex hull of its members'
  // reach shapes, everything between their farthest edges included, as
  // rings ([] or one ring), the shape the polygon and hit tests take. It
  // contains every member's whole shape, so no member is ever closer to the
  // border than its floor.
  function scopeHull(shapes) {
    var ring = hullOfEdges((shapes || []).map(shapeEdge));
    return ring.length ? [ring] : [];
  }

  // ── Hit testing ──────────────────────────────────────────────────────────

  function ringsBounds(rings) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    rings.forEach(function (r) {
      r.forEach(function (p) {
        if (p[0] < b[0]) b[0] = p[0]; if (p[1] < b[1]) b[1] = p[1];
        if (p[0] > b[2]) b[2] = p[0]; if (p[1] > b[3]) b[3] = p[1];
      });
    });
    return b;
  }

  // inRings is an even-odd point-in-polygon test over all rings, so a point
  // in a hole is outside, matching how Leaflet fills them.
  function inRings(rings, lat, lon) {
    var inside = false;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var a = ring[i], b = ring[j];
        if ((a[0] > lat) !== (b[0] > lat) && lon < (b[1] - a[1]) * (lat - a[0]) / (b[0] - a[0]) + a[1]) inside = !inside;
      }
    }
    return inside;
  }

  // ── Pulse ────────────────────────────────────────────────────────────────

  // createPulser runs one timer per scope. A packet for a scope that is
  // already pulsing only pushes its end back, so a burst of packets costs one
  // onStart and one onEnd, never a pile of DOM work.
  function createPulser(opts) {
    var setT = opts.setTimeout || setTimeout, clearT = opts.clearTimeout || clearTimeout;
    var ms = opts.durationMs || DEFAULT_PULSE_MS;
    var timers = new Map();
    function end(s) { timers.delete(s); if (opts.onEnd) opts.onEnd(s); }
    return {
      pulse: function (scope) {
        var s = normRegion(scope);
        if (!s) return;
        var t = timers.get(s);
        if (t != null) clearT(t);
        else if (opts.onStart) opts.onStart(s);
        timers.set(s, setT(function () { end(s); }, ms));
      },
      isActive: function (scope) { return timers.has(normRegion(scope)); },
      cancelAll: function () {
        Array.from(timers.keys()).forEach(function (s) { clearT(timers.get(s)); end(s); });
      },
    };
  }

  // ── Overlay ──────────────────────────────────────────────────────────────

  // shapeKey identifies a member's shape: its pubkey and a 32-bit FNV-1a
  // hash of its position and its reach rounded to the metre. A string of 72
  // numbers per member was a measured 8% of a rebuild.
  function shapeKey(n, s) {
    var h = 2166136261;
    function mix(v) { h = Math.imul(h ^ (v | 0), 16777619); }
    mix(Math.round(s.lat * 1e6)); mix(Math.round(s.lon * 1e6));
    if (s.uniform) mix(Math.round(s.ext[0]));
    else for (var i = 0; i < SECTORS; i++) mix(Math.round(s.ext[i]));
    return n.public_key + ':' + (h >>> 0).toString(36) + (s.uniform ? 'u' : '');
  }

  function plural(n) { return n + (n === 1 ? ' node' : ' nodes'); }

  function setClass(polys, cls, on) {
    polys.forEach(function (p) {
      var el = p.getElement && p.getElement();
      if (el) el.classList[on ? 'add' : 'remove'](cls);
    });
  }

  // ── Click popup ──────────────────────────────────────────────────────────

  var POPUP_ROWS = 50;

  // scopeMembers lists every node configured for or carrying a scope, placed
  // or not (an unplaced repeater is still configured for it), configured ones
  // first, then by name. Runs on a click, over the page's node list: O(n).
  function scopeMembers(scope, nodes) {
    var out = [];
    (nodes || []).forEach(function (n) {
      var conf = configuredScopes(n).get(scope);
      var carrying = carriedScopes(n).has(scope);
      if (!conf && !carrying) return;
      out.push({ node: n, conf: conf || null, carrying: carrying, placed: !!position(n) });
    });
    var label = function (m) { return String(m.node.name || m.node.public_key || '').toLowerCase(); };
    out.sort(function (a, b) {
      if (!!a.conf !== !!b.conf) return a.conf ? -1 : 1;
      var la = label(a), lb = label(b);
      return la < lb ? -1 : (la > lb ? 1 : 0);
    });
    return out;
  }

  function tagHtml(text, title) {
    return '<span class="mc-scope-tag" title="' + title + '">' + text + '</span>';
  }

  var MAST_TITLE = {
    set: 'Antenna height set by the operator',
    links: 'Antenna height raised from its proven links: the lowest mast that gives most of them line of sight over the terrain',
    default: 'Antenna height assumed (10 m): its links do not show it needs more, or it has none',
  };

  // scopePopupHtml: one section per scope under the click, each listing its
  // repeaters with why they are listed, and the antenna height the terrain
  // model used for them (antennaOf(pk) → { antennaM, source }, when known).
  // Every name is escaped.
  function scopePopupHtml(scopes, nodes, antennaOf) {
    return '<div class="mc-scope-pop">' + scopes.map(function (scope) {
      var members = scopeMembers(scope, nodes);
      var nConf = members.filter(function (m) { return m.conf; }).length;
      var nCarry = members.filter(function (m) { return m.carrying; }).length;
      var rows = members.slice(0, POPUP_ROWS).map(function (m) {
        var n = m.node, pk = String(n.public_key || '');
        var tags = '';
        if (m.conf && m.conf.default) tags += tagHtml('default', 'Its own adverts go out scoped to this region');
        if (m.conf && m.conf.allowed) tags += tagHtml('allowed', 'An observer reported it allows this region');
        if (m.conf && m.conf.declared) tags += tagHtml('declared', 'It lists this region when asked');
        if (m.carrying) tags += tagHtml('carrying', 'Seen relaying this region\'s traffic');
        if (!m.placed) tags += tagHtml('no position', 'Has no position, so it is not part of the outline');
        var mast = antennaOf && antennaOf(pk);
        if (mast && MAST_TITLE[mast.source]) {
          tags += tagHtml((mast.source === 'links' ? '~' : '') + Math.round(mast.antennaM) + ' m mast' + (mast.source === 'set' ? ' (set)' : ''), MAST_TITLE[mast.source]);
        }
        return '<li><a href="#/nodes/' + encodeURIComponent(pk) + '">' + escapeHtml(n.name || pk.slice(0, 8)) + '</a> ' + tags + '</li>';
      }).join('');
      var more = members.length > POPUP_ROWS ? '<li class="mc-scope-pop-more">+' + (members.length - POPUP_ROWS) + ' more</li>' : '';
      return '<section class="mc-scope-pop-scope">' +
        '<div class="mc-scope-pop-head"><span class="mc-scope-swatch mc-reach-c' + colorIndex(scope) + '" aria-hidden="true"></span> ' +
        '<strong>#' + escapeHtml(scope) + '</strong> <span class="mc-scope-pop-sum">' + nConf + ' configured · ' + nCarry + ' carrying</span></div>' +
        '<ul class="mc-scope-pop-list">' + rows + more + '</ul></section>';
    }).join('') + '</div>';
  }

  // createOverlay owns the layer, the cache, hover and the pulses for one
  // Leaflet map. opts: floorM, pulseMs, loadLinks (() => Promise of neighbor
  // graph edges), terrain (a terrain-reach.js provider: extentsFor and
  // status), loadAntennaHeights (() => Promise of { pubkey or prefix:
  // metres }, operator-set antenna heights), and setTimeout/clearTimeout/raf
  // for tests.
  //   setNodes(nodes)   new node list; recomputes changed scopes when visible
  //   setLinks(edges)   neighbor graph edges the reach shapes follow
  //   setVisible(bool)  adds or removes the layer; computes lazily
  //   setOnly(scope)    draw one scope ('' = all)
  //   setHidden(names)  scopes not to draw
  //   scopes()          [{ scope, colour, observed, configured, hidden }]
  //   onChange(fn)      called after each render; returns an unsubscribe
  //   pulse(scope)      briefly highlight one scope (live page)
  //   destroy()         drop listeners and pending work
  function createOverlay(L, map, opts) {
    opts = opts || {};
    var floorM = opts.floorM || DEFAULT_FLOOR_M;
    var raf = opts.raf || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); });
    if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = String(PANE_Z);
    // Its own SVG renderer: the live map prefers canvas, which would ignore
    // the className the colours, hover and pulse are styled through.
    var renderer = L.svg({ pane: PANE });
    var layer = L.layerGroup();
    var tip = L.tooltip({ direction: 'top', offset: [0, -10], className: 'mc-scope-tip', opacity: 1 });
    var popup = L.popup({ className: 'mc-scope-popup', maxWidth: 340, autoPanPadding: [24, 24] });
    var nodes = [];
    var links = null;
    var reach = null;       // linkReach(nodes, links), rebuilt when either changes
    var shapes = new Map(); // pubkey → { shape, key, edge }, rebuilt with reach
    var edgeCache = new Map(); // shape key → sampled edge, kept across rebuilds while used
    var terrain = new Map(); // pubkey → { key, ext, meta } from the terrain provider
    var heights = null;      // operator antenna heights, { key: metres }; null until loaded
    var terrainAsked = new Set(); // pk|key requested and not yet answered
    var renderQueued = false;
    var visible = false;
    var only = '';
    var hidden = new Set();
    var cache = new Map(); // scope|kind → { sig, rings }
    var drawn = new Map(); // scope → [polygon]
    var hits = [];         // [{ scope, polys, rings, bounds, text }] for hover
    var list = [];
    var listeners = [];
    var computed = 0;
    var linksSeq = 0;
    var hovered = [];
    var moveAt = null, moveQueued = false;
    var pulser = createPulser({
      durationMs: opts.pulseMs, setTimeout: opts.setTimeout, clearTimeout: opts.clearTimeout,
      onStart: function (s) { setClass(drawn.get(s) || [], 'is-pulsing', true); },
      onEnd: function (s) { setClass(drawn.get(s) || [], 'is-pulsing', false); },
    });

    function radiusOf(n) { return (reach && reach.radius.get(n.public_key)) || NO_LINK_RADIUS_M; }
    // The operator's antenna height for a node: its pubkey, or the longest
    // configured prefix of it.
    function heightOf(n) {
      if (!heights) return 0;
      var pk = String(n.public_key || '').toLowerCase(), best = '', m = 0;
      Object.keys(heights).forEach(function (k) {
        if (k.length > best.length && pk.indexOf(k) === 0) { best = k; m = heights[k]; }
      });
      return m;
    }
    function partnersOf(n) { return (reach && reach.partners.get(n.public_key)) || []; }
    // The terrain request for a node: its position, radius, and what its
    // antenna height comes from. A result is only used while it still
    // matches, so one computed for a node list that has since moved on is
    // ignored.
    function terrainKey(n) {
      var p = position(n), h = heightOf(n);
      return p[0] + ',' + p[1] + '|' + Math.round(radiusOf(n)) + '|' +
        (h ? 'a' + h : 'L' + partnersOf(n).map(function (b) { return b.lat.toFixed(4) + ',' + b.lon.toFixed(4); }).sort().join(';'));
    }

    // A node in several scopes is shaped once.
    function shaped(n) {
      var e = shapes.get(n.public_key);
      if (!e) {
        var t = terrain.get(n.public_key);
        var cut = t && t.key === terrainKey(n) ? t.ext : null;
        var s = shapeFor(n, reachFor(radiusOf(n), cut, reach && reach.lobes.get(n.public_key), floorM), floorM);
        var key = shapeKey(n, s), edge = edgeCache.get(key);
        if (!edge) { edge = shapeEdge(s); edgeCache.set(key, edge); }
        e = { shape: s, key: key, edge: edge };
        shapes.set(n.public_key, e);
      }
      return e;
    }

    // Ask the terrain provider for the members it has not answered yet. Each
    // answer reshapes that one node and queues a render, at most one a frame.
    function requestTerrain(members) {
      if (!opts.terrain) return;
      // Wait for the operator's heights, so a set height is never first
      // computed as an estimate.
      if (opts.loadAntennaHeights && heights === null) { loadHeights(); return; }
      var items = [];
      members.forEach(function (n) {
        var k = terrainKey(n), t = terrain.get(n.public_key), ask = n.public_key + '|' + k;
        if ((t && t.key === k) || terrainAsked.has(ask)) return;
        terrainAsked.add(ask);
        var p = position(n), h = heightOf(n);
        var it = { pk: n.public_key, lat: p[0], lon: p[1], R: radiusOf(n), key: k };
        if (h) it.antennaM = h; else it.links = partnersOf(n);
        items.push(it);
      });
      if (!items.length) return;
      var keyOf = new Map(items.map(function (it) { return [it.pk, it.key]; }));
      Promise.resolve(opts.terrain.extentsFor(items, function (pk, ext, meta) {
        terrain.set(pk, { key: keyOf.get(pk), ext: ext, meta: meta || null });
        shapes.delete(pk);
        queueRender();
      })).then(done, done);
      function done() { items.forEach(function (it) { terrainAsked.delete(it.pk + '|' + it.key); }); queueRender(); }
    }

    var heightsAsked = false;
    function loadHeights() {
      if (heightsAsked) return;
      heightsAsked = true;
      Promise.resolve(opts.loadAntennaHeights()).then(function (h) {
        var clean = {};
        Object.keys(h || {}).forEach(function (k) { if (h[k] > 0) clean[String(k).toLowerCase()] = Number(h[k]); });
        heights = clean;
      }, function () { heights = {}; }).then(queueRender);
    }

    // The click box's antenna note for a node, once its terrain is known.
    function antennaOf(pk) { var t = terrain.get(pk); return t && t.meta; }

    function queueRender() {
      if (renderQueued) return;
      renderQueued = true;
      raf(function () { renderQueued = false; if (visible) render(); });
    }

    function rings(scope, kind, members) {
      var entries = members.map(shaped);
      var key = scope + '|' + kind;
      // Order-free and cheap: how many members, and the sum and xor of a hash
      // of each member's key.
      var sum = 0, xor = 0;
      entries.forEach(function (e) {
        var h = 2166136261, k = e.key;
        for (var i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
        sum = (sum + (h >>> 0)) % 4294967296; xor ^= h;
      });
      var sig = entries.length + '|' + sum + '|' + (xor >>> 0);
      var hit = cache.get(key);
      if (hit && hit.sig === sig) return hit.rings;
      computed++;
      var ring = hullOfEdges(entries.map(function (e) { return e.edge; }));
      var r = ring.length ? [ring] : [];
      cache.set(key, { sig: sig, rings: r });
      return r;
    }

    function draw(scope, kind, members, text) {
      var r = rings(scope, kind, members);
      if (!r.length) return null;
      var poly = L.polygon(r, { pane: PANE, renderer: renderer, interactive: false,
        className: 'mc-scope-area mc-scope-area-' + kind + ' mc-reach-c' + colorIndex(scope) });
      layer.addLayer(poly);
      var el = poly.getElement && poly.getElement();
      if (el && el.setAttribute) el.setAttribute('data-scope', scope);
      hits.push({ scope: scope, polys: [poly], rings: r, bounds: ringsBounds(r), text: text });
      return poly;
    }

    function render() {
      clearHover();
      layer.clearLayers();
      drawn = new Map();
      hits = [];
      var groups = visible ? groupNodesByScope(nodes) : new Map();
      if (visible && !reach) { reach = linkReach(nodes, links); shapes = new Map(); }
      var members = new Set();
      var live = new Set();
      var want = normRegion(only);
      list = [];
      groups.forEach(function (g, scope) {
        list.push({ scope: scope, colour: colorIndex(scope), observed: g.observed.length, configured: g.configuredOnly.length, hidden: hidden.has(scope) });
        if (g.observed.length) live.add(scope + '|observed');
        if (g.configuredOnly.length) live.add(scope + '|configured');
        if ((want && scope !== want) || hidden.has(scope)) return;
        g.observed.forEach(function (n) { members.add(n); });
        g.configuredOnly.forEach(function (n) { members.add(n); });
        var name = '#' + escapeHtml(scope);
        var polys = [];
        if (g.observed.length) {
          var po = draw(scope, 'observed', g.observed, name + ' · carried by ' + plural(g.observed.length));
          if (po) polys.push(po);
        }
        if (g.configuredOnly.length) {
          var pc = draw(scope, 'configured', g.configuredOnly, name + ' · configured on ' + plural(g.configuredOnly.length) + ', not yet seen carrying it');
          if (pc) polys.push(pc);
        }
        if (polys.length) drawn.set(scope, polys);
      });
      list.sort(function (a, b) { return a.scope < b.scope ? -1 : (a.scope > b.scope ? 1 : 0); });
      // Bounded by the scopes in the current node list: a scope that left it
      // leaves the cache too.
      if (visible) Array.from(cache.keys()).forEach(function (k) { if (!live.has(k)) cache.delete(k); });
      // Bounded the same way: only the edges this render used survive.
      if (visible) {
        var used = new Set();
        shapes.forEach(function (e) { used.add(e.key); });
        Array.from(edgeCache.keys()).forEach(function (k) { if (!used.has(k)) edgeCache.delete(k); });
      }
      if (visible) requestTerrain(members);
      var info = { terrain: opts.terrain ? opts.terrain.status() : 'off' };
      listeners.forEach(function (fn) { fn(list, visible, info); });
    }

    function refreshLinks() {
      if (!visible || !opts.loadLinks) return;
      var seq = ++linksSeq;
      Promise.resolve(opts.loadLinks()).then(function (edges) {
        if (seq !== linksSeq) return;
        links = Array.isArray(edges) ? edges : [];
        reach = null;
        render();
      }, function () { /* keep the floor shapes; the next reload retries */ });
    }

    // ── hover and click ──
    function hitsAt(ll) {
      var lat = ll.lat, lon = ll.lng;
      var found = [];
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i], b = h.bounds;
        if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) continue;
        if (inRings(h.rings, lat, lon)) found.push(h);
      }
      return found;
    }
    function popupOpen() { return !!(map.hasLayer && map.hasLayer(popup)); }
    function clearHover() {
      setClass(hovered, 'is-hovered', false);
      hovered = [];
      if (map.hasLayer && map.hasLayer(tip)) map.closeTooltip(tip);
    }
    function hoverAt(ll) {
      var found = hitsAt(ll);
      clearHover();
      if (!found.length) return;
      found.forEach(function (h) { hovered = hovered.concat(h.polys); });
      setClass(hovered, 'is-hovered', true);
      tip.setLatLng(ll);
      tip.setContent(found.map(function (h) { return h.text; }).join('<br>'));
      map.openTooltip(tip);
    }
    function onMove(e) {
      if (!visible || !hits.length || popupOpen()) return;
      moveAt = e.latlng;
      if (moveQueued) return;
      moveQueued = true;
      // Rechecked when the frame runs: a click is a move then a click, and
      // the popup it opens must not get a tooltip drawn over it.
      raf(function () { moveQueued = false; if (moveAt && visible && !popupOpen()) hoverAt(moveAt); });
    }
    function onOut() { moveAt = null; clearHover(); }
    // A click inside outlines lists each scope's repeaters. A click that
    // started on another layer (a live node, a packet path) bubbles here with
    // that layer as sourceTarget: it belongs to that layer, not to us.
    function onClick(e) {
      if (!visible || !hits.length) return;
      if (e.sourceTarget && e.sourceTarget !== map) return;
      var scopes = [];
      hitsAt(e.latlng).forEach(function (h) { if (scopes.indexOf(h.scope) < 0) scopes.push(h.scope); });
      if (!scopes.length) return;
      clearHover();
      popup.setLatLng(e.latlng);
      popup.setContent(scopePopupHtml(scopes, nodes, antennaOf));
      popup.openOn(map);
    }
    map.on('mousemove', onMove);
    map.on('mouseout', onOut);
    map.on('click', onClick);

    return {
      layer: layer,
      setNodes: function (l) { nodes = l || []; reach = null; render(); refreshLinks(); },
      setLinks: function (edges) { linksSeq++; links = edges || []; reach = null; render(); },
      setVisible: function (v) {
        visible = !!v;
        if (visible) { if (!map.hasLayer(layer)) layer.addTo(map); }
        else { pulser.cancelAll(); if (popupOpen()) map.closePopup(popup); if (map.hasLayer(layer)) map.removeLayer(layer); }
        render();
        if (visible && links === null) refreshLinks();
      },
      setOnly: function (scope) { only = scope || ''; render(); },
      setHidden: function (names) {
        hidden = new Set(Array.from(names || []).map(normRegion).filter(Boolean));
        render();
      },
      hidden: function () { return Array.from(hidden); },
      scopes: function () { return list.slice(); },
      isVisible: function () { return visible; },
      onChange: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
      },
      pulse: function (scope) { if (visible && drawn.has(normRegion(scope))) pulser.pulse(scope); },
      destroy: function () {
        pulser.cancelAll(); clearHover(); listeners = [];
        if (popupOpen()) map.closePopup(popup);
        map.off('mousemove', onMove); map.off('mouseout', onOut); map.off('click', onClick);
      },
      stats: function () { return { computed: computed, cached: cache.size }; },
    };
  }

  // ── Deep link and stored choice ──────────────────────────────────────────

  function hashParam(hash, key) {
    var qs = String(hash || '').split('?')[1] || '';
    return new URLSearchParams(qs).get(key);
  }

  // hashFlag reads ?contours= from a hash: true for '1', false for '0', null
  // when absent, so the caller falls back to its stored preference.
  function hashFlag(hash) {
    var v = hashParam(hash, 'contours');
    return v === '1' ? true : (v === '0' ? false : null);
  }

  // hiddenFromHash reads ?contoursHide=a,b; null when absent.
  function hiddenFromHash(hash) {
    var v = hashParam(hash, 'contoursHide');
    if (v == null) return null;
    return v.split(',').map(normRegion).filter(Boolean);
  }

  // writeHash merges updates into the URL without adding a history entry, so
  // a shared link opens with the overlay as the sender had it. '' or null
  // removes a key.
  function writeHash(updates) {
    if (!window.URLState) return;
    var h = window.URLState.updateHashParams(updates, location.hash);
    if (h !== location.hash) history.replaceState(null, '', h);
  }

  function writeHashFlag(on) { writeHash({ contours: on ? '1' : null }); }

  // initialHidden: the URL wins, then the stored choice, shared by the map
  // and live pages.
  function initialHidden(store) {
    var fromHash = hiddenFromHash(location.hash);
    if (fromHash) return fromHash;
    try {
      var v = JSON.parse(store.getItem(HIDDEN_KEY) || '[]');
      return Array.isArray(v) ? v.map(normRegion).filter(Boolean) : [];
    } catch (e) { return []; }
  }

  // ── Scope list ───────────────────────────────────────────────────────────

  var TERRAIN_NOTE = 'Each area spans the farthest reach of its repeaters, at least 1 km round each. A repeater\'s range comes from its two-way links, trimmed by line of sight over terrain and stretched to proven links. ' +
    'Antenna heights are the operator\'s where set; otherwise 10 m, raised where a repeater\'s links need more (click an outline to see them). ' +
    'Terrain: AWS Terrain Tiles (Mapzen; SRTM, USGS 3DEP and others), bare earth: buildings and trees are not in it.';
  var NO_TERRAIN_NOTE = 'Terrain unavailable: each area spans its repeaters\' range from their two-way links, stretched to proven links, with no terrain trimming.';

  function listHtml(items, opts, info) {
    var rows = items.map(function (it) {
      var name = escapeHtml(it.scope);
      var count = it.observed ? String(it.observed) : it.configured + ' configured';
      var title = it.observed
        ? '#' + name + ': carried by ' + plural(it.observed) + (it.configured ? ', configured on ' + it.configured + ' more' : '')
        : '#' + name + ': configured on ' + plural(it.configured) + ', not yet seen carrying it';
      return '<label class="mc-scope-row" title="' + title + '">' +
        '<input type="checkbox" data-scope="' + name + '"' + (it.hidden ? '' : ' checked') + '> ' +
        '<span class="mc-scope-swatch mc-reach-c' + it.colour + (it.observed ? '' : ' mc-scope-swatch--configured') + '" aria-hidden="true"></span> ' +
        '#' + name + ' <span class="mc-scope-count">' + count + '</span></label>';
    }).join('');
    return (opts.titleHtml || '') +
      '<div class="filter-group mc-scope-list-actions"><button type="button" class="btn" data-scope-all>All</button> ' +
      '<button type="button" class="btn" data-scope-none>None</button></div>' +
      rows +
      '<div class="mc-scope-hint">' + (info && info.terrain === 'unavailable' ? NO_TERRAIN_NOTE : TERRAIN_NOTE) + ' Click an outline to list its repeaters.</div>';
  }

  // mountScopeList renders a show/hide row per scope into el and keeps it in
  // step with the overlay. The choice is stored and written to the URL.
  // opts: titleHtml (heading above the rows), storage (defaults to
  // localStorage). Returns an unsubscribe.
  function mountScopeList(el, overlay, opts) {
    opts = opts || {};
    var store = opts.storage || localStorage;
    overlay.setHidden(initialHidden(store));
    function save(names) {
      overlay.setHidden(names);
      try { store.setItem(HIDDEN_KEY, JSON.stringify(overlay.hidden())); } catch (e) { /* private mode */ }
      writeHash({ contoursHide: overlay.hidden().join(',') || null });
    }
    function paint(items, visible, info) {
      el.hidden = !(visible && items.length);
      el.innerHTML = el.hidden ? '' : listHtml(items, opts, info);
    }
    el.addEventListener('change', function (e) {
      var t = e.target, s = t && t.getAttribute && t.getAttribute('data-scope');
      if (s == null) return;
      var h = new Set(overlay.hidden());
      if (t.checked) h.delete(normRegion(s)); else h.add(normRegion(s));
      save(h);
    });
    el.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.hasAttribute) return;
      if (t.hasAttribute('data-scope-all')) save([]);
      else if (t.hasAttribute('data-scope-none')) save(overlay.scopes().map(function (it) { return it.scope; }));
    });
    var off = overlay.onChange(paint);
    paint(overlay.scopes(), overlay.isVisible());
    return off;
  }

  window.ScopeContours = {
    hashFlag: hashFlag,
    hiddenFromHash: hiddenFromHash,
    writeHashFlag: writeHashFlag,
    normRegion: normRegion,
    nodeRegionEvidence: nodeRegionEvidence,
    groupNodesByScope: groupNodesByScope,
    configuredScopes: configuredScopes,
    scopePopupHtml: scopePopupHtml,
    linkReach: linkReach,
    reachFor: reachFor,
    noLinkRadius: NO_LINK_RADIUS_M,
    shapeFor: shapeFor,
    convexHull: convexHull,
    scopeHull: scopeHull,
    inRings: inRings,
    colorIndex: colorIndex,
    createPulser: createPulser,
    createOverlay: createOverlay,
    sectors: SECTORS,
    mountScopeList: mountScopeList,
  };
})();
