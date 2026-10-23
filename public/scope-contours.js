/* Region scope reach contours for the map and live pages.

   For each MeshCore region scope, outline the area within a fixed radius of
   the nodes that handle it, merged into one shape per cluster. Two kinds:

   - observed: nodes whose full pubkey appears in the path of traffic for the
     scope (transported_scopes, #1751/#1902). Drawn solid.
   - declared only: nodes that list the region (declared_regions) but have not
     been seen carrying it. Drawn dashed, because a declaration is
     configuration, not evidence of reach.

   Everything is computed from the node list the page already loaded, so the
   overlay makes no request of its own. The outline is a marching-squares
   contour of a distance field: within each cluster of nodes, every grid
   vertex holds its distance to the nearest node, and the contour is drawn at
   the radius. Results are cached per scope and recomputed only when that
   scope's members or their positions change.

   The radius (8 km, matching coverage.nyme.sh) and pulse duration are fixed
   for now; exposing them in the customizer is a follow-up. */
(function () {
  'use strict';

  var DEFAULT_RADIUS_M = 8000;
  var DEFAULT_PULSE_MS = 1500;
  var PANE = 'mcScopeContoursPane';
  // Under overlayPane (400) and markerPane (600): outlines never cover a
  // route line or a node marker.
  var PANE_Z = 350;
  var PALETTE_SIZE = 8;
  var M_PER_DEG = 111320;
  // A cluster's grid is capped at this many vertices. Past it the cell grows,
  // so a scope spread over a large area costs the same as a compact one.
  var MAX_VERTICES = 250000;

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

  // groupNodesByScope returns Map scope → { observed: [], declaredOnly: [] }.
  // A node seen carrying a scope is observed even if it also declares it.
  // Unplaced nodes are left out: they cannot contribute to an outline.
  function groupNodesByScope(nodes) {
    var groups = new Map();
    function group(s) {
      var g = groups.get(s);
      if (!g) { g = { observed: [], declaredOnly: [] }; groups.set(s, g); }
      return g;
    }
    (nodes || []).forEach(function (n) {
      if (!position(n)) return;
      var observed = new Set();
      (Array.isArray(n.transported_scopes) ? n.transported_scopes : []).forEach(function (r) {
        r = normRegion(r);
        if (r && !observed.has(r)) { observed.add(r); group(r).observed.push(n); }
      });
      var declared = new Set();
      (Array.isArray(n.declared_regions) ? n.declared_regions : []).forEach(function (r) {
        r = normRegion(r);
        if (r && !observed.has(r) && !declared.has(r)) { declared.add(r); group(r).declaredOnly.push(n); }
      });
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

  // ── Geometry ─────────────────────────────────────────────────────────────

  // clusters splits points into groups whose discs can touch (within 2R of
  // each other), so each group gets its own compact grid and projection.
  // Spatial hash with cells at least 2R wide: only the 3x3 neighbourhood is
  // checked, so this is linear in the point count.
  function clusters(pts, radiusM) {
    var reach = 2 * radiusM;
    var maxAbsLat = 0;
    pts.forEach(function (p) { maxAbsLat = Math.max(maxAbsLat, Math.abs(p[0])); });
    var latCell = reach / M_PER_DEG;
    // The smallest cos in the set makes every cell at least 2R wide wherever
    // a point is, so no pair within reach lands two cells apart.
    var lonCell = Math.min(360, reach / (M_PER_DEG * Math.max(0.01, Math.cos(maxAbsLat * Math.PI / 180))));
    var parent = pts.map(function (_, i) { return i; });
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    var cells = new Map();
    var keyOf = function (cy, cx) { return cy + ',' + cx; };
    pts.forEach(function (p, i) {
      var cy = Math.floor(p[0] / latCell), cx = Math.floor(p[1] / lonCell);
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var bucket = cells.get(keyOf(cy + dy, cx + dx));
          if (!bucket) continue;
          for (var k = 0; k < bucket.length; k++) {
            var j = bucket[k], q = pts[j];
            var cos = Math.cos(((p[0] + q[0]) / 2) * Math.PI / 180);
            var ey = (p[0] - q[0]) * M_PER_DEG, ex = (p[1] - q[1]) * M_PER_DEG * cos;
            if (ey * ey + ex * ex <= reach * reach) parent[find(i)] = find(j);
          }
        }
      }
      var own = keyOf(cy, cx);
      if (!cells.has(own)) cells.set(own, []);
      cells.get(own).push(i);
    });
    var byRoot = new Map();
    pts.forEach(function (p, i) {
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

  // clusterRings traces the radius contour around one cluster of points.
  function clusterRings(pts, radiusM) {
    var lat0 = 0, lon0 = 0;
    pts.forEach(function (p) { lat0 += p[0]; lon0 += p[1]; });
    lat0 /= pts.length; lon0 /= pts.length;
    var kx = M_PER_DEG * Math.cos(lat0 * Math.PI / 180), ky = M_PER_DEG;
    var xy = pts.map(function (p) { return [(p[1] - lon0) * kx, (p[0] - lat0) * ky]; });

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    xy.forEach(function (p) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    });
    var cell = radiusM / 4;
    var span = function (c) { return { nx: Math.ceil((maxX - minX + 2 * (radiusM + 2 * c)) / c) + 1, ny: Math.ceil((maxY - minY + 2 * (radiusM + 2 * c)) / c) + 1 }; };
    var dims = span(cell);
    if (dims.nx * dims.ny > MAX_VERTICES) {
      cell *= Math.sqrt((dims.nx * dims.ny) / MAX_VERTICES);
      dims = span(cell);
    }
    var nx = dims.nx, ny = dims.ny;
    var ox = minX - radiusM - 2 * cell, oy = minY - radiusM - 2 * cell;

    // Distance field, squared: a square root per vertex was most of the
    // cost, and only the few vertices on the contour need the distance
    // itself (edgePoint, the saddle centre). Each point fills only its own
    // square of half-width R + 2 cells: every vertex next to the contour is
    // within that of the point that puts it there, so the rest stay "far".
    var r2 = radiusM * radiusM;
    var far = 9 * r2;
    var field = new Float64Array(nx * ny).fill(far);
    var reach = radiusM + 2 * cell;
    xy.forEach(function (p) {
      var i0 = Math.max(0, Math.floor((p[0] - reach - ox) / cell)), i1 = Math.min(nx - 1, Math.ceil((p[0] + reach - ox) / cell));
      var j0 = Math.max(0, Math.floor((p[1] - reach - oy) / cell)), j1 = Math.min(ny - 1, Math.ceil((p[1] + reach - oy) / cell));
      for (var j = j0; j <= j1; j++) {
        var dy = oy + j * cell - p[1];
        for (var i = i0; i <= i1; i++) {
          var dx = ox + i * cell - p[0];
          var d = dx * dx + dy * dy;
          var idx = j * nx + i;
          if (d < field[idx]) field[idx] = d;
        }
      }
    });

    // Edge ids: horizontal edge from vertex (i,j) to (i+1,j) is 2*(j*nx+i),
    // vertical edge from (i,j) to (i,j+1) is 2*(j*nx+i)+1. Neighbouring cells
    // share an edge id, which is what joins their segments into rings.
    function edgePoint(e) {
      var v = e >> 1, i = v % nx, j = (v - i) / nx;
      var a = Math.sqrt(field[v]), b, bx = i, by = j;
      if (e & 1) { b = Math.sqrt(field[v + nx]); by = j + 1; } else { b = Math.sqrt(field[v + 1]); bx = i + 1; }
      var t = (radiusM - a) / (b - a);
      return [ox + (i + (bx - i) * t) * cell, oy + (j + (by - j) * t) * cell];
    }
    // segA/segB: the two endpoint edges of each segment. Every contour edge
    // belongs to exactly two segments, so first/second, indexed by edge id,
    // find a segment's neighbours without a Map or an array per edge.
    var segA = [], segB = [];
    var first = new Int32Array(2 * nx * ny).fill(-1), second = new Int32Array(2 * nx * ny).fill(-1);
    function link(e, s) { if (first[e] < 0) first[e] = s; else second[e] = s; }
    function addSeg(e1, e2) {
      var s = segA.length;
      segA.push(e1); segB.push(e2);
      link(e1, s); link(e2, s);
    }
    for (var j = 0; j < ny - 1; j++) {
      for (var i = 0; i < nx - 1; i++) {
        var v = j * nx + i;
        var bl = field[v], br = field[v + 1], tr = field[v + nx + 1], tl = field[v + nx];
        var c = (bl < r2 ? 1 : 0) | (br < r2 ? 2 : 0) | (tr < r2 ? 4 : 0) | (tl < r2 ? 8 : 0);
        if (c === 0 || c === 15) continue;
        var edges = [2 * v, 2 * (v + 1) + 1, 2 * (v + nx), 2 * v + 1];
        var pairs = CASES[c];
        if (!pairs) {
          var centreIn = (Math.sqrt(bl) + Math.sqrt(br) + Math.sqrt(tr) + Math.sqrt(tl)) / 4 < radiusM;
          if (c === 5) pairs = centreIn ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
          else pairs = centreIn ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
        }
        for (var k = 0; k < pairs.length; k++) addSeg(edges[pairs[k][0]], edges[pairs[k][1]]);
      }
    }

    // Join segments into closed rings. The grid border is outside every
    // disc, so each contour edge is shared by exactly two segments.
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

  // contourRings returns the outline of every point's radius disc, merged:
  // an array of rings, each [[lat, lon], ...]. Holes come out as rings of
  // their own; Leaflet's evenodd fill draws them as holes.
  function contourRings(points, radiusM) {
    if (!(radiusM > 0)) return [];
    var pts = [];
    (points || []).forEach(function (p) { var ll = position(p); if (ll) pts.push(ll); });
    if (!pts.length) return [];
    var out = [];
    clusters(pts, radiusM).forEach(function (c) {
      Array.prototype.push.apply(out, clusterRings(c, radiusM));
    });
    return out;
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

  function signature(members) {
    return members.map(function (n) { var p = position(n); return n.public_key + '@' + p[0] + ',' + p[1]; }).sort().join('|');
  }

  function plural(n) { return n + (n === 1 ? ' node' : ' nodes'); }

  // createOverlay owns the layer, the cache and the pulses for one Leaflet
  // map. opts: radiusM, pulseMs, and setTimeout/clearTimeout for tests.
  //   setNodes(nodes)  new node list; recomputes changed scopes when visible
  //   setVisible(bool) adds or removes the layer; computes lazily
  //   setOnly(scope)   draw one scope ('' = all)
  //   pulse(scope)     briefly highlight one scope (live page)
  //   destroy()        cancel pending pulses
  function createOverlay(L, map, opts) {
    opts = opts || {};
    var radiusM = opts.radiusM || DEFAULT_RADIUS_M;
    if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = String(PANE_Z);
    // Its own SVG renderer: the live map prefers canvas, which would ignore
    // the className the colours and pulse are styled through.
    var renderer = L.svg({ pane: PANE });
    var layer = L.layerGroup();
    var nodes = [];
    var visible = false;
    var only = '';
    var cache = new Map(); // scope|kind → { sig, rings }
    var drawn = new Map(); // scope → [polygon]
    var computed = 0;
    var pulser = createPulser({
      durationMs: opts.pulseMs, setTimeout: opts.setTimeout, clearTimeout: opts.clearTimeout,
      onStart: function (s) { setPulsing(s, true); },
      onEnd: function (s) { setPulsing(s, false); },
    });

    function setPulsing(scope, on) {
      (drawn.get(scope) || []).forEach(function (p) {
        var el = p.getElement && p.getElement();
        if (el) el.classList[on ? 'add' : 'remove']('is-pulsing');
      });
    }

    function rings(scope, kind, members) {
      var key = scope + '|' + kind;
      var sig = signature(members);
      var hit = cache.get(key);
      if (hit && hit.sig === sig) return hit.rings;
      computed++;
      var r = contourRings(members, radiusM);
      cache.set(key, { sig: sig, rings: r });
      return r;
    }

    function render() {
      layer.clearLayers();
      drawn = new Map();
      if (!visible) return;
      var groups = groupNodesByScope(nodes);
      var live = new Set();
      var want = normRegion(only);
      groups.forEach(function (g, scope) {
        [['observed', g.observed], ['declared', g.declaredOnly]].forEach(function (kv) {
          if (kv[1].length) live.add(scope + '|' + kv[0]);
        });
        if (want && scope !== want) return;
        var name = '#' + escapeHtml(scope);
        var colour = ' mc-reach-c' + colorIndex(scope);
        var polys = [];
        if (g.observed.length) {
          var ro = rings(scope, 'observed', g.observed);
          if (ro.length) {
            polys.push(L.polygon(ro, { pane: PANE, renderer: renderer, className: 'mc-scope-area mc-scope-area-observed' + colour })
              .bindTooltip(name + ' · carried by ' + plural(g.observed.length), { sticky: true }));
          }
        }
        if (g.declaredOnly.length) {
          var rd = rings(scope, 'declared', g.declaredOnly);
          if (rd.length) {
            polys.push(L.polygon(rd, { pane: PANE, renderer: renderer, className: 'mc-scope-area mc-scope-area-declared' + colour })
              .bindTooltip(name + ' · declared by ' + plural(g.declaredOnly.length) + ', not yet seen carrying it', { sticky: true }));
          }
        }
        polys.forEach(function (p) { layer.addLayer(p); });
        if (polys.length) drawn.set(scope, polys);
      });
      // Bounded by the scopes in the current node list: a scope that left it
      // leaves the cache too.
      Array.from(cache.keys()).forEach(function (k) { if (!live.has(k)) cache.delete(k); });
    }

    return {
      layer: layer,
      setNodes: function (list) { nodes = list || []; render(); },
      setVisible: function (v) {
        visible = !!v;
        if (visible) { if (!map.hasLayer(layer)) layer.addTo(map); }
        else { pulser.cancelAll(); if (map.hasLayer(layer)) map.removeLayer(layer); }
        render();
      },
      setOnly: function (scope) { only = scope || ''; render(); },
      pulse: function (scope) { if (visible && drawn.has(normRegion(scope))) pulser.pulse(scope); },
      destroy: function () { pulser.cancelAll(); },
      stats: function () { return { computed: computed, cached: cache.size }; },
    };
  }

  // ── Deep link ────────────────────────────────────────────────────────────

  // hashFlag reads ?contours= from a hash: true for '1', false for '0', null
  // when absent, so the caller falls back to its stored preference.
  function hashFlag(hash) {
    var qs = String(hash || '').split('?')[1] || '';
    var v = new URLSearchParams(qs).get('contours');
    return v === '1' ? true : (v === '0' ? false : null);
  }

  // writeHashFlag puts the toggle in the URL without adding a history entry,
  // so a shared link opens with the overlay as the sender had it.
  function writeHashFlag(on) {
    if (!window.URLState) return;
    var h = window.URLState.updateHashParams({ contours: on ? '1' : null }, location.hash);
    if (h !== location.hash) history.replaceState(null, '', h);
  }

  window.ScopeContours = {
    hashFlag: hashFlag,
    writeHashFlag: writeHashFlag,
    normRegion: normRegion,
    nodeRegionEvidence: nodeRegionEvidence,
    groupNodesByScope: groupNodesByScope,
    contourRings: contourRings,
    colorIndex: colorIndex,
    createPulser: createPulser,
    createOverlay: createOverlay,
  };
})();
