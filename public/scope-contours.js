/* Region scope reach contours for the map and live pages.

   For each MeshCore region scope, outline the area the nodes that handle it
   are proven to reach, merged into one shape per cluster. Two kinds:

   - observed: nodes whose full pubkey appears in the path of traffic for the
     scope (transported_scopes, #1751/#1902). Drawn solid.
   - configured only: nodes configured for the region (configuredScopes: its
     default scope, the regions an observer reported it allows, or its own
     declared list) but not seen carrying it. Drawn dashed, because
     configuration is not evidence of reach.

   A node's reach, in 72 directions (reachFor):
     max( min(R, terrain cut), link lobe, 250 m floor )
   - R, how far it regularly reaches, comes from its proven two-way links in
     the neighbor graph (linkReach): the 75th percentile of their distances
     × 1.1, 1-20 km; 1 km for a node with no links.
   - The terrain cut is where line of sight over elevation data ends in that
     direction (terrain-reach.js). Real radios reach roughly a circle, trimmed
     where a ridge or valley shadows the ground.
   - Each proven link still stretches its own bearing out to it, tapering over
     ±11.25°, so evidence always beats the model.
   Interpolating between the 72 directions keeps the shape smooth.

   The outline is a marching-squares contour of a field: within each cluster
   of nodes, every grid vertex holds min over nodes of distance / reach in that
   direction, and the contour is drawn at 1. Results are cached per scope and
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

  // No reach is ever drawn closer than this, whatever the terrain says.
  var DEFAULT_FLOOR_M = 250;
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
  // The grid never gets finer than this, however small the floor.
  var MIN_CELL_M = 150;
  var PANE = 'mcScopeContoursPane';
  // Under overlayPane (400) and markerPane (600): outlines never cover a
  // route line or a node marker.
  var PANE_Z = 350;
  var PALETTE_SIZE = 8;
  var M_PER_DEG = 111320;
  // A cluster's grid is capped at this many vertices. Past it the cell grows,
  // so a scope spread over a large area costs the same as a compact one.
  var MAX_VERTICES = 100000;
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

  // sectorOf maps a bearing (radians, 0 = north, clockwise) to the sector
  // whose centre is nearest: sector i is centred on i * 360/SECTORS degrees.
  function sectorOf(bearing) {
    var s = Math.round(bearing / SECTOR_RAD) % SECTORS;
    return s < 0 ? s + SECTORS : s;
  }

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
  // per-sector reach (ext; null for a plain circle of floorM). box is the
  // shape's extent in metres west/east/south/north of the node, so a lobe
  // to the east costs a strip, not a square around the node.
  function shapeFor(n, ext, floorM) {
    var p = position(n);
    var e = new Float64Array(SECTORS);
    var max = floorM, min = Infinity;
    for (var i = 0; i < SECTORS; i++) {
      e[i] = ext && ext[i] > floorM ? ext[i] : floorM;
      if (e[i] > max) max = e[i];
      if (e[i] < min) min = e[i];
    }
    var shape = { lat: p[0], lon: p[1], ext: e, maxExt: max, minExt: min, uniform: max === min };
    if (shape.uniform) { shape.box = [-max, max, -max, max]; return shape; }
    shape.box = shapeBox(shape);
    // near[i]: the most any bearing within a sector of interval i (between
    // centres i and i+1) can reach. A vertex at least that far out is outside
    // even after the field fill's half-cell widening, while that widening
    // spans no more than a sector, so the fill rates it d / near without a
    // lookup.
    var near = new Float64Array(SECTORS);
    for (var k = 0; k < SECTORS; k++) {
      near[k] = Math.max(e[(k + SECTORS - 1) % SECTORS], e[k], e[(k + 1) % SECTORS], e[(k + 2) % SECTORS]);
    }
    shape.near = near;
    return shape;
  }

  // shapeBox samples the boundary at 2 points per sector. Between samples the
  // boundary can bulge by about 0.1% of the reach, which the 2-cell margin
  // the field fill adds covers.
  function shapeBox(shape) {
    var b = [0, 0, 0, 0], n = SECTORS * 2;
    for (var k = 0; k < n; k++) {
      var t = (k / n) * 2 * Math.PI, r = reachAt(shape, t);
      var x = r * Math.sin(t), y = r * Math.cos(t);
      if (x < b[0]) b[0] = x; if (x > b[1]) b[1] = x;
      if (y < b[2]) b[2] = y; if (y > b[3]) b[3] = y;
    }
    return b;
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

  // clusters splits shapes into groups that can touch (centres within the sum
  // of their longest reaches), so each group gets its own compact grid and
  // projection. Spatial hash with cells at least twice the longest reach:
  // only the 3x3 neighbourhood is checked, so this is linear in the count.
  function clusters(shapes) {
    var maxAbsLat = 0, maxExt = 0;
    shapes.forEach(function (s) { maxAbsLat = Math.max(maxAbsLat, Math.abs(s.lat)); maxExt = Math.max(maxExt, s.maxExt); });
    var reach = 2 * maxExt;
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
            var touch = p.maxExt + q.maxExt;
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

  // Marching-squares segments per cell case, as pairs of cell edges
  // (0 bottom, 1 right, 2 top, 3 left). Corner bits: 1 bottom-left,
  // 2 bottom-right, 4 top-right, 8 top-left. Cases 5 and 10 are saddles,
  // resolved by the cell centre below.
  var CASES = [
    [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], null, [[0, 2]], [[3, 2]],
    [[2, 3]], [[0, 2]], null, [[1, 2]], [[3, 1]], [[0, 1]], [[3, 0]], [],
  ];

  // Scratch buffers shared by every clusterRings call, grown to the largest
  // grid seen and never past MAX_VERTICES (the cell grows instead), so a
  // rebuild allocates nothing per cluster. The edge index is not cleared
  // between clusters: an entry counts only if its stamp is this call's.
  var scratch = { field: null, first: null, second: null, stamp: null, rowLo: null, rowHi: null, gen: 0 };
  function scratchBuf(name, Ctor, n) {
    if (!scratch[name] || scratch[name].length < n) scratch[name] = new Ctor(n);
    return scratch[name];
  }

  // Saddle resolutions: A cuts off bottom-right and top-left, B bottom-left
  // and top-right.
  var SADDLE_A = [[0, 1], [2, 3]], SADDLE_B = [[3, 0], [1, 2]];

  // clusterRings traces the reach contour around one cluster of shapes.
  function clusterRings(shapes) {
    var lat0 = 0, lon0 = 0, minExt = Infinity, maxExt = 0;
    shapes.forEach(function (s) { lat0 += s.lat; lon0 += s.lon; if (s.minExt < minExt) minExt = s.minExt; if (s.maxExt > maxExt) maxExt = s.maxExt; });
    lat0 /= shapes.length; lon0 /= shapes.length;
    var kx = M_PER_DEG * Math.cos(lat0 * Math.PI / 180), ky = M_PER_DEG;
    var xy = shapes.map(function (s) { return [(s.lon - lon0) * kx, (s.lat - lat0) * ky]; });

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    xy.forEach(function (p, k) {
      var b = shapes[k].box;
      if (p[0] + b[0] < minX) minX = p[0] + b[0]; if (p[0] + b[1] > maxX) maxX = p[0] + b[1];
      if (p[1] + b[2] < minY) minY = p[1] + b[2]; if (p[1] + b[3] > maxY) maxY = p[1] + b[3];
    });
    // The smallest reach over 2.5 still traces a floor circle within 5% (the
    // contour is interpolated, not stepped); finer cells cost the square. A
    // cluster holding a big shape needs no finer than 1/40 of it: a 20 km
    // reach is still ~80 cells across, at zooms where a pixel is 60-150 m.
    // The vertex cap coarsens it for a sprawling cluster.
    var cell = Math.max(minExt / 2.5, maxExt / 40, MIN_CELL_M);
    var span = function (c) { return { nx: Math.ceil((maxX - minX + 4 * c) / c) + 1, ny: Math.ceil((maxY - minY + 4 * c) / c) + 1 }; };
    var dims = span(cell);
    if (dims.nx * dims.ny > MAX_VERTICES) {
      cell *= Math.sqrt((dims.nx * dims.ny) / MAX_VERTICES);
      dims = span(cell);
    }
    var nx = dims.nx, ny = dims.ny;
    var ox = minX - 2 * cell, oy = minY - 2 * cell;

    // Field: distance / reach in that direction, inside where < 1. Each shape
    // fills only its own box plus 2 cells: every vertex next to the contour
    // lies within that of the shape that puts it there, so the rest stay
    // "far". A uniform shape needs no bearing, and neither does a vertex well
    // inside the floor: its value only has to read as inside, since no
    // vertex a cell from it can be outside.
    var far = 3;
    var field = scratchBuf('field', Float64Array, nx * ny);
    field.fill(far, 0, nx * ny);
    var pad = 2 * cell;
    // rowLo/rowHi: the columns each row's fill touched. A cluster's grid is
    // its bounding box, mostly empty when the shapes chain across it, and
    // outside these spans every vertex is far, so the marching pass below
    // only walks the spans.
    var rowLo = scratchBuf('rowLo', Int32Array, ny), rowHi = scratchBuf('rowHi', Int32Array, ny);
    rowLo.fill(nx, 0, ny); rowHi.fill(-1, 0, ny);
    xy.forEach(function (p, k) {
      var s = shapes[k], b = s.box;
      var i0 = Math.max(0, Math.floor((p[0] + b[0] - pad - ox) / cell)), i1 = Math.min(nx - 1, Math.ceil((p[0] + b[1] + pad - ox) / cell));
      var j0 = Math.max(0, Math.floor((p[1] + b[2] - pad - oy) / cell)), j1 = Math.min(ny - 1, Math.ceil((p[1] + b[3] + pad - oy) / cell));
      var inv = 1 / s.minExt, lim = s.maxExt + pad, half = cell / 2;
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
            // Outside for certain, once the half-cell widening below spans
            // no more than a sector. d / nr is a lower bound on its value,
            // still above 1, and exact where the edge is the floor circle;
            // anywhere else such a vertex is a cell or more from the edge.
            if (d >= nr && d * SECTOR_RAD >= half) r = d / nr;
            else {
            // The reach is the most within half a cell either side of the
            // bearing. Near the node a lobe is only a few sectors wide, about
            // a cell: without this widening the grid misses its base and the
            // lobe comes loose from the node.
            var del = half / d;
            var e0 = reachAt(s, bb), e1 = reachAt(s, bb + del), e2 = reachAt(s, bb - del);
            r = d / (e0 > e1 ? (e0 > e2 ? e0 : e2) : (e1 > e2 ? e1 : e2));
            }
          }
          var idx = j * nx + i;
          if (r < field[idx]) field[idx] = r;
        }
      }
    });

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
        rings.push(ring.map(function (p) { return [lat0 + p[1] / ky, lon0 + p[0] / kx]; }));
      }
    }
    return rings;
  }

  // contourShapes returns the merged outline of reach shapes (see shapeFor):
  // an array of rings, each [[lat, lon], ...]. Holes come out as rings of
  // their own; Leaflet's evenodd fill draws them as holes.
  function contourShapes(shapes) {
    var ok = (shapes || []).filter(function (s) { return s && isFinite(s.lat) && isFinite(s.lon) && s.minExt > 0; });
    if (!ok.length) return [];
    var out = [];
    clusters(ok).forEach(function (c) { Array.prototype.push.apply(out, clusterRings(c)); });
    return out;
  }

  // contourRings is the circle case: every point reaches radiusM all round.
  function contourRings(points, radiusM) {
    if (!(radiusM > 0)) return [];
    var shapes = [];
    (points || []).forEach(function (p) { if (position(p)) shapes.push(shapeFor(p, null, radiusM)); });
    return contourShapes(shapes);
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

  function shapeKey(n, s) {
    var head = n.public_key + '@' + s.lat + ',' + s.lon + ':';
    return s.uniform ? head + 'u' + Math.round(s.ext[0]) : head + Array.prototype.map.call(s.ext, Math.round).join(',');
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
    var shapes = new Map(); // pubkey → { shape, key }, rebuilt with reach
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
        e = { shape: s, key: shapeKey(n, s) };
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
      var sig = entries.map(function (e) { return e.key; }).sort().join('|');
      var hit = cache.get(key);
      if (hit && hit.sig === sig) return hit.rings;
      computed++;
      var r = contourShapes(entries.map(function (e) { return e.shape; }));
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

  var TERRAIN_NOTE = 'Each repeater\'s range comes from its two-way links, trimmed by line of sight over terrain and stretched to proven links. ' +
    'Antenna heights are the operator\'s where set; otherwise 10 m, raised where a repeater\'s links need more (click an outline to see them). ' +
    'Terrain: AWS Terrain Tiles (Mapzen; SRTM, USGS 3DEP and others), bare earth: buildings and trees are not in it.';
  var NO_TERRAIN_NOTE = 'Terrain unavailable: outlines show each repeater\'s range from its two-way links, stretched to proven links, with no terrain trimming.';

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
    contourShapes: contourShapes,
    contourRings: contourRings,
    inRings: inRings,
    colorIndex: colorIndex,
    createPulser: createPulser,
    createOverlay: createOverlay,
    sectors: SECTORS,
    mountScopeList: mountScopeList,
  };
})();
