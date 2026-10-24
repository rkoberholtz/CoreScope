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
   - Each proven link still stretches its own bearing out past it: full
     length within 5° (one ray) of it, so the partner is inside even between
     two rays, tapering to nothing at ±11.25°. Evidence always beats the
     model.
   Interpolating between the 72 directions keeps the shape smooth.

   A scope's outline is drawn in one of two views (setView), each built from
   its members' reach shapes and each containing every member's whole shape,
   then grown by a 2 km margin with rounded corners, so no member is closer
   to the border than 3 km (the 1 km floor and the margin), and a linked
   repeater at a corner is never on the line:
   - hull: the convex hull (scopeHull), everything between their farthest
     edges included. The default.
   - detailed: shrink-wrapped (wrapShapes): their combined reach with every
     gap, bay and notch narrower than 15 km filled, between repeaters and
     between one repeater's spokes alike; groups further apart stay separate
     areas.
   Outlines are cached per view and scope, and recomputed only when its
   members, their positions or their reach change.

   Hover and click are hit-tested from the map's own events, not from the
   outlines: the live map draws canvases above them, and overlapping scopes
   should all be named. Hover names the scopes under the cursor; a click
   lists the repeaters configured for or carrying each of them. The outlines
   take no pointer events, so they never block a click on anything else.

   The radius rule, floor, margin, terrain model, wrap gap, default view and
   pulse duration are fixed for now; exposing them in the customizer is a
   follow-up. */
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
  // Every area is drawn this much past its members' reach, round its
  // corners too: a little generous, so a repeater at a corner or just past
  // a lobe's tip is not left on the line. With the floor, every member has
  // at least 3 km of area round it.
  var AREA_MARGIN_M = 2000;
  // 72 rays of 5°, the same as terrain-reach.js walks.
  var SECTORS = 72;
  var SECTOR_RAD = 2 * Math.PI / SECTORS;
  // A proven link's lobe is at full length within one ray of its bearing,
  // so both rays either side of it reach the partner, and tapers to nothing
  // this far either side of it.
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
  var VIEW_KEY = 'meshcore-scope-contours-view';
  // Area views, the default first.
  var VIEWS = ['hull', 'detailed'];
  // The widest gap the wrap view fills: a bay or a gap between two groups
  // narrower than this is part of the area, a wider one is not.
  var WRAP_GAP_M = 15000;
  // Distance-field grid (wrap and detailed views): no finer than this, and no
  // more vertices per cluster than MAX_VERTICES (the cell grows instead).
  var MIN_CELL_M = 150;
  var MAX_VERTICES = 100000;

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
  //           bearing out to its distance × 1.1: at full length on the rays
  //           within 5° of it, so interpolating between them still reaches
  //           past the partner, then tapering to nothing at ±11.25°. A
  //           proven link always sits inside the outline.
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
        var v = off <= SECTOR_RAD ? len : len * (1 - (off - SECTOR_RAD) / (LOBE_HALF_RAD - SECTOR_RAD));
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
  // border than its floor, plus marginM (rounded) when given.
  function scopeHull(shapes, marginM) {
    var ring = roundOut(hullOfEdges((shapes || []).map(shapeEdge)), marginM);
    return ring.length ? [ring] : [];
  }

  // roundOut grows a convex ring by m metres all round: each edge pushed out
  // by m, joined round each corner by an arc of radius m (the ring's
  // Minkowski sum with a disc), in steps of at most a sector. The arcs turn
  // once round in all, so they add at most SECTORS points. The ring itself
  // when m is not positive.
  function roundOut(ring, m) {
    var n = ring.length;
    if (!(m > 0) || n < 3) return ring;
    var lat0 = 0, i;
    for (i = 0; i < n; i++) lat0 += ring[i][0];
    var kx = M_PER_DEG * Math.cos((lat0 / n) * Math.PI / 180), ky = M_PER_DEG;
    var xs = new Float64Array(n), ys = new Float64Array(n), area = 0;
    for (i = 0; i < n; i++) { xs[i] = ring[i][1] * kx; ys[i] = ring[i][0] * ky; }
    for (i = 0; i < n; i++) { var j = (i + 1) % n; area += xs[i] * ys[j] - xs[j] * ys[i]; }
    // Outward is right of travel round a counter-clockwise ring, left round
    // a clockwise one.
    var s = area > 0 ? 1 : -1;
    var normal = new Float64Array(n);
    for (i = 0; i < n; i++) { var k = (i + 1) % n; normal[i] = Math.atan2(-(xs[k] - xs[i]) * s, (ys[k] - ys[i]) * s); }
    var out = [];
    for (i = 0; i < n; i++) {
      var a1 = normal[(i + n - 1) % n], d = normal[i] - a1;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d <= -Math.PI) d += 2 * Math.PI;
      var steps = Math.max(1, Math.ceil(Math.abs(d) / SECTOR_RAD));
      for (var t = 0; t <= steps; t++) {
        var a = a1 + d * t / steps;
        out.push([(ys[i] + m * Math.sin(a)) / ky, (xs[i] + m * Math.cos(a)) / kx]);
      }
    }
    return out;
  }

  // ── Distance field (wrap and detailed views) ─────────────────────────────

  // fieldGeom adds what the distance field needs to a shape, once (members'
  // shapes are cached, so once per member): box, its extent in metres
  // west/east/south/north of the node, so a lobe to the east costs a strip,
  // not a square; and near[i], the most any bearing within a sector of
  // interval i (between centres i and i+1) can reach. A vertex at least that
  // far out is outside even after the fill's half-cell widening, while that
  // widening spans no more than a sector, so the fill rates it d / near
  // without a lookup.
  function fieldGeom(shape) {
    if (shape.box) return shape;
    var max = shape.maxExt, e = shape.ext;
    if (shape.uniform) { shape.box = [-max, max, -max, max]; return shape; }
    // 2 points per sector. Between samples the boundary can bulge by about
    // 0.1% of the reach, which the 2-cell margin the fill adds covers.
    var b = [0, 0, 0, 0], n = SECTORS * 2;
    for (var k = 0; k < n; k++) {
      var t = (k / n) * 2 * Math.PI, r = reachAt(shape, t);
      var x = r * Math.sin(t), y = r * Math.cos(t);
      if (x < b[0]) b[0] = x; if (x > b[1]) b[1] = x;
      if (y < b[2]) b[2] = y; if (y > b[3]) b[3] = y;
    }
    shape.box = b;
    var near = new Float64Array(SECTORS);
    for (var i = 0; i < SECTORS; i++) {
      near[i] = Math.max(e[(i + SECTORS - 1) % SECTORS], e[i], e[(i + 1) % SECTORS], e[(i + 2) % SECTORS]);
    }
    shape.near = near;
    return shape;
  }

  // bearingOf is atan2(dx, dy), the compass bearing of an offset, as a
  // polynomial: error under 2.1e-4 rad (0.012°, measured), far below what a
  // 5° sector blend can show, at a fraction of Math.atan2's cost in the
  // per-vertex fill.
  function bearingOf(dx, dy) {
    var ax = Math.abs(dy), ay = Math.abs(dx);
    var hi = ax > ay ? ax : ay;
    if (hi === 0) return 0;
    var a = (ax < ay ? ax : ay) / hi, q = a * a;
    var r = ((-0.0464964749 * q + 0.15931422) * q - 0.327622764) * q * a + a;
    if (ay > ax) r = 1.5707963267948966 - r;
    if (dy < 0) r = Math.PI - r;
    return dx < 0 ? -r : r;
  }

  // clusters splits shapes into groups that can share an outline: shapes
  // whose reach comes within joinM of each other (centres within the sum of
  // their longest reaches plus joinM), so each group gets its own compact
  // grid and projection. Spatial hash with cells at least that wide: only
  // the 3x3 neighbourhood is checked, so this is linear in the count.
  function clusters(shapes, joinM) {
    var maxAbsLat = 0, maxExt = 0;
    shapes.forEach(function (s) { maxAbsLat = Math.max(maxAbsLat, Math.abs(s.lat)); maxExt = Math.max(maxExt, s.maxExt); });
    var reach = 2 * maxExt + joinM;
    var latCell = reach / M_PER_DEG;
    // The smallest cos in the set makes every cell at least that wide
    // wherever a shape is, so no pair within reach lands two cells apart.
    var lonCell = Math.min(360, reach / (M_PER_DEG * Math.max(0.01, Math.cos(maxAbsLat * Math.PI / 180))));
    var parent = shapes.map(function (_, i) { return i; });
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    var cells = new Map();
    var keyOf = function (cy, cx) { return cy + ',' + cx; };
    shapes.forEach(function (p, i) {
      var cy = Math.floor(p.lat / latCell), cx = Math.floor(p.lon / lonCell);
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var bucket = cells.get(keyOf(cy + dy, cx + dx));
          if (!bucket) continue;
          for (var k = 0; k < bucket.length; k++) {
            var j = bucket[k], q = shapes[j];
            var cos = Math.cos(((p.lat + q.lat) / 2) * Math.PI / 180);
            var ey = (p.lat - q.lat) * M_PER_DEG, ex = (p.lon - q.lon) * M_PER_DEG * cos;
            var touch = p.maxExt + q.maxExt + joinM;
            if (ey * ey + ex * ex <= touch * touch) parent[find(i)] = find(j);
          }
        }
      }
      var own = keyOf(cy, cx);
      if (!cells.has(own)) cells.set(own, []);
      cells.get(own).push(i);
    });
    var byRoot = new Map();
    shapes.forEach(function (p, i) {
      var r = find(i);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(p);
    });
    return Array.from(byRoot.values());
  }

  // Scratch buffers shared by every grid, grown to the largest seen and
  // never past what MAX_VERTICES needs (the cell grows instead), so a
  // rebuild allocates nothing per cluster. The edge index is not cleared
  // between clusters: an entry counts only if its stamp is this call's.
  var scratch = { gen: 0 };
  function scratchBuf(name, Ctor, n) {
    if (!scratch[name] || scratch[name].length < n) scratch[name] = new Ctor(n);
    return scratch[name];
  }

  // clusterField fills the distance field of one cluster: at each grid
  // vertex, its distance / reach in that direction for the nearest shape,
  // inside where < 1. marginM: extra room round the shapes (the wrap view's
  // closing grows into it).
  function clusterField(shapes, marginM) {
    marginM = marginM || 0;
    var lat0 = 0, lon0 = 0, minExt = Infinity, maxExt = 0;
    shapes.forEach(function (s) { fieldGeom(s); lat0 += s.lat; lon0 += s.lon; if (s.minExt < minExt) minExt = s.minExt; if (s.maxExt > maxExt) maxExt = s.maxExt; });
    lat0 /= shapes.length; lon0 /= shapes.length;
    var kx = M_PER_DEG * Math.cos(lat0 * Math.PI / 180), ky = M_PER_DEG;
    var xy = shapes.map(function (s) { return [(s.lon - lon0) * kx, (s.lat - lat0) * ky]; });

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    xy.forEach(function (p, k) {
      var b = shapes[k].box;
      if (p[0] + b[0] < minX) minX = p[0] + b[0]; if (p[0] + b[1] > maxX) maxX = p[0] + b[1];
      if (p[1] + b[2] < minY) minY = p[1] + b[2]; if (p[1] + b[3] > maxY) maxY = p[1] + b[3];
    });
    // The contour is interpolated, not stepped, and errs by up to
    // (cell / reach)² / 8 of the smallest reach: a cell of 2/5 of a 1 km
    // floor, 2%; a fifth of a reach over 2.5 km, 0.5%, so a cluster of only
    // big reaches is not drawn as a coarse polygon. Finer cells cost the
    // square. A cluster holding a big shape needs no finer than 1/40 of it:
    // a 20 km reach is still ~80 cells across, at zooms where a pixel is
    // 60-150 m. The vertex cap coarsens it for a sprawling cluster.
    var cell = Math.max(MIN_CELL_M, maxExt / 40, Math.min(minExt / 2.5, Math.max(minExt / 5, 500)));
    var span = function (c) {
      // Whole cells, so a margin keeps the vertices where the detailed
      // view's grid has them and both trace an edge alike.
      var m = (2 + Math.ceil(marginM / c)) * c;
      return { nx: Math.ceil((maxX - minX + 2 * m) / c) + 1, ny: Math.ceil((maxY - minY + 2 * m) / c) + 1, m: m };
    };
    var dims = span(cell);
    // The margin does not shrink with the cell, so one pass can land just
    // over the cap; a second always lands under it.
    for (var pass = 0; pass < 2 && dims.nx * dims.ny > MAX_VERTICES; pass++) {
      cell *= Math.sqrt((dims.nx * dims.ny) / MAX_VERTICES) * 1.01;
      dims = span(cell);
    }
    var nx = dims.nx, ny = dims.ny;
    var ox = minX - dims.m, oy = minY - dims.m;

    // Each shape fills only its own box plus 2 cells: every vertex next to
    // the contour lies within that of the shape that puts it there, so the
    // rest stay "far". A uniform shape needs no bearing, and neither does a
    // vertex well inside the floor: its value only has to read as inside,
    // since no vertex a cell from it can be outside.
    var far = 3;
    var field = scratchBuf('field', Float64Array, nx * ny);
    field.fill(far, 0, nx * ny);
    var pad = 2 * cell;
    // The contour is interpolated linearly between vertices, which cuts
    // across a curve's inside: up to cell² / 8 / reach in (see the cell). Each reach is drawn that much further out, so the edge errs
    // outward by no more than that and every member keeps at least its floor
    // all round.
    var q = cell * cell / 8;
    // rowLo/rowHi: the columns each row's fill touched. A cluster's grid is
    // its bounding box, mostly empty when the shapes chain across it, and
    // outside these spans every vertex is far, so tracing only walks them.
    var rowLo = scratchBuf('rowLo', Int32Array, ny), rowHi = scratchBuf('rowHi', Int32Array, ny);
    rowLo.fill(nx, 0, ny); rowHi.fill(-1, 0, ny);
    xy.forEach(function (p, k) {
      var s = shapes[k], b = s.box;
      var i0 = Math.max(0, Math.floor((p[0] + b[0] - pad - ox) / cell)), i1 = Math.min(nx - 1, Math.ceil((p[0] + b[1] + pad - ox) / cell));
      var j0 = Math.max(0, Math.floor((p[1] + b[2] - pad - oy) / cell)), j1 = Math.min(ny - 1, Math.ceil((p[1] + b[3] + pad - oy) / cell));
      var inv = 1 / (s.minExt + q / s.minExt), lim = s.maxExt + pad, half = cell / 2;
      for (var j = j0; j <= j1; j++) {
        if (i0 < rowLo[j]) rowLo[j] = i0;
        if (i1 > rowHi[j]) rowHi[j] = i1;
        var dy = oy + j * cell - p[1];
        for (var i = i0; i <= i1; i++) {
          var dx = ox + i * cell - p[0];
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d > lim) continue;
          var r;
          // Every bearing reaches at least minExt, so inside it no bearing is
          // needed; the value is exact where the contour is the floor itself,
          // the only place a vertex this close can be next to it.
          if (s.uniform || d < s.minExt) r = d * inv;
          else {
            var bb = bearingOf(dx, dy);
            var fi = bb / SECTOR_RAD;
            if (fi < 0) fi += SECTORS;
            var nr = s.near[Math.floor(fi) % SECTORS];
            // Outside for certain, and a cell or more past any reach near
            // its bearing, so neither it nor its neighbours (a cell away,
            // within these sectors) are next to the edge: its value is
            // never interpolated, only compared, and d / nr, a lower bound
            // above 1, will do. Nearer the edge its exact value places the
            // edge; the bound would pull it outward.
            if (d >= nr + cell && d * SECTOR_RAD >= cell) r = d / nr;
            else {
              var e = reachAt(s, bb);
              // Near the node, where a lobe (about 4 sectors wide) is no
              // wider than a cell, the reach is the most within half a cell
              // either side of the bearing: without this widening the grid
              // misses the lobe's base and it comes loose from the node.
              // Further out it would push an edge slanting across the rays
              // (a ridge line) out by up to half a cell × tan(slant), so it
              // stops there.
              if (d * 4 * SECTOR_RAD < cell) {
                var del = half / d, e1 = reachAt(s, bb + del), e2 = reachAt(s, bb - del);
                if (e1 > e) e = e1;
                if (e2 > e) e = e2;
              }
              r = d / (e + q / e);
            }
          }
          var idx = j * nx + i;
          if (r < field[idx]) field[idx] = r;
        }
      }
    });
    return { field: field, nx: nx, ny: ny, ox: ox, oy: oy, cell: cell, lat0: lat0, lon0: lon0, kx: kx, ky: ky, rowLo: rowLo, rowHi: rowHi };
  }

  // Marching-squares segments per cell case, as pairs of cell edges
  // (0 bottom, 1 right, 2 top, 3 left). Corner bits: 1 bottom-left,
  // 2 bottom-right, 4 top-right, 8 top-left. Cases 5 and 10 are saddles,
  // resolved by the cell centre below.
  var CASES = [
    [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], null, [[0, 2]], [[3, 2]],
    [[2, 3]], [[0, 2]], null, [[1, 2]], [[3, 1]], [[0, 1]], [[3, 0]], [],
  ];
  // Saddle resolutions: A cuts off bottom-right and top-left, B bottom-left
  // and top-right.
  var SADDLE_A = [[0, 1], [2, 3]], SADDLE_B = [[3, 0], [1, 2]];

  // traceRings follows the field's 1-contour into closed rings of [lat, lon].
  function traceRings(g) {
    var field = g.field, nx = g.nx, ny = g.ny, ox = g.ox, oy = g.oy, cell = g.cell;
    // Edge ids: horizontal edge from vertex (i,j) to (i+1,j) is 2*(j*nx+i),
    // vertical edge from (i,j) to (i,j+1) is 2*(j*nx+i)+1. Neighbouring cells
    // share an edge id, which is what joins their segments into rings.
    function edgePoint(e) {
      var v = e >> 1, i = v % nx, j = (v - i) / nx;
      var a = field[v], b, bx = i, by = j;
      if (e & 1) { b = field[v + nx]; by = j + 1; } else { b = field[v + 1]; bx = i + 1; }
      var t = (1 - a) / (b - a);
      return [ox + (i + (bx - i) * t) * cell, oy + (j + (by - j) * t) * cell];
    }
    // segA/segB: the two endpoint edges of each segment. Every contour edge
    // belongs to exactly two segments, so first/second, indexed by edge id,
    // find a segment's neighbours without a Map or an array per edge.
    var segA = [], segB = [];
    var first = scratchBuf('first', Int32Array, 2 * nx * ny), second = scratchBuf('second', Int32Array, 2 * nx * ny);
    var stamp = scratchBuf('stamp', Int32Array, 2 * nx * ny);
    if (++scratch.gen > 0x7ffffff0) { stamp.fill(0); scratch.gen = 1; }
    var gen = scratch.gen;
    function link(e, s) {
      if (stamp[e] !== gen) { stamp[e] = gen; first[e] = s; second[e] = -1; } else second[e] = s;
    }
    // The id of side 0 bottom, 1 right, 2 top or 3 left of the cell whose
    // bottom-left vertex is v.
    function edgeId(v, side) {
      return side === 0 ? 2 * v : side === 1 ? 2 * (v + 1) + 1 : side === 2 ? 2 * (v + nx) : 2 * v + 1;
    }
    function addSeg(e1, e2) {
      var s = segA.length;
      segA.push(e1); segB.push(e2);
      link(e1, s); link(e2, s);
    }
    var rowLo = g.rowLo, rowHi = g.rowHi;
    for (var j = 0; j < ny - 1; j++) {
      var lo = Math.max(0, Math.min(rowLo[j], rowLo[j + 1]) - 1), hi = Math.min(nx - 2, Math.max(rowHi[j], rowHi[j + 1]));
      for (var i = lo; i <= hi; i++) {
        var v = j * nx + i;
        var bl = field[v], br = field[v + 1], tr = field[v + nx + 1], tl = field[v + nx];
        var c = (bl < 1 ? 1 : 0) | (br < 1 ? 2 : 0) | (tr < 1 ? 4 : 0) | (tl < 1 ? 8 : 0);
        if (c === 0 || c === 15) continue;
        var pairs = CASES[c];
        if (!pairs) {
          var centreIn = (bl + br + tr + tl) / 4 < 1;
          pairs = c === 5 ? (centreIn ? SADDLE_A : SADDLE_B) : (centreIn ? SADDLE_B : SADDLE_A);
        }
        for (var k = 0; k < pairs.length; k++) addSeg(edgeId(v, pairs[k][0]), edgeId(v, pairs[k][1]));
      }
    }

    // Join segments into closed rings. The grid border is outside every
    // shape, so each contour edge is shared by exactly two segments.
    var used = new Uint8Array(segA.length);
    var rings = [];
    for (var s0 = 0; s0 < segA.length; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      var start = segA[s0], cur = segB[s0];
      var ring = [edgePoint(start)];
      var guard = segA.length;
      while (cur !== start && guard-- > 0) {
        ring.push(edgePoint(cur));
        if (stamp[cur] !== gen) break;
        var next = first[cur];
        if (next < 0 || used[next]) next = second[cur];
        if (next < 0 || used[next]) break;
        used[next] = 1;
        cur = segA[next] === cur ? segB[next] : segA[next];
      }
      if (ring.length >= 3) {
        rings.push(ring.map(function (p) { return [g.lat0 + p[1] / g.ky, g.lon0 + p[0] / g.kx]; }));
      }
    }
    return rings;
  }

  // delaunay triangulates n distinct points (Bowyer-Watson, O(n²): a scope
  // has at most a few hundred placed members). Returns [a, b, c] index
  // triples; an index of n or more is a corner of the enclosing super
  // triangle, which the caller leaves out.
  function delaunay(xs, ys, n) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, i;
    for (i = 0; i < n; i++) {
      if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i];
      if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i];
    }
    var span = Math.max(maxX - minX, maxY - minY, 1), mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    var X = new Float64Array(n + 3), Y = new Float64Array(n + 3);
    for (i = 0; i < n; i++) { X[i] = xs[i]; Y[i] = ys[i]; }
    X[n] = mx - 20 * span; Y[n] = my - span;
    X[n + 1] = mx; Y[n + 1] = my + 20 * span;
    X[n + 2] = mx + 20 * span; Y[n + 2] = my - span;
    function tri(a, b, c) {
      var ax = X[a], ay = Y[a], bx = X[b], by = Y[b], cx = X[c], cy = Y[c];
      var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      if (d === 0) return { a: a, b: b, c: c, x: 0, y: 0, r2: Infinity };
      var a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
      var x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
      var y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
      return { a: a, b: b, c: c, x: x, y: y, r2: (ax - x) * (ax - x) + (ay - y) * (ay - y) };
    }
    var tris = [tri(n, n + 1, n + 2)];
    var N = n + 3;
    for (var p = 0; p < n; p++) {
      var px = X[p], py = Y[p], keep = [], open = new Map();
      for (var t = 0; t < tris.length; t++) {
        var T = tris[t], dx = px - T.x, dy = py - T.y;
        if (dx * dx + dy * dy < T.r2) {
          // An edge of two removed triangles is inside the hole; one of only
          // one is on its border.
          [[T.a, T.b], [T.b, T.c], [T.c, T.a]].forEach(function (e) {
            var k = e[0] < e[1] ? e[0] * N + e[1] : e[1] * N + e[0];
            if (open.has(k)) open.delete(k); else open.set(k, e);
          });
        } else keep.push(T);
      }
      open.forEach(function (e) { keep.push(tri(e[0], e[1], p)); });
      tris = keep;
    }
    return tris.map(function (T) { return [T.a, T.b, T.c]; });
  }

  // coreOf is a shape's typical reach: the median over its sectors, which a
  // link lobe a few sectors wide does not move.
  function coreOf(shape) {
    if (shape.core == null) {
      var s = Array.prototype.slice.call(shape.ext).sort(function (x, y) { return x - y; });
      shape.core = (s[(SECTORS >> 1) - 1] + s[SECTORS >> 1]) / 2;
    }
    return shape.core;
  }

  // bridgeField shrink-wraps a cluster's field in place. Its members are
  // triangulated; two neighbours whose reach comes within gapM of each other
  // along the line between them are bridged (a band between them as wide as
  // each one's typical reach there, never wider than it reaches sideways),
  // and a triangle whose three sides are all bridged is filled. Bays and
  // gaps between bridged members are filled; members further apart are not
  // joined. The members' own reach stays in the field, so the wrap only
  // adds to it.
  function bridgeField(g, shapes, gapM) {
    var field = g.field, nx = g.nx, ny = g.ny, ox = g.ox, oy = g.oy, cell = g.cell;
    var xs = [], ys = [], owner = [], seen = new Set();
    shapes.forEach(function (s) {
      var x = (s.lon - g.lon0) * g.kx, y = (s.lat - g.lat0) * g.ky;
      // Co-located members (a repeater and its twin) would break the
      // triangulation; one of them stands for both.
      var k = Math.round(x) + ',' + Math.round(y);
      if (seen.has(k)) return;
      seen.add(k); xs.push(x); ys.push(y); owner.push(s);
    });
    var n = xs.length;
    if (n < 2) return;
    function rows(j0, j1, i0, i1) {
      for (var j = j0; j <= j1; j++) {
        if (i0 < g.rowLo[j]) g.rowLo[j] = i0;
        if (i1 > g.rowHi[j]) g.rowHi[j] = i1;
      }
    }
    function clampI(v) { return Math.max(0, Math.min(nx - 1, v)); }
    function clampJ(v) { return Math.max(0, Math.min(ny - 1, v)); }
    var bridged = new Map();
    function bridge(a, b) {
      var k = a < b ? a * n + b : b * n + a;
      if (bridged.has(k)) return bridged.get(k);
      var dx = xs[b] - xs[a], dy = ys[b] - ys[a], L = Math.sqrt(dx * dx + dy * dy);
      var th = Math.atan2(dx, dy), sa = owner[a], sb = owner[b];
      var ok = L - reachAt(sa, th) - reachAt(sb, th + Math.PI) <= gapM;
      bridged.set(k, ok);
      if (!ok) return false;
      var ra = Math.min(coreOf(sa), reachAt(sa, th + Math.PI / 2), reachAt(sa, th - Math.PI / 2));
      var rb = Math.min(coreOf(sb), reachAt(sb, th + Math.PI / 2), reachAt(sb, th - Math.PI / 2));
      var ux = dx / L, uy = dy / L, pad = Math.max(ra, rb) + 2 * cell;
      var i0 = clampI(Math.floor((Math.min(xs[a], xs[b]) - pad - ox) / cell)), i1 = clampI(Math.ceil((Math.max(xs[a], xs[b]) + pad - ox) / cell));
      var j0 = clampJ(Math.floor((Math.min(ys[a], ys[b]) - pad - oy) / cell)), j1 = clampJ(Math.ceil((Math.max(ys[a], ys[b]) + pad - oy) / cell));
      for (var j = j0; j <= j1; j++) {
        var py = oy + j * cell - ys[a];
        // The columns this row crosses the band in: 0 < t < L along the
        // bridge and within pad of its line, so a diagonal bridge costs its
        // band, not its bounding box.
        var lo = ox + i0 * cell - xs[a], hi = ox + i1 * cell - xs[a];
        if (ux !== 0) {
          var t0 = (0 - py * uy) / ux, t1 = (L - py * uy) / ux;
          lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
        } else if (py * uy <= 0 || py * uy >= L) continue;
        if (uy !== 0) {
          var h0 = (py * ux - pad) / uy, h1 = (py * ux + pad) / uy;
          lo = Math.max(lo, Math.min(h0, h1)); hi = Math.min(hi, Math.max(h0, h1));
        } else if (Math.abs(py * ux) > pad) continue;
        if (lo > hi) continue;
        var ri0 = clampI(Math.floor((lo + xs[a] - ox) / cell)), ri1 = clampI(Math.ceil((hi + xs[a] - ox) / cell));
        rows(j, j, ri0, ri1);
        for (var i = ri0; i <= ri1; i++) {
          var px = ox + i * cell - xs[a];
          // Only the band between them: past either end the member's own
          // reach is the edge.
          var t = px * ux + py * uy;
          if (t <= 0 || t >= L) continue;
          var r = ra + (rb - ra) * (t / L);
          var v = Math.abs(px * uy - py * ux) / r;
          var idx = j * nx + i;
          if (v < field[idx]) field[idx] = v;
        }
      }
      return true;
    }
    // Inside a filled triangle every vertex is well inside (its sides are
    // bridges at least a floor wide), so it only has to read as inside.
    function fill(a, b, c) {
      var ax = xs[a], ay = ys[a], bx = xs[b], by = ys[b], cx = xs[c], cy = ys[c];
      var area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (area === 0) return;
      var sg = area > 0 ? 1 : -1;
      var i0 = clampI(Math.floor((Math.min(ax, bx, cx) - ox) / cell)), i1 = clampI(Math.ceil((Math.max(ax, bx, cx) - ox) / cell));
      var j0 = clampJ(Math.floor((Math.min(ay, by, cy) - oy) / cell)), j1 = clampJ(Math.ceil((Math.max(ay, by, cy) - oy) / cell));
      rows(j0, j1, i0, i1);
      for (var j = j0; j <= j1; j++) {
        var py = oy + j * cell;
        for (var i = i0; i <= i1; i++) {
          var px = ox + i * cell;
          if (sg * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) < 0) continue;
          if (sg * ((cx - bx) * (py - by) - (cy - by) * (px - bx)) < 0) continue;
          if (sg * ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) < 0) continue;
          field[j * nx + i] = 0;
        }
      }
    }
    delaunay(xs, ys, n).forEach(function (t) {
      var real = t[0] < n && t[1] < n && t[2] < n;
      var e1 = t[0] < n && t[1] < n ? bridge(t[0], t[1]) : false;
      var e2 = t[1] < n && t[2] < n ? bridge(t[1], t[2]) : false;
      var e3 = t[2] < n && t[0] < n ? bridge(t[2], t[0]) : false;
      if (real && e1 && e2 && e3) fill(t[0], t[1], t[2]);
    });
  }

  // edt1d: the 1-D squared Euclidean distance transform of f (n values, 0
  // at a feature, EDT_INF elsewhere) into d: Felzenszwalb & Huttenlocher's
  // lower envelope of parabolas, linear time. v and z are scratch.
  var EDT_INF = 1e20;
  function edt1d(f, n, d, v, z) {
    var k = 0;
    v[0] = 0; z[0] = -EDT_INF; z[1] = EDT_INF;
    for (var q = 1; q < n; q++) {
      var s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = EDT_INF;
    }
    k = 0;
    for (q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      var dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
    }
  }

  // edt2d replaces a grid of 0 (feature) / EDT_INF by each vertex's squared
  // distance, in cells, to the nearest feature: columns, then rows. O(nx·ny).
  function edt2d(a, nx, ny) {
    var m = Math.max(nx, ny);
    var f = scratchBuf('edtF', Float64Array, m), d = scratchBuf('edtD', Float64Array, m);
    var v = scratchBuf('edtV', Int32Array, m), z = scratchBuf('edtZ', Float64Array, m + 1);
    var i, j;
    for (i = 0; i < nx; i++) {
      for (j = 0; j < ny; j++) f[j] = a[j * nx + i];
      edt1d(f, ny, d, v, z);
      for (j = 0; j < ny; j++) a[j * nx + i] = d[j];
    }
    for (j = 0; j < ny; j++) {
      var row = j * nx;
      for (i = 0; i < nx; i++) f[i] = a[row + i];
      edt1d(f, nx, d, v, z);
      for (i = 0; i < nx; i++) a[row + i] = d[i];
    }
  }

  // closeField fills, in place, every notch and bay of the inside that a disc
  // of diameter gapM cannot get into: a morphological closing (dilate by the
  // radius, then erode by it), two distance transforms. A closing that wide
  // needs no fine grid, so it runs on every k-th vertex (CLOSE_CELLS across
  // the radius, coarser still past CLOSE_MAX_VERTICES: a sprawling cluster
  // is seen zoomed out) and is interpolated back. It only adds: each vertex keeps
  // the smaller of its own value and the closing's. And it only counts what
  // is a coarse cell or more inside the closing, so the coarse grid never
  // pushes an edge the reach already draws; a filled notch's edge sits up
  // to a coarse cell short instead. The grid needs the radius of room round
  // the inside.
  var CLOSE_CELLS = 6;
  var CLOSE_MAX_VERTICES = 20000;
  function closeField(g, gapM) {
    var nx = g.nx, ny = g.ny, field = g.field;
    var k = Math.max(1, Math.round(gapM / 2 / CLOSE_CELLS / g.cell), Math.ceil(Math.sqrt(nx * ny / CLOSE_MAX_VERTICES)));
    var cx = Math.floor((nx - 1) / k) + 1, cy = Math.floor((ny - 1) / k) + 1, n = cx * cy;
    var a = scratchBuf('edtA', Float64Array, n);
    var i, j;
    for (j = 0; j < cy; j++) for (i = 0; i < cx; i++) a[j * cx + i] = field[(j * k) * nx + i * k] < 1 ? 0 : EDT_INF;
    edt2d(a, cx, cy);
    // a: squared distance to the inside, in coarse cells. Dilated: within
    // the radius of it. The second pass measures from every vertex outside
    // the dilation.
    var r = gapM / 2 / (g.cell * k), r2 = r * r;
    for (i = 0; i < n; i++) a[i] = a[i] <= r2 ? EDT_INF : 0;
    edt2d(a, cx, cy);
    // Closed, a coarse cell in: further than r + 1 from everything outside
    // the dilation, where (r + 1) / distance < 1.
    for (i = 0; i < n; i++) a[i] = a[i] <= 0 ? 3 : (a[i] >= EDT_INF ? 0 : Math.min(3, (r + 1) / Math.sqrt(a[i])));
    // Back onto the fine grid, bilinear between coarse vertices, one coarse
    // cell at a time. A cell whose corners are all outside the dilation adds
    // nothing, and most of a grid is that, so it is skipped; the rows traced
    // grow by the cells that were not.
    for (var bj = 0; bj < cy; bj++) {
      var bj1 = Math.min(cy - 1, bj + 1), fj0 = bj * k, fj1 = bj === cy - 1 ? ny - 1 : fj0 + k - 1;
      for (var bi = 0; bi < cx; bi++) {
        var bi1 = Math.min(cx - 1, bi + 1);
        var a00 = a[bj * cx + bi], a10 = a[bj * cx + bi1], a01 = a[bj1 * cx + bi], a11 = a[bj1 * cx + bi1];
        if (a00 >= 3 && a10 >= 3 && a01 >= 3 && a11 >= 3) continue;
        var fi0 = bi * k, fi1 = bi === cx - 1 ? nx - 1 : fi0 + k - 1;
        for (j = fj0; j <= fj1; j++) {
          var ty = (j - fj0) / k, l = a00 + (a01 - a00) * ty, rr = a10 + (a11 - a10) * ty;
          if (fi0 < g.rowLo[j]) g.rowLo[j] = fi0;
          if (fi1 > g.rowHi[j]) g.rowHi[j] = fi1;
          for (i = fi0; i <= fi1; i++) {
            var c = l + (rr - l) * ((i - fi0) / k), idx = j * nx + i;
            if (c < field[idx]) field[idx] = c;
          }
        }
      }
    }
  }

  // growField pushes the inside out by m metres, in place and round: every
  // inside vertex on the edge (one with a neighbour outside) stamps a disc
  // round it, each outside vertex in it taking (its distance - lead) / m,
  // so the edge is drawn m from the nearest of them. lead is how far past
  // the vertex, toward an outside neighbour, the traced edge crosses (the
  // same interpolation traceRings uses, the most of its neighbours): the
  // real edge is that much nearer, so the margin does not fall short, and
  // overshoots only off that direction, by under a cell. Inside vertices
  // keep their values. O(edge vertices x disc), not the grid: the inside of
  // a big cluster is most of it. Each row's traced span widens to the
  // vertices its stamps lowered.
  function growField(g, m) {
    var nx = g.nx, ny = g.ny, field = g.field, i, j;
    var r = m / g.cell, R = Math.ceil(r) + 1;
    var edge = [], i0 = nx, i1 = -1, j0 = ny, j1 = -1;
    function cross(fv, fo) { return fo >= 1 ? (1 - fv) / (fo - fv) : 0; }
    for (j = 0; j < ny; j++) {
      var row = j * nx, lo = Math.max(0, g.rowLo[j]), hi = Math.min(nx - 1, g.rowHi[j]);
      for (i = lo; i <= hi; i++) {
        var v = row + i, f = field[v];
        if (f >= 1) continue;
        if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; j1 = j;
        var lead = Math.max(i > 0 ? cross(f, field[v - 1]) : 0, i < nx - 1 ? cross(f, field[v + 1]) : 0,
          j > 0 ? cross(f, field[v - nx]) : 0, j < ny - 1 ? cross(f, field[v + nx]) : 0);
        if (lead > 0) edge.push(v, lead);
      }
    }
    if (i1 < 0) return;
    // Stamped values are below 1, so the inside is fixed before any stamp:
    // outside[v] marks the vertices a stamp may lower.
    var outside = scratchBuf('growOut', Uint8Array, nx * ny);
    i0 = Math.max(0, i0 - R - 1); i1 = Math.min(nx - 1, i1 + R + 1);
    j0 = Math.max(0, j0 - R - 1); j1 = Math.min(ny - 1, j1 + R + 1);
    for (j = j0; j <= j1; j++) for (i = i0; i <= i1; i++) outside[j * nx + i] = field[j * nx + i] >= 1 ? 1 : 0;
    var disc = [];
    for (var dj = -R; dj <= R; dj++) for (var di = -R; di <= R; di++) {
      var d = Math.sqrt(di * di + dj * dj);
      if (d > 0 && d <= R) disc.push(di, dj, d);
    }
    for (var e = 0; e < edge.length; e += 2) {
      var ei = edge[e] % nx, ej = (edge[e] - ei) / nx, el = edge[e + 1];
      for (var k = 0; k < disc.length; k += 3) {
        var ti = ei + disc[k], tj = ej + disc[k + 1];
        if (ti < 0 || ti >= nx || tj < 0 || tj >= ny) continue;
        var t = tj * nx + ti, val = (disc[k + 2] - el) / r;
        if (outside[t] && val < field[t]) {
          field[t] = val;
          if (ti < g.rowLo[tj]) g.rowLo[tj] = ti;
          if (ti > g.rowHi[tj]) g.rowHi[tj] = ti;
        }
      }
    }
  }

  function usableShapes(shapes) {
    return (shapes || []).filter(function (s) { return s && isFinite(s.lat) && isFinite(s.lon) && s.minExt > 0; });
  }

  // contourShapes returns the combined outline of reach shapes (see
  // shapeFor), unwrapped: the reach field wrapShapes starts from, traced as
  // it is, so tests can check the field itself. An array of rings, each
  // [[lat, lon], ...]; holes come out as rings of their own, which
  // Leaflet's evenodd fill draws as holes.
  function contourShapes(shapes) {
    var ok = usableShapes(shapes);
    if (!ok.length) return [];
    var out = [];
    clusters(ok, 0).forEach(function (c) { Array.prototype.push.apply(out, traceRings(clusterField(c))); });
    return out;
  }

  // wrapShapes returns the shrink-wrapped outline of reach shapes, the wrap
  // view: their combined reach, bridged between neighbours whose reach comes
  // within gapM of each other (bridgeField), then with every notch and bay
  // narrower than gapM filled (closeField): between one repeater's spokes as
  // much as between repeaters. Groups further apart than gapM are separate
  // areas. Neither step alone does it: a closing cannot join two small
  // blobs (a disc slips between them), and bridges leave a lone repeater's
  // notches open. marginM, when given, then grows the result that far all
  // round, corners rounded (growField).
  function wrapShapes(shapes, gapM, marginM) {
    gapM = gapM || WRAP_GAP_M;
    var ok = usableShapes(shapes);
    if (!ok.length) return [];
    var out = [];
    clusters(ok, gapM).forEach(function (c) {
      // Room for the closing and the margin to grow into (the closing stays
      // within the shapes' boxes); clusterField adds two cells, so the
      // grid's border stays outside both.
      var g = clusterField(c, Math.max(gapM / 2, marginM || 0));
      bridgeField(g, c, gapM);
      closeField(g, gapM);
      if (marginM > 0) growField(g, marginM);
      Array.prototype.push.apply(out, traceRings(g));
    });
    return out;
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
  // in a hole is outside, matching how Leaflet fills them. boxes, when
  // given, holds each ring's ringsBounds: a ring whose box does not hold
  // the point crosses the test's ray an even number of times, or not at
  // all, so it is skipped without changing the answer.
  function inRings(rings, lat, lon, boxes) {
    var inside = false;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      if (boxes) {
        var b = boxes[r];
        if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) continue;
      }
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
  // Leaflet map. opts: floorM, marginM (AREA_MARGIN_M), pulseMs, loadLinks (() => Promise of neighbor
  // graph edges), terrain (a terrain-reach.js provider: extentsFor and
  // status), loadAntennaHeights (() => Promise of { pubkey or prefix:
  // metres }, operator-set antenna heights), and setTimeout/clearTimeout/raf
  // for tests.
  //   setNodes(nodes)   new node list; recomputes changed scopes when visible
  //   setLinks(edges)   neighbor graph edges the reach shapes follow
  //   setVisible(bool)  adds or removes the layer; computes lazily
  //   setOnly(scope)    draw one scope ('' = all)
  //   setHidden(names)  scopes not to draw
  //   setView(view)     'hull' or 'detailed' (opts.view: the first)
  //   view()            the current view
  //   scopes()          [{ scope, colour, observed, configured, hidden }]
  //   onChange(fn)      called after each render; returns an unsubscribe
  //   pulse(scope)      briefly highlight one scope (live page)
  //   destroy()         drop listeners and pending work
  function createOverlay(L, map, opts) {
    opts = opts || {};
    var floorM = opts.floorM || DEFAULT_FLOOR_M;
    var marginM = opts.marginM != null ? opts.marginM : AREA_MARGIN_M;
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
    var view = VIEWS.indexOf(opts.view) >= 0 ? opts.view : VIEWS[0];
    var cache = new Map(); // view|scope|kind → { sig, rings }; every view kept, so switching back is free
    var drawn = new Map(); // scope → [polygon]
    var hits = [];         // [{ scope, polys, rings, boxes, bounds, text }] for hover
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
      var key = view + '|' + scope + '|' + kind;
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
      var r;
      if (view === 'detailed') r = wrapShapes(entries.map(function (e) { return e.shape; }), WRAP_GAP_M, marginM);
      else {
        var ring = roundOut(hullOfEdges(entries.map(function (e) { return e.edge; })), marginM);
        r = ring.length ? [ring] : [];
      }
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
      var boxes = r.map(function (ring) { return ringsBounds([ring]); });
      hits.push({ scope: scope, polys: [poly], rings: r, boxes: boxes, bounds: ringsBounds(r), text: text });
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
        VIEWS.forEach(function (v) {
          if (g.observed.length) live.add(v + '|' + scope + '|observed');
          if (g.configuredOnly.length) live.add(v + '|' + scope + '|configured');
        });
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
      var info = { terrain: opts.terrain ? opts.terrain.status() : 'off', view: view };
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
        if (inRings(h.rings, lat, lon, h.boxes)) found.push(h);
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
      setView: function (v) {
        if (VIEWS.indexOf(v) < 0 || v === view) return;
        view = v;
        // The popup lists the scopes under a click on the old outlines.
        if (popupOpen()) map.closePopup(popup);
        render();
      },
      view: function () { return view; },
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

  // viewFromHash reads ?contoursView=; null when absent or not a view.
  function viewFromHash(hash) {
    var v = hashParam(hash, 'contoursView');
    return VIEWS.indexOf(v) >= 0 ? v : null;
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

  // What an area is, per view.
  var AREA_NOTE = {
    hull: 'Each area spans the farthest reach of its repeaters, at least ' + ((DEFAULT_FLOOR_M + AREA_MARGIN_M) / 1000) + ' km round each.',
    detailed: 'Each area wraps its repeaters\' reach, filling gaps narrower than ' + (WRAP_GAP_M / 1000) + ' km and leaving wider ones, at least ' + ((DEFAULT_FLOOR_M + AREA_MARGIN_M) / 1000) + ' km round each.',
  };
  var TERRAIN_NOTE = 'A repeater\'s range comes from its two-way links, trimmed by line of sight over terrain and stretched to proven links. ' +
    'Antenna heights are the operator\'s where set; otherwise 10 m, raised where a repeater\'s links need more (click an outline to see them). ' +
    'Terrain: AWS Terrain Tiles (Mapzen; SRTM, USGS 3DEP and others), bare earth: buildings and trees are not in it.';
  var NO_TERRAIN_NOTE = 'Terrain unavailable: a repeater\'s range comes from its two-way links, stretched to proven links, with no terrain trimming.';

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
      '<div class="mc-scope-hint">' + AREA_NOTE[(info && info.view) || VIEWS[0]] + ' ' +
      (info && info.terrain === 'unavailable' ? NO_TERRAIN_NOTE : TERRAIN_NOTE) + ' Click an outline to list its repeaters.</div>';
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

  // ── View picker ──────────────────────────────────────────────────────────

  var VIEW_LABEL = { hull: 'Convex Hull', detailed: 'Detailed' };
  var VIEW_TITLE = {
    hull: 'One rubber band round each scope\'s outermost reach: roughly where the region is',
    detailed: 'Hugs each scope\'s reach, filling bays and gaps narrower than ' + (WRAP_GAP_M / 1000) + ' km; separate groups stay separate',
  };

  // mountViewPicker renders the area view buttons into el, shown while the
  // overlay is. The URL wins, then the stored choice; a change is stored and
  // written to the URL (the default view leaves the URL clean). The map and
  // live pages share the stored choice and the URL key. opts: storage
  // (defaults to localStorage), titleHtml (a heading shown above it, with
  // it). Returns an unsubscribe.
  function mountViewPicker(el, overlay, opts) {
    opts = opts || {};
    var store = opts.storage || localStorage;
    var start = viewFromHash(location.hash);
    if (!start) { try { start = store.getItem(VIEW_KEY); } catch (e) { start = null; } }
    overlay.setView(VIEWS.indexOf(start) >= 0 ? start : VIEWS[0]);
    var shown = null;
    function paint(_, visible) {
      el.hidden = !visible;
      var key = visible ? overlay.view() : '';
      if (key === shown) return;
      shown = key;
      el.innerHTML = !visible ? '' : (opts.titleHtml || '') +
        '<span class="mc-scope-view-label" id="mcScopeViewLabel">Area shape</span>' +
        '<div class="filter-group" role="group" aria-labelledby="mcScopeViewLabel">' + VIEWS.map(function (v) {
          var on = v === overlay.view();
          return '<button type="button" class="btn' + (on ? ' active' : '') + '" data-view="' + v + '" aria-pressed="' + on + '" title="' + VIEW_TITLE[v] + '">' + VIEW_LABEL[v] + '</button>';
        }).join('') + '</div>';
    }
    el.addEventListener('click', function (e) {
      var t = e.target, v = t && t.getAttribute && t.getAttribute('data-view');
      if (VIEWS.indexOf(v) < 0) return;
      overlay.setView(v);
      try { store.setItem(VIEW_KEY, v); } catch (err) { /* private mode */ }
      writeHash({ contoursView: v === VIEWS[0] ? null : v });
      paint(null, overlay.isVisible());
    });
    var off = overlay.onChange(paint);
    paint(null, overlay.isVisible());
    return off;
  }

  window.ScopeContours = {
    hashFlag: hashFlag,
    hiddenFromHash: hiddenFromHash,
    viewFromHash: viewFromHash,
    views: VIEWS.slice(),
    wrapGapM: WRAP_GAP_M,
    areaMarginM: AREA_MARGIN_M,
    contourShapes: contourShapes,
    wrapShapes: wrapShapes,
    mountViewPicker: mountViewPicker,
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
